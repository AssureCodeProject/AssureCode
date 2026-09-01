/**
 * Authenticated password change: POST /auth/change-password.
 */
import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import server from '../src/server.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — change password', 'a running PostgreSQL on DATABASE_URL');

describe.skipIf(!PG_UP)('POST /auth/change-password', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  const cleanupUserIds: string[] = [];

  afterAll(async () => {
    for (const userId of cleanupUserIds) {
      await pool.query(`DELETE FROM auth_tokens WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM security_audit_logs WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM users WHERE user_id = $1`, [userId]);
    }
    await pool.end();
  });

  async function registerUser(): Promise<{ userId: string; email: string; token: string }> {
    const email = `changepw-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const res = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'current-password-1', role: 'client' },
    });
    const body = res.json();
    cleanupUserIds.push(body.user.userId);
    return { userId: body.user.userId, email, token: body.token };
  }

  it('rejects an unauthenticated request', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/change-password',
      payload: { currentPassword: 'x', newPassword: 'y' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects the wrong current password', async () => {
    const { token } = await registerUser();
    const res = await server.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: 'totally-wrong', newPassword: 'brand-new-password-1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a new password that violates policy', async () => {
    const { token } = await registerUser();
    const res = await server.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: 'current-password-1', newPassword: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('succeeds with the correct current password, and the new password authenticates afterward', async () => {
    const { email, token } = await registerUser();
    const res = await server.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: 'current-password-1', newPassword: 'brand-new-password-1' },
    });
    expect(res.statusCode).toBe(200);

    const loginRes = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'brand-new-password-1' },
    });
    expect(loginRes.statusCode).toBe(200);
  });

  it('revokes every other session but keeps the acting session alive', async () => {
    const { email, token: sessionA } = await registerUser();
    const loginRes = await server.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'current-password-1' } });
    const sessionB = loginRes.json().token;

    // Change password using session A.
    const changeRes = await server.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { authorization: `Bearer ${sessionA}` },
      payload: { currentPassword: 'current-password-1', newPassword: 'yet-another-password-1' },
    });
    expect(changeRes.statusCode).toBe(200);

    // Session A (the one that made the change) is still valid.
    const meA = await server.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${sessionA}` } });
    expect(meA.statusCode).toBe(200);

    // Session B (a different login) has been revoked.
    const meB = await server.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${sessionB}` } });
    expect(meB.statusCode).toBe(401);
  });
});
