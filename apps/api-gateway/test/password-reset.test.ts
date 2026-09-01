/**
 * Forgot-password / reset-password: POST /auth/forgot-password,
 * POST /auth/reset-password.
 *
 * Pulls the raw token out of FakeEmailAdapter's in-memory sent-message list
 * (see @assurecode/email-adapter) rather than a log line — the adapter
 * never logs a token/link, on purpose, matching this project's "never log a
 * reset token" rule. `emailAdapter` is the same singleton instance
 * routes/auth.ts calls (see context.ts), so what it captured here is
 * exactly what the route sent.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import type { FakeEmailAdapter } from '@assurecode/email-adapter';
import server from '../src/server.js';
import { emailAdapter } from '../src/context.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — password reset', 'a running PostgreSQL on DATABASE_URL');

const fakeEmail = emailAdapter as unknown as FakeEmailAdapter;

function tokenFromResetUrl(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

describe.skipIf(!PG_UP)('password reset', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  const cleanupUserIds: string[] = [];

  beforeEach(() => fakeEmail.clear());

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
    const email = `reset-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const res = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'original-password-1', role: 'client' },
    });
    const body = res.json();
    cleanupUserIds.push(body.user.userId);
    return { userId: body.user.userId, email, token: body.token };
  }

  it('forgot-password returns the same generic response for both a known and an unknown email', async () => {
    const { email } = await registerUser();

    const knownRes = await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    const unknownRes = await server.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: 'definitely-not-registered-xyz@example.com' },
    });

    expect(knownRes.statusCode).toBe(200);
    expect(unknownRes.statusCode).toBe(200);
    expect(knownRes.json().message).toBe(unknownRes.json().message);
  });

  it('full flow: register -> forgot-password -> reset -> old password fails, new password works, old sessions are revoked', async () => {
    const { userId, email, token: originalSessionToken } = await registerUser();

    const forgotRes = await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    expect(forgotRes.statusCode).toBe(200);

    const sent = fakeEmail.getSentEmails().filter((m) => m.kind === 'PASSWORD_RESET' && m.to === email);
    expect(sent.length).toBe(1);
    const rawToken = tokenFromResetUrl(sent[0].url);
    expect(rawToken).toBeTruthy();

    const resetRes = await server.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: rawToken, newPassword: 'brand-new-password-1', confirmPassword: 'brand-new-password-1' },
    });
    expect(resetRes.statusCode).toBe(200);

    // Old password no longer works.
    const oldLoginRes = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'original-password-1' },
    });
    expect(oldLoginRes.statusCode).toBe(401);

    // New password works.
    const newLoginRes = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'brand-new-password-1' },
    });
    expect(newLoginRes.statusCode).toBe(200);

    // The session from registration was revoked by the reset.
    const meRes = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${originalSessionToken}` },
    });
    expect(meRes.statusCode).toBe(401);

    // The reset token cannot be reused.
    const reuseRes = await server.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: rawToken, newPassword: 'another-password-12', confirmPassword: 'another-password-12' },
    });
    expect(reuseRes.statusCode).toBe(400);

    void userId;
  });

  it('rejects an expired reset token', async () => {
    const { userId, email } = await registerUser();
    await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    const sent = fakeEmail.getSentEmails().filter((m) => m.kind === 'PASSWORD_RESET' && m.to === email);
    const rawToken = tokenFromResetUrl(sent[sent.length - 1].url);

    // Force the token to be already expired.
    await pool.query(
      `UPDATE auth_tokens SET expires_at = now() - interval '1 minute'
        WHERE user_id = $1 AND type = 'PASSWORD_RESET'`,
      [userId],
    );

    const res = await server.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: rawToken, newPassword: 'some-new-password-1', confirmPassword: 'some-new-password-1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a new password that violates policy during reset (whitespace, non-ASCII)', async () => {
    const { email } = await registerUser();
    await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    const sent = fakeEmail.getSentEmails().filter((m) => m.kind === 'PASSWORD_RESET' && m.to === email);
    const rawToken = tokenFromResetUrl(sent[sent.length - 1].url);

    const whitespaceRes = await server.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: rawToken, newPassword: 'My Password123!', confirmPassword: 'My Password123!' },
    });
    expect(whitespaceRes.statusCode).toBe(400);

    const unicodeRes = await server.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: rawToken, newPassword: 'पासवर्ड123!अ', confirmPassword: 'पासवर्ड123!अ' },
    });
    expect(unicodeRes.statusCode).toBe(400);
  });

  it('rejects mismatched confirmPassword during reset', async () => {
    const { email } = await registerUser();
    await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    const sent = fakeEmail.getSentEmails().filter((m) => m.kind === 'PASSWORD_RESET' && m.to === email);
    const rawToken = tokenFromResetUrl(sent[sent.length - 1].url);

    const res = await server.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: rawToken, newPassword: 'password-one-123', confirmPassword: 'password-two-123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Passwords do not match.');
  });
});
