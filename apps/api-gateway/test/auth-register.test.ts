/**
 * POST /auth/register — self-service account creation.
 *
 * Before this, the only ways to get a users row were the seed script
 * (tools/seed-users.py) and the GitHub OAuth callback. This is the first
 * password-account path a real, un-seeded person can go through.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import server from '../src/server.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — self-service registration', 'a running PostgreSQL on DATABASE_URL');

describe.skipIf(!PG_UP)('POST /auth/register', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  const email = `register-test-${Date.now()}@example.com`;
  let createdUserId: string | null = null;

  afterAll(async () => {
    if (createdUserId) {
      await pool.query(`DELETE FROM security_audit_logs WHERE user_id = $1`, [createdUserId]);
      await pool.query(`DELETE FROM users WHERE user_id = $1`, [createdUserId]);
    }
    await pool.end();
  });

  it('creates a client account and returns a real session', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'a-strong-password', role: 'client' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe(email);
    expect(body.user.role).toBe('client');

    const row = await pool.query(`SELECT user_id, role, kyc_status FROM users WHERE email = $1`, [email]);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].role).toBe('client');
    // Left at the column default -- escrow/settle stay requireKycVerified-
    // gated, so this account correctly cannot fund a contract yet.
    expect(row.rows[0].kyc_status).toBe('UNVERIFIED');
    createdUserId = row.rows[0].user_id;

    // The session returned above must actually authenticate.
    const meRes = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().email).toBe(email);
  });

  it('rejects a duplicate email', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'another-strong-password', role: 'freelancer' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a role other than client or freelancer', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `admin-attempt-${Date.now()}@example.com`, password: 'a-strong-password', role: 'admin' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a password under 8 characters', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `short-pw-${Date.now()}@example.com`, password: 'short', role: 'client' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a missing email or password', async () => {
    const res = await server.inject({ method: 'POST', url: '/auth/register', payload: { role: 'client' } });
    expect(res.statusCode).toBe(400);
  });
});
