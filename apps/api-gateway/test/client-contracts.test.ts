/**
 * GET /api/contracts/owned ("My Contracts") and the contact-email fields
 * added to GET /api/contracts/:id/assignment-details.
 *
 * Authorization boundary tested here: a client only ever sees contracts
 * where contracts.client_id = their own user id (the WHERE clause itself,
 * same shape /api/contracts/mine already uses for freelancers); contact
 * emails only ever flow through assignment-details, already gated by
 * contractPartyOnly and covered for the negative (unrelated-user) case by
 * assignment-decision.test.ts's existing 403 tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import server from '../src/server.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — My Contracts / contact emails', 'a running PostgreSQL on DATABASE_URL');

interface Registered {
  token: string;
  userId: string;
  email: string;
}

async function register(role: 'client' | 'freelancer', tag: string): Promise<Registered> {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await server.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: 'a-strong-password-1', role },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token, userId: body.user.userId, email: body.user.email };
}

function auth(t: Registered): Record<string, string> {
  return { authorization: `Bearer ${t.token}` };
}

describe.skipIf(!PG_UP)('My Contracts and contact-email authorization', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  let clientA: Registered;
  let clientB: Registered;
  let freelancer: Registered;
  const createdContracts: string[] = [];

  beforeAll(async () => {
    clientA = await register('client', 'owned-client-a');
    clientB = await register('client', 'owned-client-b');
    freelancer = await register('freelancer', 'owned-freelancer');
  });

  afterAll(async () => {
    for (const contractId of createdContracts) {
      await pool.query(`DELETE FROM contract_assignments WHERE contract_id = $1`, [contractId]);
      await pool.query(`DELETE FROM merkle_ledger WHERE contract_id = $1`, [contractId]);
      await pool.query(`DELETE FROM outbox WHERE payload->>'contractId' = $1`, [contractId]);
      await pool.query(`DELETE FROM contracts WHERE contract_id = $1`, [contractId]);
    }
    for (const u of [clientA, clientB, freelancer]) {
      await pool.query(`DELETE FROM security_audit_logs WHERE user_id = $1`, [u.userId]);
      await pool.query(`DELETE FROM user_sessions WHERE user_id = $1`, [u.userId]);
      await pool.query(`DELETE FROM users WHERE user_id = $1`, [u.userId]);
    }
    await pool.end();
  });

  async function createContract(client: Registered, title: string): Promise<string> {
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/initialize',
      headers: auth(client),
      payload: { title, requirements: 'n/a', budgetCents: 250000, deadline: '2026-12-31' },
    });
    const contractId = res.json().contractId as string;
    createdContracts.push(contractId);
    return contractId;
  }

  it('a client sees only contracts they own on /api/contracts/owned', async () => {
    const ownedId = await createContract(clientA, 'Owned by A');
    await createContract(clientB, 'Owned by B');

    const res = await server.inject({ method: 'GET', url: '/api/contracts/owned', headers: auth(clientA) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().contracts.map((c: any) => c.contractId);
    expect(ids).toContain(ownedId);

    const resB = await server.inject({ method: 'GET', url: '/api/contracts/owned', headers: auth(clientB) });
    const idsB = resB.json().contracts.map((c: any) => c.contractId);
    expect(idsB).not.toContain(ownedId);
  });

  it('a freelancer cannot call /api/contracts/owned', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/contracts/owned', headers: auth(freelancer) });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unauthenticated request to /api/contracts/owned', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/contracts/owned' });
    expect(res.statusCode).toBe(401);
  });

  it('the owned-contracts list reflects assignment status and freelancer name once assigned', async () => {
    const contractId = await createContract(clientA, 'Assignment status visibility test');
    await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assign`,
      headers: auth(clientA),
      payload: { freelancerId: freelancer.userId },
    });

    const res = await server.inject({ method: 'GET', url: '/api/contracts/owned', headers: auth(clientA) });
    const row = res.json().contracts.find((c: any) => c.contractId === contractId);
    expect(row).toBeTruthy();
    expect(row.assignmentStatus).toBe('PENDING');
    expect(row.freelancerDisplayName).toBeTruthy();
  });

  it('assignment-details returns both parties\' contact emails to the client and the assigned freelancer', async () => {
    const contractId = await createContract(clientA, 'Contact email visibility test');
    await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assign`,
      headers: auth(clientA),
      payload: { freelancerId: freelancer.userId },
    });

    const asClient = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/assignment-details`,
      headers: auth(clientA),
    });
    expect(asClient.statusCode).toBe(200);
    expect(asClient.json().clientEmail).toBe(clientA.email);
    expect(asClient.json().freelancerEmail).toBe(freelancer.email);

    const asFreelancer = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/assignment-details`,
      headers: auth(freelancer),
    });
    expect(asFreelancer.statusCode).toBe(200);
    expect(asFreelancer.json().clientEmail).toBe(clientA.email);
    expect(asFreelancer.json().freelancerEmail).toBe(freelancer.email);
  });

  it('an unrelated client cannot read another client\'s contract contact emails', async () => {
    const contractId = await createContract(clientA, 'Unrelated client access test');
    const res = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/assignment-details`,
      headers: auth(clientB),
    });
    expect(res.statusCode).toBe(403);
  });
});
