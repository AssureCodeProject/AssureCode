/**
 * @assurecode/kyc-adapter — identity verification & payout onboarding port.
 *
 * Why this package exists
 * ----------------------
 * These four operations used to hang off `EscrowPort` in the Stripe adapter,
 * because Stripe happens to sell identity verification (Stripe Identity) and
 * payout onboarding (Connect Express) alongside payments. That coupling was an
 * accident of the vendor, not a property of the domain: Razorpay sells no
 * equivalent, so keeping KYC on the payment port would have forced the payment
 * adapter to carry four methods it cannot implement.
 *
 * Identity verification is now its own seam with its own port. The only
 * implementation is a fake, which is the honest arrangement — the gateway's
 * /api/kyc/verify route has always written `kyc_status = 'VERIFIED'`
 * unconditionally, so no provider verdict was ever consulted. Naming it
 * `FakeKycAdapter` states in the type system what the route was already doing.
 *
 * When a real provider is wired in (Digio, HyperVerge, Signzy — the usual
 * choices alongside Razorpay in India), it implements KycPort and the routes do
 * not change. That is the point of the seam.
 */

// ── Domain types ───────────────────────────────────────────────────────

/**
 * Mirrors `users.kyc_status` in the database, minus 'UNVERIFIED' — a session
 * that exists has at least been started. See V011__kyc_compliance_and_enterprise_auth.sql.
 */
export type VerificationStatus = 'requires_input' | 'processing' | 'verified' | 'canceled';

export interface VerificationSession {
  sessionId: string;
  /** Where to send the user to complete verification. */
  url: string;
  status: VerificationStatus;
  userId?: string;
}

export interface PayoutAccount {
  accountId: string;
}

export interface PayoutOnboardingLink {
  url: string;
}

// ── Port ───────────────────────────────────────────────────────────────

export interface KycPort {
  /** Begin identity verification for a user. */
  createVerificationSession(params: {
    userId: string;
    returnUrl: string;
  }): Promise<VerificationSession>;

  /** Poll an existing verification session. */
  getVerificationStatus(sessionId: string): Promise<VerificationSession>;

  /** Create the account a freelancer's payouts would be sent to. */
  createPayoutAccount(params: { userId: string; email: string }): Promise<PayoutAccount>;

  /** Generate the onboarding link that completes payout-account setup. */
  createPayoutOnboardingLink(params: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<PayoutOnboardingLink>;
}

// ── Factory ────────────────────────────────────────────────────────────

export interface KycConfig {
  /** Reserved for a future real provider. Ignored today. */
  provider?: 'fake';
}

/**
 * There is exactly one implementation, so this always returns the fake. It
 * exists so call sites read `createKycAdapter(...)` rather than
 * `new FakeKycAdapter()` — when a real provider lands, only this function
 * changes, not the gateway.
 */
export function createKycAdapter(_config: KycConfig = {}): KycPort {
  return new FakeKycAdapter();
}

// ── Fake Adapter ───────────────────────────────────────────────────────

/**
 * Approves everything, immediately.
 *
 * Deliberately terminal rather than pending: a `requires_input` or `processing`
 * result would leave the caller polling a session that will never advance,
 * because nothing is behind it. Returning 'verified' on the first call is what
 * lets a freelancer clear `requireKycVerified` in one hop and go on to receive
 * a simulated escrow payout without a stalled compliance gate in the way.
 *
 * Session and account ids are derived from the user id rather than randomised,
 * so the same user gets the same ids across calls and a re-run of the flow is
 * idempotent from the caller's point of view.
 */
export class FakeKycAdapter implements KycPort {
  async createVerificationSession(params: {
    userId: string;
    returnUrl: string;
  }): Promise<VerificationSession> {
    const sessionId = `vs_fake_${params.userId}`;
    return {
      sessionId,
      // Carries the terminal status in the URL so a caller that redirects the
      // user lands somewhere self-consistent rather than on a pending screen.
      url: `${params.returnUrl}?session_id=${encodeURIComponent(sessionId)}&status=verified`,
      status: 'verified',
      userId: params.userId,
    };
  }

  async getVerificationStatus(sessionId: string): Promise<VerificationSession> {
    return {
      sessionId,
      url: '',
      status: 'verified',
      // `vs_fake_<userId>` — recover the user id so the response is complete.
      userId: sessionId.startsWith('vs_fake_') ? sessionId.slice('vs_fake_'.length) : undefined,
    };
  }

  async createPayoutAccount(params: { userId: string; email: string }): Promise<PayoutAccount> {
    return { accountId: `acct_fake_${params.userId}` };
  }

  async createPayoutOnboardingLink(params: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<PayoutOnboardingLink> {
    // `status=completed` so a freelancer following the link is done in one hop
    // instead of bouncing through a provider form that does not exist.
    return {
      url: `${params.returnUrl}?account_id=${encodeURIComponent(params.accountId)}&status=completed`,
    };
  }
}
