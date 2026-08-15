/**
 * Tests for the kyc-adapter package.
 *
 * The contract that matters here is that verification is *terminal on the first
 * call*. `requireKycVerified` in the gateway reads `users.kyc_status` from the
 * database and fails closed, so any adapter that answered 'processing' would
 * leave a freelancer polling a session nothing will ever advance — locked out
 * of the payout flow with no way forward. These tests pin that it cannot happen.
 */
import { describe, it, expect } from 'vitest';
import {
  createKycAdapter,
  FakeKycAdapter,
  type KycPort,
  type VerificationStatus,
} from '../src/index.js';

describe('createKycAdapter factory', () => {
  it('returns the fake adapter', () => {
    expect(createKycAdapter()).toBeInstanceOf(FakeKycAdapter);
  });

  it('accepts a config object without complaint', () => {
    expect(createKycAdapter({ provider: 'fake' })).toBeInstanceOf(FakeKycAdapter);
  });

  it('satisfies the KycPort interface', () => {
    const port: KycPort = createKycAdapter();
    expect(typeof port.createVerificationSession).toBe('function');
    expect(typeof port.getVerificationStatus).toBe('function');
    expect(typeof port.createPayoutAccount).toBe('function');
    expect(typeof port.createPayoutOnboardingLink).toBe('function');
  });
});

describe('FakeKycAdapter — verification', () => {
  const adapter = new FakeKycAdapter();

  it('verifies on the first call, with no pending state to poll', async () => {
    const session = await adapter.createVerificationSession({
      userId: 'user-freelancer-1',
      returnUrl: 'http://localhost:3000/kyc-callback',
    });

    // The assertion that matters: not 'requires_input', not 'processing'.
    expect(session.status).toBe('verified');
    expect(session.sessionId).toBe('vs_fake_user-freelancer-1');
    expect(session.userId).toBe('user-freelancer-1');
  });

  it('builds a return URL that agrees with the terminal status', async () => {
    const session = await adapter.createVerificationSession({
      userId: 'user-1',
      returnUrl: 'http://localhost:3000/kyc-callback',
    });

    expect(session.url).toContain('http://localhost:3000/kyc-callback');
    expect(session.url).toContain('status=verified');
    expect(session.url).toContain('session_id=vs_fake_user-1');
  });

  it('percent-encodes ids into the return URL', async () => {
    const session = await adapter.createVerificationSession({
      userId: 'user with spaces&stuff',
      returnUrl: 'http://localhost:3000/kyc-callback',
    });
    expect(session.url).toContain('user%20with%20spaces%26stuff');
  });

  it('is idempotent — the same user always gets the same session id', async () => {
    const first = await adapter.createVerificationSession({
      userId: 'user-2',
      returnUrl: 'http://x/y',
    });
    const second = await adapter.createVerificationSession({
      userId: 'user-2',
      returnUrl: 'http://x/y',
    });
    expect(first.sessionId).toBe(second.sessionId);
  });

  it('reports verified when the session is polled', async () => {
    const status = await adapter.getVerificationStatus('vs_fake_user-3');
    expect(status.status).toBe('verified');
    expect(status.userId).toBe('user-3');
  });

  it('reports verified for a session id it did not issue', async () => {
    // Nothing is stored behind these sessions, so an unknown id must not be a
    // dead end that blocks the caller.
    const status = await adapter.getVerificationStatus('vs_unknown_shape');
    expect(status.status).toBe('verified');
  });

  it.each([['client'], ['freelancer'], ['auditor'], ['admin']])(
    'verifies a %s — the fake is role-blind, matching the route',
    async (role) => {
      const session = await adapter.createVerificationSession({
        userId: `user-${role}`,
        returnUrl: 'http://localhost:3000/kyc-callback',
      });
      const polled = await adapter.getVerificationStatus(session.sessionId);

      expect(session.status).toBe('verified');
      expect(polled.status).toBe('verified');
    },
  );

  it('never returns a non-terminal status from either call', async () => {
    const nonTerminal: VerificationStatus[] = ['requires_input', 'processing'];

    const session = await adapter.createVerificationSession({
      userId: 'user-4',
      returnUrl: 'http://x/y',
    });
    const polled = await adapter.getVerificationStatus(session.sessionId);

    expect(nonTerminal).not.toContain(session.status);
    expect(nonTerminal).not.toContain(polled.status);
  });
});

describe('FakeKycAdapter — payout onboarding', () => {
  const adapter = new FakeKycAdapter();

  it('creates a payout account derived from the user id', async () => {
    const account = await adapter.createPayoutAccount({
      userId: 'user-freelancer-9',
      email: 'freelancer@assurecode.io',
    });
    expect(account.accountId).toBe('acct_fake_user-freelancer-9');
  });

  it('completes onboarding in one hop', async () => {
    const account = await adapter.createPayoutAccount({
      userId: 'user-5',
      email: 'a@b.c',
    });
    const link = await adapter.createPayoutOnboardingLink({
      accountId: account.accountId,
      refreshUrl: 'http://localhost:3000/connect/refresh',
      returnUrl: 'http://localhost:3000/connect/return',
    });

    // No provider form sits behind this, so the link must land already done.
    expect(link.url).toContain('status=completed');
    expect(link.url).toContain('account_id=acct_fake_user-5');
    expect(link.url).toContain('http://localhost:3000/connect/return');
  });

  it('is idempotent — the same user always gets the same account id', async () => {
    const a = await adapter.createPayoutAccount({ userId: 'user-6', email: 'a@b.c' });
    const b = await adapter.createPayoutAccount({ userId: 'user-6', email: 'different@b.c' });
    expect(a.accountId).toBe(b.accountId);
  });
});
