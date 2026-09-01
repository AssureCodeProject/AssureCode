/**
 * Regression guard: an existing account whose password predates (and would
 * fail) the new password-SETTING policy must keep authenticating exactly as
 * before. Modeled directly on the real seeded demo accounts
 * (tools/seed-users.py), all of which share the password `demo1234` --
 * inserted here via the same hashPassword() the real seed script and
 * registration both use, rather than assuming the seed script has already
 * run against this database.
 */
import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import { validateNewPassword } from '@assurecode/shared';
import server from '../src/server.js';
import { hashPassword } from '../src/middleware/auth.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — existing-user compatibility', 'a running PostgreSQL on DATABASE_URL');

const LEGACY_PASSWORD = 'demo1234';

describe.skipIf(!PG_UP)('existing (pre-policy) user compatibility', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  const userId = `legacy-compat-test-${Date.now()}`;
  const email = `legacy-compat-${Date.now()}@example.com`;

  it('sanity check: demo1234 itself would be rejected by the new policy for a NEW password', () => {
    expect(validateNewPassword(LEGACY_PASSWORD)).not.toBeNull();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM auth_tokens WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM security_audit_logs WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE user_id = $1`, [userId]);
    await pool.end();
  });

  it('a pre-existing legacy account (password demo1234) still logs in after the new policy ships', async () => {
    const passwordHash = await hashPassword(LEGACY_PASSWORD);
    await pool.query(
      `INSERT INTO users (user_id, email, password_hash, role, display_name)
       VALUES ($1, $2, $3, 'client', 'Legacy Compat Test')`,
      [userId, email, passwordHash],
    );

    const res = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: LEGACY_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(email);
  });

  it('that same account can voluntarily change to a policy-compliant password', async () => {
    const loginRes = await server.inject({ method: 'POST', url: '/auth/login', payload: { email, password: LEGACY_PASSWORD } });
    const token = loginRes.json().token;

    const changeRes = await server.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: LEGACY_PASSWORD, newPassword: 'a-genuinely-strong-pw-1' },
    });
    expect(changeRes.statusCode).toBe(200);

    // Old legacy password no longer works; new one does.
    const oldLoginRes = await server.inject({ method: 'POST', url: '/auth/login', payload: { email, password: LEGACY_PASSWORD } });
    expect(oldLoginRes.statusCode).toBe(401);

    const newLoginRes = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'a-genuinely-strong-pw-1' },
    });
    expect(newLoginRes.statusCode).toBe(200);
  });
});
