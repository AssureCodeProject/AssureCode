/**
 * @assurecode/email-adapter — transactional email port.
 *
 * Why this package exists
 * ------------------------
 * There was no email-sending capability anywhere in this codebase before
 * this: no nodemailer/SES/SMTP dependency, no adapter, nothing. Email
 * verification and password reset both need to deliver a link to a real
 * inbox, so this seam has to exist for either feature to work at all.
 *
 * The only implementation shipped here is a fake, matching exactly how
 * @assurecode/kyc-adapter ships only FakeKycAdapter — "one implementation,
 * no vendor wired" is already this project's documented, honest posture for
 * an integration point nobody has connected to a real provider yet (see
 * ARCHITECTURE.md's Status & Limitations). When a real provider (SES,
 * Postmark, SMTP) is wired in, it implements EmailPort and callers do not
 * change — that is the point of the seam.
 *
 * FakeEmailAdapter deliberately does NOT log anything it sends. A
 * verification/reset link IS the bearer secret for that flow, and this
 * project's own security bar (see auth.ts's routes) is "never log a
 * verification token, a reset token, or anything equivalent." Instead, sent
 * messages are captured in an in-memory array so tests and local
 * development can inspect `getSentEmails()` in-process, without the token
 * ever passing through a log line, log aggregator, or any persisted store.
 */

// ── Port ───────────────────────────────────────────────────────────────

export interface EmailPort {
  sendVerificationEmail(params: { to: string; verifyUrl: string }): Promise<void>;
  sendPasswordResetEmail(params: { to: string; resetUrl: string }): Promise<void>;
}

// ── Factory ────────────────────────────────────────────────────────────

export interface EmailConfig {
  /** Reserved for a future real provider. Ignored today. */
  provider?: 'fake';
}

/**
 * There is exactly one implementation, so this always returns the fake. It
 * exists so call sites read `createEmailAdapter(...)` rather than
 * `new FakeEmailAdapter()` — when a real provider lands, only this function
 * changes.
 */
export function createEmailAdapter(_config: EmailConfig = {}): EmailPort {
  return new FakeEmailAdapter();
}

// ── Fake Adapter ───────────────────────────────────────────────────────

export interface SentEmail {
  to: string;
  kind: 'VERIFICATION' | 'PASSWORD_RESET';
  url: string;
  sentAt: Date;
}

/** Bounded so a long-running process (or a test suite that never calls
 *  clear()) can't grow this without limit. */
const MAX_RETAINED = 500;

export class FakeEmailAdapter implements EmailPort {
  private sent: SentEmail[] = [];

  async sendVerificationEmail(params: { to: string; verifyUrl: string }): Promise<void> {
    this.record({ to: params.to, kind: 'VERIFICATION', url: params.verifyUrl, sentAt: new Date() });
  }

  async sendPasswordResetEmail(params: { to: string; resetUrl: string }): Promise<void> {
    this.record({ to: params.to, kind: 'PASSWORD_RESET', url: params.resetUrl, sentAt: new Date() });
  }

  private record(email: SentEmail): void {
    this.sent.push(email);
    if (this.sent.length > MAX_RETAINED) this.sent.shift();
  }

  /** For tests and local dev — never for anything that ships to a log sink. */
  getSentEmails(): SentEmail[] {
    return this.sent;
  }

  clear(): void {
    this.sent = [];
  }
}
