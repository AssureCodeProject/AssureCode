/**
 * Ownership guards on the three routes that take a caller-supplied `userId`.
 *
 * /api/kyc/verify had an inline check; /api/kyc/status/:userId and
 * /api/kyc/connect-onboarding had none. That meant any authenticated user
 * could read another account's compliance record, and open a payout-account
 * onboarding flow in someone else's name, just by changing an ID in the
 * request.
 *
 * The denial happens before any database access, so these run without
 * PostgreSQL.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import server from '../src/server.js';

type Role = 'client' | 'freelancer' | 'auditor' | 'admin';

function tokenFor(userId: string, role: Role = 'freelancer'): string {
  return (server as any).jwt.sign({
    sub: userId,
    email: `${userId}@example.test`,
    role,
    kycStatus: 'UNVERIFIED',
    mfaEnabled: false,
  });
}

function authHeaders(userId: string, role: Role = 'freelancer'): Record<string, string> {
  return { authorization: `Bearer ${tokenFor(userId, role)}` };
}

beforeAll(async () => {
  // jwt.sign is only decorated onto the instance once plugins have registered.
  await server.ready();
});

describe('KYC route ownership guards', () => {
  describe('POST /api/kyc/verify', () => {
    it('rejects verifying somebody else', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/kyc/verify',
        headers: authHeaders('user-attacker'),
        payload: { userId: 'user-victim', idType: 'PASSPORT' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Forbidden');
    });

    it('still validates the payload before deciding', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/kyc/verify',
        headers: authHeaders('user-a'),
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
        headers: authHeaders('user-attacker'),
      });

      expect(res.statusCode).toBe(403);
    });

    it('does not leak whether the target account exists', async () => {
      // Both a real and an invented ID must answer identically, or the
      // status code itself becomes a user-enumeration oracle.
      const real = await server.inject({
        method: 'GET',
        url: '/api/kyc/status/legacy-client',
        headers: authHeaders('user-attacker'),
      });
      const invented = await server.inject({
        method: 'GET',
        url: '/api/kyc/status/no-such-user-at-all',
        headers: authHeaders('user-attacker'),
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
        headers: authHeaders('user-attacker'),
        payload: { userId: 'user-victim', email: 'victim@example.test' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('requires a userId', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/kyc/connect-onboarding',
        headers: authHeaders('user-a'),
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
        headers: authHeaders('user-admin', 'admin'),
      });

      expect(res.statusCode).not.toBe(403);
    });

    it('a user may act on themselves', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/kyc/status/user-self',
        headers: authHeaders('user-self'),
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
