/**
 * Ownership guards on the three routes that take a caller-supplied `userId`.
 *
 * /api/kyc/verify had an inline check; /api/kyc/status/:userId and
 * /api/kyc/connect-onboarding had none. That meant any authenticated user
 * could read another account's compliance record, and open a payout-account
 * onboarding flow in someone else's name, just by changing an ID in the
 * request.
 *
 * This used to run without PostgreSQL — the denial happened before any
 * database access. It no longer can: auth.ts now checks user_sessions on
 * every authenticated request (real session revocation, not just a token
 * that never expires), so *reaching* the guard at all requires a real
 * session row, which requires a real user row for the FK. Skips, rather than
 * mocks the database away, when one is not reachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import server from '../src/server.js';
import { newSessionId, createSession } from '../src/middleware/session-store.js';
import { buildDbConfig, getDatabaseUrl, loadConfig } from '@assurecode/config';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

type Role = 'client' | 'freelancer' | 'auditor' | 'admin';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — KYC ownership guards', 'a running PostgreSQL on DATABASE_URL');

const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));

/** Every userId used as a *caller* (not just a target) needs a real users row for user_sessions' FK, and a real session row to pass auth.ts's revocation check. */
const CALLER_IDS = ['user-attacker', 'user-a', 'user-admin', 'user-self'];

async function tokenFor(userId: string, role: Role = 'freelancer'): Promise<string> {
  await pool.query(
    `INSERT INTO users (user_id, email, password_hash, role, display_name)
     VALUES ($1, $1 || '@example.test', 'unusable-no-login', $2, $1)
     ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, role],
  );

  const sessionId = newSessionId();
  const token = (server as any).jwt.sign({
    sub: userId,
    email: `${userId}@example.test`,
    role,
    kycStatus: 'UNVERIFIED',
    mfaEnabled: false,
    sid: sessionId,
  });
  await createSession(pool, sessionId, { userId, token, ttlSeconds: 3600 });
  return token;
}

async function authHeaders(userId: string, role: Role = 'freelancer'): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await tokenFor(userId, role)}` };
}

beforeAll(async () => {
  // jwt.sign is only decorated onto the instance once plugins have registered.
  await server.ready();
});

afterAll(async () => {
  if (PG_UP) await pool.query(`DELETE FROM users WHERE user_id = ANY($1)`, [CALLER_IDS]);
  await pool?.end();
});

describe.skipIf(!PG_UP)('KYC route ownership guards', () => {
  describe('POST /api/kyc/verify', () => {
    it('rejects verifying somebody else', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/kyc/verify',
        headers: await authHeaders('user-attacker'),
        payload: { userId: 'user-victim', idType: 'PASSPORT' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Forbidden');
    });

    it('still validates the payload before deciding', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/kyc/verify',
        headers: await authHeaders('user-a'),
        payload: { userId: 'user-a' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/kyc/status/:userId', () => {
    it("rejects reading another account's compliance record", async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/kyc/status/user-victim',
        headers: await authHeaders('user-attacker'),
      });

      expect(res.statusCode).toBe(403);
    });

    it('does not leak whether the target account exists', async () => {
      // Both a real and an invented ID must answer identically, or the
      // status code itself becomes a user-enumeration oracle.
      const headers = await authHeaders('user-attacker');
      const real = await server.inject({
        method: 'GET',
        url: '/api/kyc/status/legacy-client',
        headers,
      });
      const invented = await server.inject({
        method: 'GET',
        url: '/api/kyc/status/no-such-user-at-all',
        headers,
      });

      expect(real.statusCode).toBe(403);
      expect(invented.statusCode).toBe(403);
    });
  });

  describe('POST /api/kyc/connect-onboarding', () => {
    it('rejects opening payout onboarding for somebody else', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/kyc/connect-onboarding',
        headers: await authHeaders('user-attacker'),
        payload: { userId: 'user-victim', email: 'victim@example.test' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('requires a userId', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/kyc/connect-onboarding',
        headers: await authHeaders('user-a'),
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('who is allowed through', () => {
    // These get past the guard, so they proceed into handler logic that may
    // need a database or the escrow adapter. The assertion is only that the
    // guard did not stop them — anything except 403.
    it('an admin may act on another account', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/kyc/status/user-victim',
        headers: await authHeaders('user-admin', 'admin'),
      });

      expect(res.statusCode).not.toBe(403);
    });

    it('a user may act on themselves', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/kyc/status/user-self',
        headers: await authHeaders('user-self'),
      });

      expect(res.statusCode).not.toBe(403);
    });

    it('rejects an unauthenticated caller before the guard is reached', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/kyc/status/user-victim',
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
