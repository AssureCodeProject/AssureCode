/**
 * @assurecode/razorpay-adapter — Razorpay escrow port + adapters.
 *
 * Hexagonal seam: the gateway and the settlement worker call createOrder /
 * capturePayment / verifyCheckoutSignature / verifyWebhook through the
 * PaymentPort interface. The real adapter talks to Razorpay's REST API; the
 * fake returns deterministic test data and signs with a fixed secret so the
 * HMAC round-trip is exercised offline rather than short-circuited.
 *
 * Escrow model — authorise now, capture later
 * -------------------------------------------
 * Orders are created with `payment_capture: 0`. The customer's payment then
 * settles at status `authorized`: the funds are held on their card but have not
 * moved. Only `POST /payments/:id/capture` — which the settlement oracle calls
 * once the four CI signals pass — actually takes the money. That is what makes
 * the escrow real, and it is the direct analogue of Stripe's
 * `capture_method: 'manual'` that this package replaces.
 *
 * Operational caveat: Razorpay auto-refunds an authorised-but-uncaptured
 * payment after roughly five days. A contract that never reaches a verdict
 * returns the client's money rather than holding it indefinitely.
 *
 * Amounts are always in the currency's *minor* unit — paise for INR. Never
 * pass rupees.
 *
 * Usage:
 *   import { createRazorpayAdapter } from '@assurecode/razorpay-adapter';
 *   const payments = createRazorpayAdapter({ keyId: 'rzp_test_...', keySecret: '...', webhookSecret: '...' });
 *   const order = await payments.createOrder({ amountMinor: 50000, currency: 'INR', contractId: 'AC-...' });
 */

import crypto from 'node:crypto';

const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';

/** How long any single Razorpay API call may take. Matches the gateway's other outbound calls. */
const REQUEST_TIMEOUT_MS = 10_000;

// ── Domain types ───────────────────────────────────────────────────────

/**
 * Razorpay's payment lifecycle.
 *
 * `authorized` is the escrow state: money held, not taken. `captured` is the
 * release. There is no state between them, which is why the settlement worker
 * can treat capture as an atomic release.
 */
export type PaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';

/** Razorpay's order lifecycle. `paid` means an associated payment reached authorized or captured. */
export type OrderStatus = 'created' | 'attempted' | 'paid';

export interface OrderResult {
  orderId: string;
  amountMinor: number;
  currency: string;
  status: OrderStatus;
  contractId: string;
  receipt: string | null;
}

export interface PaymentResult {
  paymentId: string;
  /** Null only for payments created outside an order, which this system never does. */
  orderId: string | null;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
  captured: boolean;
  /** Read from the payment's notes. Empty when Razorpay did not carry them over; the escrow table is authoritative. */
  contractId: string;
  errorDescription?: string;
}

export interface RefundResult {
  refundId: string;
  paymentId: string;
  amountMinor: number;
  status: string;
}

/**
 * A verified webhook.
 *
 * Note there is no `id` here: unlike Stripe, Razorpay does not put an event id
 * in the webhook body. It arrives in the `x-razorpay-event-id` header, and the
 * caller is responsible for reading it — see the dedupe note on the gateway's
 * /webhooks/razorpay route.
 */
export interface RazorpayWebhookEvent {
  /** e.g. 'payment.authorized', 'payment.captured', 'payment.failed', 'order.paid'. */
  event: string;
  accountId?: string;
  payload: {
    payment?: { entity: Record<string, unknown> };
    order?: { entity: Record<string, unknown> };
    refund?: { entity: Record<string, unknown> };
  };
  createdAt?: number;
}

export interface WebhookVerificationResult {
  valid: boolean;
  event: RazorpayWebhookEvent | null;
  error?: string;
}

// ── Port ───────────────────────────────────────────────────────────────

export interface PaymentPort {
  /**
   * Create an order for escrow funding. The order is what Checkout opens
   * against; no money is involved until the customer pays it.
   */
  createOrder(params: {
    amountMinor: number;
    currency: string;
    contractId: string;
    receipt?: string;
    notes?: Record<string, string>;
  }): Promise<OrderResult>;

  /** Read a payment's current state. Used to confirm `authorized` before trusting a client callback. */
  fetchPayment(paymentId: string): Promise<PaymentResult>;

  /** Take the held funds. This is the escrow release. */
  capturePayment(params: {
    paymentId: string;
    amountMinor: number;
    currency: string;
  }): Promise<PaymentResult>;

  /** Return funds to the client. Omit amountMinor for a full refund. */
  refundPayment(params: { paymentId: string; amountMinor?: number }): Promise<RefundResult>;

  /**
   * Verify the signature Checkout hands back to the browser on success:
   * HMAC_SHA256(`${orderId}|${paymentId}`, key_secret).
   *
   * Synchronous and constant-time. This is what lets escrow funding be
   * confirmed without a publicly reachable webhook URL.
   */
  verifyCheckoutSignature(params: {
    orderId: string;
    paymentId: string;
    signature: string;
  }): boolean;

  /**
   * Verify an inbound webhook: HMAC_SHA256(rawBody, webhook_secret), hex,
   * compared against the `x-razorpay-signature` header.
   *
   * `payload` must be the exact bytes Razorpay sent. Re-serialising a parsed
   * body produces different bytes and the HMAC will never match.
   */
  verifyWebhook(payload: string | Buffer, signature: string): Promise<WebhookVerificationResult>;
}

// ── Configuration ──────────────────────────────────────────────────────

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  isTest?: boolean;
}

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Returns the real adapter only when the credentials could plausibly work.
 *
 * The `rzp_` prefix check is load-bearing beyond tidiness: the Kubernetes
 * Secret ships with every value set to the literal `REPLACE_ME`, which is
 * non-empty. A bare truthiness test would accept it, hand it to the real
 * adapter, and fail on the first API call in production — or, worse under the
 * old Stripe arrangement, silently select the fake and let a production
 * deployment pretend to move money. Prefix-checking makes the placeholder land
 * unambiguously on the fake, and the gateway's boot guard refuses to start in
 * production when the fake is what it got.
 */
export function createRazorpayAdapter(config: RazorpayConfig): PaymentPort {
  if (
    !config.keyId ||
    !config.keySecret ||
    !config.keyId.startsWith('rzp_') ||
    config.keyId.includes('mock') ||
    config.keyId.includes('...') ||
    config.isTest
  ) {
    return new FakeRazorpayAdapter(config.webhookSecret || FAKE_WEBHOOK_SECRET);
  }
  return new RazorpayPaymentAdapter(config);
}

/** True when the given config would produce a live adapter. Used by boot-time guards. */
export function isLiveRazorpayConfig(config: RazorpayConfig): boolean {
  return !(createRazorpayAdapter(config) instanceof FakeRazorpayAdapter);
}

// ── Signature helpers ──────────────────────────────────────────────────

/**
 * Constant-time hex HMAC comparison.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, which a
 * malformed or truncated signature will do — hence the try/catch rather than a
 * length check that would itself leak. Modelled on verifyGitHubSignature in
 * apps/webhook-ingest.
 */
function hmacMatches(expectedHex: string, providedHex: string): boolean {
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedHex, 'hex'),
      Buffer.from(providedHex, 'hex'),
    );
  } catch {
    return false;
  }
}

function signCheckout(orderId: string, paymentId: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

function signWebhook(payload: string | Buffer, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return hmac.digest('hex');
}

/**
 * Exported so tests and tooling can construct genuine signatures rather than
 * asserting against a stubbed verifier — a verifier that is only ever fed its
 * own output proves nothing.
 */
export const signatures = {
  checkout: signCheckout,
  webhook: signWebhook,
};

// ── Shared parsing ─────────────────────────────────────────────────────

function readContractId(entity: Record<string, any>): string {
  const notes = entity?.notes;
  if (notes && typeof notes === 'object' && typeof notes.contractId === 'string') {
    return notes.contractId;
  }
  return '';
}

function toPaymentResult(entity: Record<string, any>): PaymentResult {
  return {
    paymentId: String(entity.id),
    orderId: entity.order_id ? String(entity.order_id) : null,
    amountMinor: Number(entity.amount ?? 0),
    currency: String(entity.currency ?? 'INR'),
    status: entity.status as PaymentStatus,
    captured: Boolean(entity.captured),
    contractId: readContractId(entity),
    ...(entity.error_description ? { errorDescription: String(entity.error_description) } : {}),
  };
}

/** Parse a webhook body into the shape the gateway switches on. Shared by both adapters. */
function toWebhookEvent(parsed: Record<string, any>): RazorpayWebhookEvent {
  return {
    event: String(parsed.event ?? ''),
    accountId: parsed.account_id ? String(parsed.account_id) : undefined,
    payload: (parsed.payload ?? {}) as RazorpayWebhookEvent['payload'],
    createdAt: typeof parsed.created_at === 'number' ? parsed.created_at : undefined,
  };
}

/** Pull the payment entity out of any event shape that carries one. */
export function paymentEntityOf(event: RazorpayWebhookEvent): Record<string, any> | null {
  return (event.payload?.payment?.entity as Record<string, any>) ?? null;
}

/** Pull the order entity out of any event shape that carries one. */
export function orderEntityOf(event: RazorpayWebhookEvent): Record<string, any> | null {
  return (event.payload?.order?.entity as Record<string, any>) ?? null;
}

// ── Real Razorpay Adapter ──────────────────────────────────────────────

/** Razorpay's error envelope, raised with enough detail to be actionable in a log. */
export class RazorpayApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'RazorpayApiError';
  }
}

/**
 * Talks to Razorpay's REST API directly with `fetch` rather than through the
 * official SDK.
 *
 * The four calls this system makes are plain Basic-auth JSON requests, and
 * every other outbound call in this repo is written the same way (see
 * callAiService in the gateway). Taking the SDK would add a dependency and its
 * transitive tree to a repo that gates CI on `npm audit`, in exchange for
 * partial TypeScript types that the Stripe adapter had to cast away anyway.
 */
export class RazorpayPaymentAdapter implements PaymentPort {
  private readonly authHeader: string;
  private readonly webhookSecret: string;
  private readonly keySecret: string;

  constructor(config: RazorpayConfig) {
    this.keySecret = config.keySecret;
    this.webhookSecret = config.webhookSecret;
    this.authHeader = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${RAZORPAY_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      // A network failure or timeout is not an API error; distinguishing them
      // matters because the caller retries one and not the other.
      const msg = err instanceof Error ? err.message : String(err);
      throw new RazorpayApiError(`Razorpay request failed: ${msg}`, 0);
    }

    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Fall through — a non-JSON body from Razorpay is itself the error detail.
    }

    if (!res.ok) {
      const e = parsed?.error ?? {};
      throw new RazorpayApiError(
        e.description || `Razorpay ${method} ${path} returned ${res.status}`,
        res.status,
        e.code,
        e.reason,
      );
    }

    return parsed as T;
  }

  async createOrder(params: {
    amountMinor: number;
    currency: string;
    contractId: string;
    receipt?: string;
    notes?: Record<string, string>;
  }): Promise<OrderResult> {
    const entity = await this.request<Record<string, any>>('POST', '/orders', {
      amount: params.amountMinor,
      currency: params.currency,
      // Razorpay truncates receipts over 40 chars with a 400 rather than
      // silently, so keep contract ids inside the limit.
      receipt: (params.receipt ?? params.contractId).slice(0, 40),
      // 0 means "do not auto-capture": the payment stops at `authorized` and
      // the funds stay held until we capture. This single flag is the escrow.
      payment_capture: 0,
      notes: { contractId: params.contractId, ...params.notes },
    });

    return {
      orderId: String(entity.id),
      amountMinor: Number(entity.amount),
      currency: String(entity.currency),
      status: entity.status as OrderStatus,
      contractId: params.contractId,
      receipt: entity.receipt ? String(entity.receipt) : null,
    };
  }

  async fetchPayment(paymentId: string): Promise<PaymentResult> {
    const entity = await this.request<Record<string, any>>('GET', `/payments/${paymentId}`);
    return toPaymentResult(entity);
  }

  async capturePayment(params: {
    paymentId: string;
    amountMinor: number;
    currency: string;
  }): Promise<PaymentResult> {
    // Amount and currency are mandatory on capture and must match the
    // authorisation: Razorpay rejects a mismatch rather than capturing a
    // partial amount by accident.
    const entity = await this.request<Record<string, any>>(
      'POST',
      `/payments/${params.paymentId}/capture`,
      { amount: params.amountMinor, currency: params.currency },
    );
    return toPaymentResult(entity);
  }

  async refundPayment(params: { paymentId: string; amountMinor?: number }): Promise<RefundResult> {
    const entity = await this.request<Record<string, any>>(
      'POST',
      `/payments/${params.paymentId}/refund`,
      params.amountMinor === undefined ? {} : { amount: params.amountMinor },
    );
    return {
      refundId: String(entity.id),
      paymentId: String(entity.payment_id ?? params.paymentId),
      amountMinor: Number(entity.amount ?? 0),
      status: String(entity.status ?? 'unknown'),
    };
  }

  verifyCheckoutSignature(params: {
    orderId: string;
    paymentId: string;
    signature: string;
  }): boolean {
    if (!params.orderId || !params.paymentId || !params.signature) return false;
    const expected = signCheckout(params.orderId, params.paymentId, this.keySecret);
    return hmacMatches(expected, params.signature);
  }

  async verifyWebhook(
    payload: string | Buffer,
    signature: string,
  ): Promise<WebhookVerificationResult> {
    if (!this.webhookSecret) {
      return { valid: false, event: null, error: 'No webhook secret configured' };
    }
    if (!signature) {
      return { valid: false, event: null, error: 'Missing signature header' };
    }

    const expected = signWebhook(payload, this.webhookSecret);
    if (!hmacMatches(expected, signature)) {
      return { valid: false, event: null, error: 'Signature mismatch' };
    }

    // Only parse after the signature checks out — parsing first would mean
    // spending work on, and logging the shape of, unauthenticated input.
    try {
      const parsed = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
      return { valid: true, event: toWebhookEvent(parsed) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, event: null, error: `Signed body was not JSON: ${msg}` };
    }
  }
}

// ── Fake Adapter ───────────────────────────────────────────────────────

/**
 * The secret the fake signs with when none is configured.
 *
 * The fake verifies real HMACs rather than waving signatures through. A fake
 * that returned `valid: true` unconditionally would let a signature bug reach
 * production untested, and one that returned `valid: false` unconditionally
 * would make the offline end-to-end flow untestable — the Stripe fake did the
 * latter, which is why no test ever covered the webhook route's happy path.
 */
export const FAKE_WEBHOOK_SECRET = 'razorpay_fake_webhook_secret';

/** The key secret the fake signs checkout callbacks with, so tests can construct valid ones. */
export const FAKE_KEY_SECRET = 'razorpay_fake_key_secret';

export class FakeRazorpayAdapter implements PaymentPort {
  /** Orders and payments this instance has issued, so state transitions behave. */
  private readonly orders = new Map<string, OrderResult>();
  private readonly payments = new Map<string, PaymentResult>();
  private seq = 0;

  constructor(private readonly webhookSecret: string = FAKE_WEBHOOK_SECRET) {}

  async createOrder(params: {
    amountMinor: number;
    currency: string;
    contractId: string;
    receipt?: string;
    notes?: Record<string, string>;
  }): Promise<OrderResult> {
    const order: OrderResult = {
      orderId: `order_fake_${params.contractId}_${++this.seq}`,
      amountMinor: params.amountMinor,
      currency: params.currency,
      status: 'created',
      contractId: params.contractId,
      receipt: params.receipt ?? params.contractId,
    };
    this.orders.set(order.orderId, order);
    return order;
  }

  /**
   * Simulate the customer paying an order, which in production is Checkout's
   * job. Test-only — it is not on PaymentPort, so no production code can reach
   * it through the interface.
   */
  async simulateAuthorization(orderId: string): Promise<PaymentResult> {
    const order = this.orders.get(orderId);
    const payment: PaymentResult = {
      paymentId: `pay_fake_${++this.seq}`,
      orderId,
      amountMinor: order?.amountMinor ?? 0,
      currency: order?.currency ?? 'INR',
      status: 'authorized',
      captured: false,
      contractId: order?.contractId ?? '',
    };
    this.payments.set(payment.paymentId, payment);
    return payment;
  }

  async fetchPayment(paymentId: string): Promise<PaymentResult> {
    const known = this.payments.get(paymentId);
    if (known) return known;
    // An unknown id still resolves as authorized so offline flows that never
    // called simulateAuthorization (benchmarks, e2e harnesses) keep working.
    return {
      paymentId,
      orderId: null,
      amountMinor: 0,
      currency: 'INR',
      status: 'authorized',
      captured: false,
      contractId: '',
    };
  }

  async capturePayment(params: {
    paymentId: string;
    amountMinor: number;
    currency: string;
  }): Promise<PaymentResult> {
    const existing = this.payments.get(params.paymentId);
    const captured: PaymentResult = {
      paymentId: params.paymentId,
      orderId: existing?.orderId ?? null,
      amountMinor: params.amountMinor,
      currency: params.currency,
      status: 'captured',
      captured: true,
      contractId: existing?.contractId ?? '',
    };
    this.payments.set(params.paymentId, captured);
    return captured;
  }

  async refundPayment(params: { paymentId: string; amountMinor?: number }): Promise<RefundResult> {
    const existing = this.payments.get(params.paymentId);
    return {
      refundId: `rfnd_fake_${++this.seq}`,
      paymentId: params.paymentId,
      amountMinor: params.amountMinor ?? existing?.amountMinor ?? 0,
      status: 'processed',
    };
  }

  verifyCheckoutSignature(params: {
    orderId: string;
    paymentId: string;
    signature: string;
  }): boolean {
    if (!params.orderId || !params.paymentId || !params.signature) return false;
    const expected = signCheckout(params.orderId, params.paymentId, FAKE_KEY_SECRET);
    return hmacMatches(expected, params.signature);
  }

  async verifyWebhook(
    payload: string | Buffer,
    signature: string,
  ): Promise<WebhookVerificationResult> {
    if (!signature) {
      return { valid: false, event: null, error: 'Missing signature header' };
    }
    const expected = signWebhook(payload, this.webhookSecret);
    if (!hmacMatches(expected, signature)) {
      return { valid: false, event: null, error: 'Signature mismatch' };
    }
    try {
      const parsed = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
      return { valid: true, event: toWebhookEvent(parsed) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, event: null, error: `Signed body was not JSON: ${msg}` };
    }
  }
}
