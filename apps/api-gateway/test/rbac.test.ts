/**
 * The authorization layer on the money routes.
 *
 * `requireRole` and `requireKycVerified` are the two preHandlers standing
 * between an authenticated request and escrow creation, escrow verification and
 * settlement (`clientVerified` and `settlementGuards` in server.ts). They had
 * no direct test — `kyc-ownership.test.ts` covers the *ownership* guard on the
 * KYC routes, which is a different control.
 *
 * Each guard is exercised against a stub request/reply rather than through a
 * route, because what matters here is the decision, and going through a route
 * would mean every assertion also depended on that route's own behaviour.
 *
 * Three properties are load-bearing and each is asserted:
 *
 *   1. Service callers pass both guards. They authenticate with SERVICE_TOKEN
 *      and have no user identity, so a naive "no user means 401" would break
 *      every tools/ script the moment a guard was attached.
 *   2. KYC status is read from the database, never from the JWT claim. A token
 *      is a snapshot: a claim-based check refuses users who just verified, and
 *      keeps honouring VERIFIED for a user whose status was revoked.
 *   3. An unreadable status is not a verified one. Failing closed is the only
 *      safe direction for a gate on moving money.
 */
import { describe, it, expect, vi } from 'vitest';
import { requireRole, requireKycVerified } from '../src/middleware/rbac.js';

/** A reply stub that records the status and body a guard chose. */
function replyStub() {
  const state: { status?: number; body?: any } = {};
  const reply: any = {
    status(code: number) {
      state.status = code;
      return reply;
    },
    send(body: any) {
      state.body = body;
      return reply;
    },
  };
  return { reply, state };
}

const asUser = (role: string, userId = 'u-1') => ({ user: { userId, role }, log: { error: vi.fn() } });
const asService = () => ({ isServiceCaller: true, log: { error: vi.fn() } });
const anonymous = () => ({ log: { error: vi.fn() } });

/** A pg.Pool stand-in that answers one kyc_status lookup. */
function poolReturning(rows: Array<{ kyc_status: string }>) {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) } as any;
}

describe('requireRole', () => {
  it('admits a user whose role is allowed', async () => {
    const { reply, state } = replyStub();
    await requireRole(['client'])(asUser('client') as any, reply);
    // A guard that admits says nothing — no status was ever set.
    expect(state.status).toBeUndefined();
  });

  it('admits a service caller, which has no user identity at all', async () => {
    const { reply, state } = replyStub();
    await requireRole(['client'])(asService() as any, reply);
    expect(state.status).toBeUndefined();
  });

  it('answers 401 when there is no user and no service token', async () => {
    const { reply, state } = replyStub();
    await requireRole(['client'])(anonymous() as any, reply);
    expect(state.status).toBe(401);
  });

  it('answers 403 for a real user in the wrong role, naming the roles allowed', async () => {
    const { reply, state } = replyStub();
    await requireRole(['client', 'admin'])(asUser('freelancer') as any, reply);

    expect(state.status).toBe(403);
    // 403 not 401: the caller is authenticated, just not permitted. Collapsing
    // the two sends them off to re-authenticate over a problem login cannot fix.
    expect(state.body.message).toContain('freelancer');
    expect(state.body.message).toContain('client, admin');
  });

  it('admits any of several allowed roles', async () => {
    for (const role of ['client', 'admin']) {
      const { reply, state } = replyStub();
      await requireRole(['client', 'admin'])(asUser(role) as any, reply);
      expect(state.status, `role ${role} should be admitted`).toBeUndefined();
    }
  });
});

describe('requireKycVerified', () => {
  it('admits a service caller without touching the database', async () => {
    const pool = poolReturning([]);
    const { reply, state } = replyStub();

    await requireKycVerified(pool)(asService() as any, reply);

    expect(state.status).toBeUndefined();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('answers 401 when there is no user', async () => {
    const { reply, state } = replyStub();
    await requireKycVerified(poolReturning([]))(anonymous() as any, reply);
    expect(state.status).toBe(401);
  });

  it('reads the status from the database, not from the token', async () => {
    const pool = poolReturning([{ kyc_status: 'VERIFIED' }]);
    const { reply, state } = replyStub();

    // The request carries no kycStatus claim at all — if the guard were
    // claim-based this would have to refuse.
    await requireKycVerified(pool)(asUser('client') as any, reply);

    expect(state.status).toBeUndefined();
    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.query.mock.calls[0][0]).toMatch(/kyc_status/);
  });

  it.each(['UNVERIFIED', 'PENDING', 'REJECTED'])('answers 403 for status %s', async (status) => {
    const { reply, state } = replyStub();
    await requireKycVerified(poolReturning([{ kyc_status: status }]))(asUser('client') as any, reply);

    expect(state.status).toBe(403);
    expect(state.body.error).toBe('KYC_REQUIRED');
    // The current status travels with the refusal so the UI can say what to do
    // next rather than just that something was refused.
    expect(state.body.kycStatus).toBe(status);
  });

  it('answers 401 when the token names an account that no longer exists', async () => {
    const { reply, state } = replyStub();
    await requireKycVerified(poolReturning([]))(asUser('client') as any, reply);
    expect(state.status).toBe(401);
  });

  it('fails closed when the status cannot be read', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection lost')) } as any;
    const { reply, state } = replyStub();

    await requireKycVerified(pool)(asUser('client') as any, reply);

    // 503, not 403 and certainly not a pass: an unreadable compliance status is
    // not a verified one, and it is also not a definitive refusal — the caller
    // should retry, not be told they failed KYC.
    expect(state.status).toBe(503);
    expect(state.body.error).toBe('KYC_CHECK_UNAVAILABLE');
  });
});
