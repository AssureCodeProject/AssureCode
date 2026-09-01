/**
 * Freelancer assignment accept/reject: POST /api/contracts/:id/assign,
 * .../assignment/accept, .../assignment/reject, .../assignment-details,
 * .../assignment-pdf.
 *
 * Uses real per-user JWTs from /auth/register (not serviceAuthHeaders) for
 * everything that exercises freelancerContractParty — a service caller
 * bypasses that guard entirely (see rbac.ts's isServiceCaller check), so
 * asserting 403 against an unrelated freelancer requires an actual second
 * freelancer identity, not the machine-caller bypass the other route suites
 * in this directory use.
 *
 * settlement-worker (a separate process/workspace) is what actually reacts
 * to ASSIGNMENT_ACCEPTED/REJECTED — client notifications and repo
 * provisioning are its test suite's concern
 * (repo-provisioning-reconcile.test.ts). What this suite can and does assert
 * from the gateway side: the DB state transition is correct and concurrency-
 * safe, and the outbox row the worker would consume was actually written.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import server from '../src/server.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — assignment accept/reject', 'a running PostgreSQL on DATABASE_URL');

interface Registered {
  token: string;
  userId: string;
}

async function register(role: 'client' | 'freelancer', tag: string): Promise<Registered> {
  const res = await server.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, password: 'a-strong-password-1', role },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token, userId: body.user.userId };
}

function auth(t: Registered): Record<string, string> {
  return { authorization: `Bearer ${t.token}` };
}

describe.skipIf(!PG_UP)('assignment accept/reject', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  let client: Registered;
  let freelancer: Registered;
  let otherFreelancer: Registered;
  const createdContracts: string[] = [];

  beforeAll(async () => {
    client = await register('client', 'assign-client');
    freelancer = await register('freelancer', 'assign-freelancer');
    otherFreelancer = await register('freelancer', 'assign-other-freelancer');
  });

  afterAll(async () => {
    for (const contractId of createdContracts) {
      await pool.query(`DELETE FROM contract_assignments WHERE contract_id = $1`, [contractId]);
      await pool.query(`DELETE FROM outbox WHERE payload->>'contractId' = $1`, [contractId]);
      await pool.query(`DELETE FROM notifications WHERE contract_id = $1`, [contractId]);
      await pool.query(`DELETE FROM merkle_ledger WHERE contract_id = $1`, [contractId]);
      await pool.query(`DELETE FROM contracts WHERE contract_id = $1`, [contractId]);
    }
    await pool.end();
  });

  /** Creates + locks a contract as `client`, returning its id. Locking first
   * means H0 already exists at assignment time — the common path this suite
   * mostly exercises; the "assign before lock" backfill path gets its own
   * dedicated test below. */
  async function createLockedContract(title: string): Promise<string> {
    const initRes = await server.inject({
      method: 'POST',
      url: '/api/contracts/initialize',
      headers: auth(client),
      payload: { title, requirements: 'Build a thing.', budgetCents: 500000, deadline: '2026-12-31' },
    });
    expect(initRes.statusCode).toBe(201);
    const contractId = initRes.json().contractId as string;
    createdContracts.push(contractId);

    const lockRes = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/lock`,
      headers: auth(client),
      payload: { title, requirements: 'Build a thing.', budgetCents: 500000, deadline: '2026-12-31' },
    });
    expect(lockRes.statusCode).toBe(200);
    return contractId;
  }

  it('assigning a freelancer creates a PENDING decision, not an ACTIVE contract', async () => {
    const contractId = await createLockedContract('Pending assignment test');

    const assignRes = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assign`,
      headers: auth(client),
      payload: { freelancerId: freelancer.userId },
    });
    expect(assignRes.statusCode).toBe(200);
    expect(assignRes.json().status).toBe('ASSIGNMENT_PENDING');

    const row = await pool.query(
      `SELECT status, locked_ledger_hash FROM contract_assignments WHERE contract_id = $1`,
      [contractId],
    );
    expect(row.rows[0].status).toBe('PENDING');
    // Lock already ran, so H0 was captured at assignment time -- no
    // backfill needed (that path is covered by its own test below).
    expect(row.rows[0].locked_ledger_hash).toBeTruthy();

    const contractRow = await pool.query(`SELECT status FROM contracts WHERE contract_id = $1`, [contractId]);
    expect(contractRow.rows[0].status).not.toBe('ACTIVE');

    // No repo_provisioning row from the gateway's own action -- provisioning
    // is settlement-worker's job, triggered off ASSIGNMENT_ACCEPTED, which
    // this contract has not reached.
    const provRow = await pool.query(`SELECT 1 FROM repo_provisioning WHERE contract_id = $1`, [contractId]);
    expect(provRow.rowCount).toBe(0);
  });

  it('backfills the H0 anchor at accept time when assignment happened before lock', async () => {
    // Mirrors the current UI's actual assign -> generate-tests -> lock
    // order: assign before any ledger row exists for this contract.
    const initRes = await server.inject({
      method: 'POST',
      url: '/api/contracts/initialize',
      headers: auth(client),
      payload: { title: 'Assign before lock', requirements: 'n/a', budgetCents: 100000, deadline: '2026-12-31' },
    });
    const contractId = initRes.json().contractId as string;
    createdContracts.push(contractId);

    const assignRes = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assign`,
      headers: auth(client),
      payload: { freelancerId: freelancer.userId },
    });
    expect(assignRes.statusCode).toBe(200);
    let row = await pool.query(`SELECT locked_ledger_hash FROM contract_assignments WHERE contract_id = $1`, [contractId]);
    expect(row.rows[0].locked_ledger_hash).toBeNull();

    await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/lock`,
      headers: auth(client),
      payload: { title: 'Assign before lock', requirements: 'n/a', budgetCents: 100000, deadline: '2026-12-31' },
    });

    const acceptRes = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assignment/accept`,
      headers: auth(freelancer),
    });
    expect(acceptRes.statusCode).toBe(200);

    row = await pool.query(`SELECT locked_ledger_hash FROM contract_assignments WHERE contract_id = $1`, [contractId]);
    expect(row.rows[0].locked_ledger_hash).toBeTruthy();
  });

  it('the assigned freelancer can view assignment-details and download the PDF; an unrelated freelancer cannot', async () => {
    const contractId = await createLockedContract('Details and PDF access test');
    await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assign`,
      headers: auth(client),
      payload: { freelancerId: freelancer.userId },
    });

    const detailsRes = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/assignment-details`,
      headers: auth(freelancer),
    });
    expect(detailsRes.statusCode).toBe(200);
    const details = detailsRes.json();
    expect(details.title).toBe('Details and PDF access test');
    expect(details.budgetCents).toBe(500000);
    expect(details.assignment.status).toBe('PENDING');
    expect(details.genesisHash).toBeTruthy();

    const pdfRes = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/assignment-pdf`,
      headers: auth(freelancer),
    });
    expect(pdfRes.statusCode).toBe(200);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
    const pdfBytes = pdfRes.rawPayload as Buffer;
    expect(pdfBytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
    // Authoritative-data check: the PDF text stream is compressed by
    // default, so this asserts on structure/size rather than parsing text --
    // a non-trivial, well-formed PDF was actually generated from the DB row,
    // not an empty placeholder.
    expect(pdfBytes.length).toBeGreaterThan(500);
    // No secret material has any business being anywhere near this
    // generator (see contract-pdf.ts's ContractPdfData -- it has no field
    // for one), so a literal service-token/JWT-secret substring should never
    // appear in the output.
    const serviceToken = loadConfig().SERVICE_TOKEN;
    if (serviceToken) expect(pdfBytes.includes(serviceToken)).toBe(false);

    const deniedDetailsRes = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/assignment-details`,
      headers: auth(otherFreelancer),
    });
    expect(deniedDetailsRes.statusCode).toBe(403);

    const deniedPdfRes = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/assignment-pdf`,
      headers: auth(otherFreelancer),
    });
    expect(deniedPdfRes.statusCode).toBe(403);
  });

  it('accepts a pending assignment, writes the outbox event, and rejects a second accept', async () => {
    const contractId = await createLockedContract('Accept flow test');
    await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assign`,
      headers: auth(client),
      payload: { freelancerId: freelancer.userId },
    });

    const acceptRes = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assignment/accept`,
      headers: auth(freelancer),
    });
    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.json().status).toBe('ACCEPTED');

    const row = await pool.query(`SELECT status, decided_at FROM contract_assignments WHERE contract_id = $1`, [contractId]);
    expect(row.rows[0].status).toBe('ACCEPTED');
    expect(row.rows[0].decided_at).toBeTruthy();

    const outboxRow = await pool.query(
      `SELECT topic FROM outbox WHERE topic = 'assignment.accepted' AND payload->>'contractId' = $1`,
      [contractId],
    );
    expect(outboxRow.rowCount).toBeGreaterThan(0);

    // Idempotency: a duplicate accept (double-click, retry) must not flip
    // anything twice -- the conditional UPDATE's WHERE status='PENDING' no
    // longer matches, so this is a 409, not a second ACCEPTED.
    const secondAcceptRes = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assignment/accept`,
      headers: auth(freelancer),
    });
    expect(secondAcceptRes.statusCode).toBe(409);
    expect(secondAcceptRes.json().error).toBe('ASSIGNMENT_NOT_PENDING');
  });

  it('two concurrent accept requests resolve to exactly one ACCEPTED', async () => {
    const contractId = await createLockedContract('Concurrent accept test');
    await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assign`,
      headers: auth(client),
      payload: { freelancerId: freelancer.userId },
    });

    const [a, b] = await Promise.all([
      server.inject({ method: 'POST', url: `/api/contracts/${contractId}/assignment/accept`, headers: auth(freelancer) }),
      server.inject({ method: 'POST', url: `/api/contracts/${contractId}/assignment/accept`, headers: auth(freelancer) }),
    ]);
    const statusCodes = [a.statusCode, b.statusCode].sort();
    expect(statusCodes).toEqual([200, 409]);

    const row = await pool.query(`SELECT status FROM contract_assignments WHERE contract_id = $1`, [contractId]);
    expect(row.rows[0].status).toBe('ACCEPTED');
  });

  it('rejects a pending assignment with a reason, frees the contract for reassignment, and blocks a late accept', async () => {
    const contractId = await createLockedContract('Reject flow test');
    await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assign`,
      headers: auth(client),
      payload: { freelancerId: freelancer.userId },
    });

    const rejectRes = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assignment/reject`,
      headers: auth(freelancer),
      payload: { reasonCode: 'DEADLINE_INFEASIBLE' },
    });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.json().status).toBe('REJECTED');

    const row = await pool.query(
      `SELECT status, rejection_reason_code FROM contract_assignments WHERE contract_id = $1`,
      [contractId],
    );
    expect(row.rows[0].status).toBe('REJECTED');
    expect(row.rows[0].rejection_reason_code).toBe('DEADLINE_INFEASIBLE');

    const contractRow = await pool.query(`SELECT freelancer_id FROM contracts WHERE contract_id = $1`, [contractId]);
    expect(contractRow.rows[0].freelancer_id).toBeNull();

    const outboxRow = await pool.query(
      `SELECT topic FROM outbox WHERE topic = 'assignment.rejected' AND payload->>'contractId' = $1`,
      [contractId],
    );
    expect(outboxRow.rowCount).toBeGreaterThan(0);

    // Rejection prevents provisioning: no repo_provisioning row exists, and
    // never can from this path -- ASSIGNMENT_ACCEPTED is never published.
    const provRow = await pool.query(`SELECT 1 FROM repo_provisioning WHERE contract_id = $1`, [contractId]);
    expect(provRow.rowCount).toBe(0);

    // The freelancer who already rejected cannot then accept the same
    // assignment. This is a 403, not a 409: rejection clears
    // contracts.freelancer_id, so freelancerContractParty's ownership check
    // now finds this freelancer is not a party to the contract at all --
    // which fires before the route's own "not pending" 409 logic ever runs.
    const lateAcceptRes = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assignment/accept`,
      headers: auth(freelancer),
    });
    expect(lateAcceptRes.statusCode).toBe(403);

    // The contract is open for reassignment to a different freelancer.
    const reassignRes = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assign`,
      headers: auth(client),
      payload: { freelancerId: otherFreelancer.userId },
    });
    expect(reassignRes.statusCode).toBe(200);
  });

  it('rejects accept/reject from a freelancer who is not the assignee', async () => {
    const contractId = await createLockedContract('Unauthorized decision test');
    await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assign`,
      headers: auth(client),
      payload: { freelancerId: freelancer.userId },
    });

    const acceptRes = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assignment/accept`,
      headers: auth(otherFreelancer),
    });
    expect(acceptRes.statusCode).toBe(403);

    const rejectRes = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assignment/reject`,
      headers: auth(otherFreelancer),
      payload: {},
    });
    expect(rejectRes.statusCode).toBe(403);

    // Still PENDING -- neither unauthorized call moved anything.
    const row = await pool.query(`SELECT status FROM contract_assignments WHERE contract_id = $1`, [contractId]);
    expect(row.rows[0].status).toBe('PENDING');
  });

  it('rejects an unauthenticated accept request', async () => {
    const contractId = await createLockedContract('Unauthenticated decision test');
    const res = await server.inject({ method: 'POST', url: `/api/contracts/${contractId}/assignment/accept` });
    expect(res.statusCode).toBe(401);
  });
});
