/**
 * TOTP-based MFA: enroll -> verify -> gated login -> disable.
 *
 * `mfa_credentials`/`users.mfa_enabled` existed since V011 with nothing ever
 * writing a real credential. This is the regression guard for the whole
 * lifecycle actually working end to end, not just existing as routes:
 * enrolling does not gate login until verified, a verified account cannot
 * log in on password alone, a wrong code never gets through at any step, and
 * disabling requires proving current possession of the factor rather than
 * just holding a session.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { generate } from 'otplib';
import server from '../src/server.js';
import { hashPassword } from '../src/middleware/auth.js';
import { buildDbConfig, getDatabaseUrl, loadConfig } from '@assurecode/config';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — MFA', 'a running PostgreSQL on DATABASE_URL');

const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));

const EMAIL = `mfa-test-${Date.now()}@example.test`;
const PASSWORD = 'correct-horse-battery-staple';
const USER_ID = `user-mfa-test-${Date.now()}`;

beforeAll(async () => {
  if (!PG_UP) return;
  await server.ready();
  await pool.query(
    `INSERT INTO users (user_id, email, password_hash, role, display_name)
     VALUES ($1, $2, $3, 'freelancer', 'MFA Test')`,
    [USER_ID, EMAIL, await hashPassword(PASSWORD)],
  );
});

afterAll(async () => {
  if (PG_UP) {
    await pool.query(`DELETE FROM mfa_credentials WHERE user_id = $1`, [USER_ID]);
    await pool.query(`DELETE FROM user_sessions WHERE user_id = $1`, [USER_ID]);
    await pool.query(`DELETE FROM users WHERE user_id = $1`, [USER_ID]);
  }
  await pool?.end();
});

async function login(): Promise<{ status: number; body: any }> {
  const res = await server.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  return { status: res.statusCode, body: res.json() };
}

describe.skipIf(!PG_UP)('MFA (TOTP)', () => {
  it('an unenrolled account logs in on password alone', async () => {
    const { status, body } = await login();
    expect(status).toBe(200);
    expect(body.token).toBeTruthy();
    expect(body.mfaRequired).toBeUndefined();
  });

  it('enroll requires authentication', async () => {
    const res = await server.inject({ method: 'POST', url: '/auth/mfa/enroll' });
    expect(res.statusCode).toBe(401);
  });

  let secret: string;
  let authHeaders: Record<string, string>;

  it('enroll returns a fresh secret that does not yet gate login', async () => {
    const { body: loginBody } = await login();
    authHeaders = { authorization: `Bearer ${loginBody.token}` };

    const res = await server.inject({ method: 'POST', url: '/auth/mfa/enroll', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.secret).toBeTruthy();
    expect(body.otpauthUri).toContain('otpauth://totp/');
    secret = body.secret;

    // Not yet activated — password-only login must still work.
    const { status, body: loginBody2 } = await login();
    expect(status).toBe(200);
    expect(loginBody2.mfaRequired).toBeUndefined();
  });

  it('verify rejects a wrong code and does not activate', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      headers: authHeaders,
      payload: { code: '000000' },
    });
    expect(res.statusCode).toBe(401);

    const { status, body } = await login();
    expect(status).toBe(200);
    expect(body.mfaRequired).toBeUndefined();
  });

  it('verify with a real code activates MFA, and login now requires a challenge', async () => {
    const code = await generate({ secret });
    const res = await server.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      headers: authHeaders,
      payload: { code },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const { status, body } = await login();
    expect(status).toBe(200);
    expect(body.mfaRequired).toBe(true);
    expect(body.challenge).toBeTruthy();
    expect(body.token).toBeUndefined();
  });

  it('re-enrolling while already active is refused', async () => {
    const res = await server.inject({ method: 'POST', url: '/auth/mfa/enroll', headers: authHeaders });
    expect(res.statusCode).toBe(409);
  });

  it('the challenge rejects a wrong code and issues no session', async () => {
    const { body: loginBody } = await login();
    const res = await server.inject({
      method: 'POST',
      url: '/auth/mfa/challenge',
      payload: { challenge: loginBody.challenge, code: '000000' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('a garbage challenge string is rejected, not a 500', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/mfa/challenge',
      payload: { challenge: 'not-a-real-challenge', code: '123456' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('the challenge with a real code completes login and issues a real session', async () => {
    const { body: loginBody } = await login();
    expect(loginBody.mfaRequired).toBe(true);

    const code = await generate({ secret });
    const res = await server.inject({
      method: 'POST',
      url: '/auth/mfa/challenge',
      payload: { challenge: loginBody.challenge, code },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTruthy();

    const me = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().authenticated).toBe(true);
  });

  it('disable refuses a wrong code, leaving MFA enabled', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/mfa/disable',
      headers: authHeaders,
      payload: { code: '000000' },
    });
    expect(res.statusCode).toBe(401);

    const { body } = await login();
    expect(body.mfaRequired).toBe(true);
  });

  it('disable with a real code turns MFA off, and login is password-only again', async () => {
    const code = await generate({ secret });
    const res = await server.inject({
      method: 'POST',
      url: '/auth/mfa/disable',
      headers: authHeaders,
      payload: { code },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const { status, body } = await login();
    expect(status).toBe(200);
    expect(body.mfaRequired).toBeUndefined();
    expect(body.token).toBeTruthy();
  });
});
