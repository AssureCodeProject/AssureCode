/**
 * Email format validation and canonicalization at POST /auth/register and
 * POST /auth/login. Backend-authoritative — frontend validation is UX only.
 */
import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import server from '../src/server.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — email validation', 'a running PostgreSQL on DATABASE_URL');

describe.skipIf(!PG_UP)('email validation and canonicalization', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  const cleanupUserIds: string[] = [];

  afterAll(async () => {
    for (const userId of cleanupUserIds) {
      await pool.query(`DELETE FROM auth_tokens WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM security_audit_logs WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM users WHERE user_id = $1`, [userId]);
    }
    await pool.end();
  });

  it('rejects an empty email', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: '', password: 'a-strong-password', role: 'client' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Email address is required.');
  });

  it('rejects an email missing the @', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'sowmithgmail.com', password: 'a-strong-password', role: 'client' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Please enter a valid email address.');
  });

  it('rejects an email missing a valid domain', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'sowmith@', password: 'a-strong-password', role: 'client' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an email missing the local part', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: '@gmail.com', password: 'a-strong-password', role: 'client' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a bare string with no email structure at all', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'sowmith', password: 'a-strong-password', role: 'client' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('canonicalizes (trim + lowercase) on register, and the same canonical form logs in', async () => {
    const raw = `  Canon-Test-${Date.now()}@Example.COM  `;
    const canonical = raw.trim().toLowerCase();

    const registerRes = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: raw, password: 'a-strong-password', role: 'client' },
    });
    expect(registerRes.statusCode).toBe(201);
    expect(registerRes.json().user.email).toBe(canonical);
    cleanupUserIds.push(registerRes.json().user.userId);

    const dbRow = await pool.query(`SELECT email FROM users WHERE email = $1`, [canonical]);
    expect(dbRow.rowCount).toBe(1);

    // Logging in with a differently-cased/whitespaced form of the same
    // address must resolve to the same account.
    const loginRes = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ` ${canonical.toUpperCase()} `, password: 'a-strong-password' },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json().user.email).toBe(canonical);
  });

  it('accepts well-formed emails', async () => {
    for (const email of [`valid1-${Date.now()}@gmail.com`, `john.doe-${Date.now()}@example.com`, `user123-${Date.now()}@company.in`]) {
      const res = await server.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password: 'a-strong-password', role: 'client' },
      });
      expect(res.statusCode).toBe(201);
      cleanupUserIds.push(res.json().user.userId);
    }
  });
});
