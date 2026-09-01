/**
 * POST /api/contracts/:id/simulate-push — the guard against silently
 * overwriting a real audit result.
 *
 * Simulate Push and a real GitHub webhook push publish the identical
 * CODE_PUSH_RECEIVED event and land on the same single-row oracle_state, so
 * without this guard, clicking Simulate Push after a real push discards the
 * real result with no warning (this is the exact bug this suite reproduces
 * directly against audit_results, without needing a live ci-worker consumer
 * — the guard itself only reads audit_results, so seeding a row is enough).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import server from '../src/server.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — simulate-push overwrite guard', 'a running PostgreSQL on DATABASE_URL');

interface Registered {
  token: string;
  userId: string;
}

async function register(role: 'client' | 'freelancer', tag: string): Promise<Registered> {
  const res = await server.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: 'a-strong-password-1',
      role,
    },
  });
  const body = res.json();
  return { token: body.token, userId: body.user.userId };
}

function auth(t: Registered): Record<string, string> {
  return { authorization: `Bearer ${t.token}` };
}

describe.skipIf(!PG_UP)('simulate-push overwrite guard', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  let client: Registered;
  const createdContracts: string[] = [];

  beforeAll(async () => {
    client = await register('client', 'simguard-client');
  });

  afterAll(async () => {
    for (const contractId of createdContracts) {
      await pool.query(`DELETE FROM audit_results WHERE contract_id = $1`, [contractId]);
      await pool.query(`DELETE FROM merkle_ledger WHERE contract_id = $1`, [contractId]);
      await pool.query(`DELETE FROM outbox WHERE payload->>'contractId' = $1`, [contractId]);
      await pool.query(`DELETE FROM contracts WHERE contract_id = $1`, [contractId]);
    }
    if (client) {
      await pool.query(`DELETE FROM security_audit_logs WHERE user_id = $1`, [client.userId]);
      await pool.query(`DELETE FROM users WHERE user_id = $1`, [client.userId]);
    }
    await pool.end();
  });

  async function createLockedContract(title: string): Promise<string> {
    const initRes = await server.inject({
      method: 'POST',
      url: '/api/contracts/initialize',
      headers: auth(client),
      payload: { title, requirements: 'n/a', budgetCents: 100000, deadline: '2026-12-31' },
    });
    const contractId = initRes.json().contractId as string;
    createdContracts.push(contractId);
    await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/lock`,
      headers: auth(client),
      payload: { title, requirements: 'n/a', budgetCents: 100000, deadline: '2026-12-31' },
    });
    return contractId;
  }

  it('allows simulate-push on a contract with no audit history yet', async () => {
    const contractId = await createLockedContract('No history yet');
    const res = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/simulate-push`,
      headers: auth(client),
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses simulate-push once a real (non-demo) audit result is on record', async () => {
    const contractId = await createLockedContract('Has a real push already');
    // Seed a real audit row directly -- exactly what ci-worker writes for a
    // genuine GitHub webhook push (demo: false), without needing a live
    // ci-worker consumer in this suite.
    await pool.query(
      `INSERT INTO audit_results (contract_id, payload, passed)
       VALUES ($1, $2::jsonb, true)`,
      [contractId, JSON.stringify({ contractId, demo: false, maintainability: 42 })],
    );

    const res = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/simulate-push`,
      headers: auth(client),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('real GitHub push');
  });

  it('treats a pre-existing row with no demo key at all as real (fails closed)', async () => {
    const contractId = await createLockedContract('Legacy row, no demo key');
    await pool.query(
      `INSERT INTO audit_results (contract_id, payload, passed)
       VALUES ($1, $2::jsonb, true)`,
      [contractId, JSON.stringify({ contractId, maintainability: 42 })], // no `demo` key
    );

    const res = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/simulate-push`,
      headers: auth(client),
    });
    expect(res.statusCode).toBe(409);
  });

  it('does not block further simulate-push calls when only demo rows exist', async () => {
    const contractId = await createLockedContract('Only demo rows so far');
    await pool.query(
      `INSERT INTO audit_results (contract_id, payload, passed)
       VALUES ($1, $2::jsonb, true)`,
      [contractId, JSON.stringify({ contractId, demo: true, maintainability: 74.7 })],
    );

    const res = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/simulate-push`,
      headers: auth(client),
    });
    expect(res.statusCode).toBe(200);
  });
});
