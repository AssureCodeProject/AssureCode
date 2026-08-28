/**
 * Real session revocation: POST /auth/logout must actually invalidate the
 * token it was called with, not just log that a logout happened.
 *
 * Before this, a JWT was stateless with no expiry and no way to invalidate
 * one early — this suite is the regression guard for both halves: logout
 * revokes the specific session (this exact token stops working), and an
 * expired session is rejected even though the JWT's own signature is still
 * valid (the DB-backed check catches what the token's own `exp` claim would
 * also have caught, proving the two do not silently disagree).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import server from '../src/server.js';
import { hashPassword } from '../src/middleware/auth.js';
import { buildDbConfig, getDatabaseUrl, loadConfig } from '@assurecode/config';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — session revocation', 'a running PostgreSQL on DATABASE_URL');

const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));

const EMAIL = `session-revocation-test-${Date.now()}@example.test`;
const PASSWORD = 'correct-horse-battery-staple';
const USER_ID = `user-session-revocation-${Date.now()}`;

beforeAll(async () => {
  if (!PG_UP) return;
  await server.ready();
  await pool.query(
    `INSERT INTO users (user_id, email, password_hash, role, display_name)
     VALUES ($1, $2, $3, 'freelancer', 'Session Revocation Test')`,
    [USER_ID, EMAIL, await hashPassword(PASSWORD)],
  );
});

afterAll(async () => {
  if (PG_UP) {
    await pool.query(`DELETE FROM user_sessions WHERE user_id = $1`, [USER_ID]);
    await pool.query(`DELETE FROM users WHERE user_id = $1`, [USER_ID]);
  }
  await pool?.end();
});

async function login(): Promise<string> {
  const res = await server.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

describe.skipIf(!PG_UP)('session revocation', () => {
  it('a freshly issued token authenticates', async () => {
    const token = await login();
    const res = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authenticated).toBe(true);
  });

  it('creates a real user_sessions row on login, not just a token', async () => {
    const token = await login();
    const { rows } = await pool.query(
      `SELECT revoked_at, expires_at FROM user_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [USER_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).toBeNull();
    expect(new Date(rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
    // The token itself must still be present to prove this session backs it —
    // trivially true given login() just returned it, but pins the ordering.
    expect(token).toBeTruthy();
  });

  it('POST /auth/logout revokes the session, and the SAME token is then rejected', async () => {
    const token = await login();

    const before = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);

    const logoutRes = await server.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.json().success).toBe(true);

    const after = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('logging out one session does not revoke a different session for the same user', async () => {
    const tokenA = await login();
    const tokenB = await login();

    await server.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const resA = await server.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${tokenA}` } });
    const resB = await server.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${tokenB}` } });

    expect(resA.statusCode).toBe(401);
    expect(resB.statusCode).toBe(200);
  });

  it('an expired session is rejected even with a structurally valid token', async () => {
    const token = await login();

    // Simulates time passing past expiry without waiting real time — the
    // token's own signature stays valid, only the DB-backed session ages out,
    // proving the revocation check (not just @fastify/jwt's own exp check) is
    // what is actually enforcing this.
    await pool.query(
      `UPDATE user_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`,
      [USER_ID],
    );

    const res = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logging out twice is not an error', async () => {
    const token = await login();
    await server.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } });

    // The second call has no valid session to present, so it is
    // unauthenticated — asserting only that the server does not 500.
    const res = await server.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });
});
