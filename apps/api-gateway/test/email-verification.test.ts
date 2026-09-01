/**
 * Email verification: token issued at registration, redeemed at
 * POST /auth/verify-email. Explicitly proves verification status does NOT
 * gate login (see routes/auth.ts's comment on that deliberate choice).
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import type { FakeEmailAdapter } from '@assurecode/email-adapter';
import server from '../src/server.js';
import { emailAdapter } from '../src/context.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — email verification', 'a running PostgreSQL on DATABASE_URL');

const fakeEmail = emailAdapter as unknown as FakeEmailAdapter;

function tokenFromVerifyUrl(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

describe.skipIf(!PG_UP)('email verification', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  const cleanupUserIds: string[] = [];

  beforeEach(() => fakeEmail.clear());

  afterAll(async () => {
    for (const userId of cleanupUserIds) {
      await pool.query(`DELETE FROM auth_tokens WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM security_audit_logs WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM users WHERE user_id = $1`, [userId]);
    }
    await pool.end();
  });

  async function registerUser(): Promise<{ userId: string; email: string; token: string }> {
    const email = `verify-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const res = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'a-strong-password-1', role: 'freelancer' },
    });
    const body = res.json();
    cleanupUserIds.push(body.user.userId);
    return { userId: body.user.userId, email, token: body.token };
  }

  it('a verification email is sent on registration', async () => {
    const { email } = await registerUser();
    const sent = fakeEmail.getSentEmails().filter((m) => m.kind === 'VERIFICATION' && m.to === email);
    expect(sent.length).toBe(1);
  });

  it('redeeming the token marks the account verified, reflected on /auth/me', async () => {
    const { email, token: sessionToken } = await registerUser();
    const sent = fakeEmail.getSentEmails().filter((m) => m.kind === 'VERIFICATION' && m.to === email);
    const rawToken = tokenFromVerifyUrl(sent[0].url);

    const meBefore = await server.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${sessionToken}` } });
    expect(meBefore.json().emailVerified).toBe(false);

    const verifyRes = await server.inject({ method: 'POST', url: '/auth/verify-email', payload: { token: rawToken } });
    expect(verifyRes.statusCode).toBe(200);

    const meAfter = await server.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${sessionToken}` } });
    expect(meAfter.json().emailVerified).toBe(true);
  });

  it('a reused verification token is rejected', async () => {
    const { email } = await registerUser();
    const sent = fakeEmail.getSentEmails().filter((m) => m.kind === 'VERIFICATION' && m.to === email);
    const rawToken = tokenFromVerifyUrl(sent[0].url);

    const first = await server.inject({ method: 'POST', url: '/auth/verify-email', payload: { token: rawToken } });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({ method: 'POST', url: '/auth/verify-email', payload: { token: rawToken } });
    expect(second.statusCode).toBe(400);
  });

  it('an expired verification token is rejected', async () => {
    const { userId, email } = await registerUser();
    const sent = fakeEmail.getSentEmails().filter((m) => m.kind === 'VERIFICATION' && m.to === email);
    const rawToken = tokenFromVerifyUrl(sent[0].url);

    await pool.query(
      `UPDATE auth_tokens SET expires_at = now() - interval '1 minute'
        WHERE user_id = $1 AND type = 'EMAIL_VERIFICATION'`,
      [userId],
    );

    const res = await server.inject({ method: 'POST', url: '/auth/verify-email', payload: { token: rawToken } });
    expect(res.statusCode).toBe(400);
  });

  it('login works before, during, and after verification -- verification never gates login', async () => {
    const { email } = await registerUser();

    const loginBefore = await server.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'a-strong-password-1' } });
    expect(loginBefore.statusCode).toBe(200);

    const sent = fakeEmail.getSentEmails().filter((m) => m.kind === 'VERIFICATION' && m.to === email);
    await server.inject({ method: 'POST', url: '/auth/verify-email', payload: { token: tokenFromVerifyUrl(sent[0].url) } });

    const loginAfter = await server.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'a-strong-password-1' } });
    expect(loginAfter.statusCode).toBe(200);
  });
});
