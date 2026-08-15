/**
 * Tests for the razorpay-adapter package.
 *
 * Two signatures matter in this integration and they are not interchangeable:
 *
 *   - the *checkout* signature, HMAC over `${orderId}|${paymentId}` keyed by the
 *     API key secret, which the browser hands back after a successful payment;
 *   - the *webhook* signature, HMAC over the raw request body keyed by the
 *     separate webhook secret, which arrives in `x-razorpay-signature`.
 *
 * Mixing up the key or the message produces a verifier that rejects everything
 * genuine, so both are pinned here against signatures built independently with
 * node:crypto rather than by calling the code under test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createRazorpayAdapter,
  isLiveRazorpayConfig,
  FakeRazorpayAdapter,
  RazorpayPaymentAdapter,
  FAKE_KEY_SECRET,
  FAKE_WEBHOOK_SECRET,
  paymentEntityOf,
  type PaymentPort,
} from '../src/index.js';

const KEY_SECRET = 'rzp_test_key_secret_for_signature_checks';
const WEBHOOK_SECRET = 'whsec_razorpay_test_secret';

/** Build a checkout signature the way Razorpay's docs specify. */
function signCheckout(orderId: string, paymentId: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

/** Build an `x-razorpay-signature` header value. */
function signWebhook(rawBody: string | Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

const liveAdapter = new RazorpayPaymentAdapter({
  keyId: 'rzp_test_not_used_for_signature_checks',
  keySecret: KEY_SECRET,
  webhookSecret: WEBHOOK_SECRET,
});

describe('checkout signature verification', () => {
  const orderId = 'order_TESTabc123';
  const paymentId = 'pay_TESTxyz789';

  it('accepts a signature built over `orderId|paymentId`', () => {
    const signature = signCheckout(orderId, paymentId, KEY_SECRET);
    expect(liveAdapter.verifyCheckoutSignature({ orderId, paymentId, signature })).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    const signature = signCheckout(orderId, paymentId, 'some_other_secret');
    expect(liveAdapter.verifyCheckoutSignature({ orderId, paymentId, signature })).toBe(false);
  });

  it('rejects when the order and payment are swapped — the message is ordered', () => {
    const signature = signCheckout(paymentId, orderId, KEY_SECRET);
    expect(liveAdapter.verifyCheckoutSignature({ orderId, paymentId, signature })).toBe(false);
  });

  it('rejects a signature for a different payment against the same order', () => {
    const signature = signCheckout(orderId, 'pay_SOMEONE_ELSE', KEY_SECRET);
    expect(liveAdapter.verifyCheckoutSignature({ orderId, paymentId, signature })).toBe(false);
  });

  it('rejects a truncated signature without throwing', () => {
    // timingSafeEqual throws on a length mismatch; the adapter must absorb that
    // rather than 500 on malformed client input.
    const signature = signCheckout(orderId, paymentId, KEY_SECRET).slice(0, 32);
    expect(liveAdapter.verifyCheckoutSignature({ orderId, paymentId, signature })).toBe(false);
  });

  it('rejects non-hex garbage without throwing', () => {
    expect(
      liveAdapter.verifyCheckoutSignature({ orderId, paymentId, signature: 'not-hex-at-all!!' }),
    ).toBe(false);
  });

  it.each([
    ['empty signature', { orderId, paymentId, signature: '' }],
    ['empty orderId', { orderId: '', paymentId, signature: 'ab'.repeat(32) }],
    ['empty paymentId', { orderId, paymentId: '', signature: 'ab'.repeat(32) }],
  ])('rejects %s', (_label, params) => {
    expect(liveAdapter.verifyCheckoutSignature(params)).toBe(false);
  });
});

/**
 * The stripe-adapter carried a regression test for verifying against
 * `JSON.stringify(request.body)` instead of the bytes on the wire — same JSON
 * value, different bytes, so every genuine webhook 401'd. The gateway's raw-body
 * content-type parser is shared, so the identical mistake is available here.
 */
describe('webhook signature — raw bytes vs re-serialised', () => {
  const RAW_BODY =
    '{\n  "event": "payment.authorized",\n  "account_id": "acc_TEST",\n' +
    '  "payload": { "payment": { "entity": { "id": "pay_TEST1", "order_id": "order_TEST1",\n' +
    '    "status": "authorized", "amount": 50000, "currency": "INR",\n' +
    '    "notes": { "contractId": "AC-1" } } } }\n}';

  it('accepts the exact bytes that were signed', async () => {
    const result = await liveAdapter.verifyWebhook(RAW_BODY, signWebhook(RAW_BODY, WEBHOOK_SECRET));

    expect(result.valid).toBe(true);
    expect(result.event?.event).toBe('payment.authorized');
    expect(paymentEntityOf(result.event!)?.id).toBe('pay_TEST1');
  });

  it('accepts a Buffer of those bytes, which is what the route passes', async () => {
    const raw = Buffer.from(RAW_BODY, 'utf8');
    const result = await liveAdapter.verifyWebhook(raw, signWebhook(raw, WEBHOOK_SECRET));

    expect(result.valid).toBe(true);
    expect(result.event?.event).toBe('payment.authorized');
  });

  it('rejects a re-serialised body — same JSON value, different bytes', async () => {
    const signature = signWebhook(RAW_BODY, WEBHOOK_SECRET);
    const reSerialised = JSON.stringify(JSON.parse(RAW_BODY));

    expect(reSerialised).not.toBe(RAW_BODY);

    const result = await liveAdapter.verifyWebhook(reSerialised, signature);
    expect(result.valid).toBe(false);
    expect(result.event).toBeNull();
  });

  it('rejects a body signed with the API key secret instead of the webhook secret', async () => {
    // The two secrets are different values for different purposes; using one
    // where the other belongs is the likeliest configuration mistake.
    const result = await liveAdapter.verifyWebhook(RAW_BODY, signWebhook(RAW_BODY, KEY_SECRET));
    expect(result.valid).toBe(false);
  });

  it('rejects a tampered body under a valid-looking signature', async () => {
    const signature = signWebhook(RAW_BODY, WEBHOOK_SECRET);
    const tampered = RAW_BODY.replace('"amount": 50000', '"amount": 1');

    const result = await liveAdapter.verifyWebhook(tampered, signature);
    expect(result.valid).toBe(false);
  });

  it('rejects a missing signature header', async () => {
    const result = await liveAdapter.verifyWebhook(RAW_BODY, '');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/missing signature/i);
  });

  it('refuses to verify at all when no webhook secret is configured', async () => {
    const unconfigured = new RazorpayPaymentAdapter({
      keyId: 'rzp_test_x',
      keySecret: KEY_SECRET,
      webhookSecret: '',
    });
    const result = await unconfigured.verifyWebhook(RAW_BODY, signWebhook(RAW_BODY, ''));

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/no webhook secret/i);
  });

  it('reports a correctly signed body that is not JSON rather than accepting it', async () => {
    const notJson = 'this passed the HMAC but is not an event';
    const result = await liveAdapter.verifyWebhook(notJson, signWebhook(notJson, WEBHOOK_SECRET));

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not JSON/i);
  });
});

describe('createRazorpayAdapter factory', () => {
  const base = { keyId: 'rzp_test_abc', keySecret: 'secret', webhookSecret: 'whsec' };

  it.each([
    ['keyId is empty', { ...base, keyId: '' }],
    ['keySecret is empty', { ...base, keySecret: '' }],
    ['keyId lacks the rzp_ prefix', { ...base, keyId: 'not-a-key' }],
    ['keyId is a mock', { ...base, keyId: 'rzp_test_mock' }],
    ['keyId is an unfilled template', { ...base, keyId: 'rzp_test_...' }],
    ['isTest is set', { ...base, isTest: true }],
  ])('returns the fake when %s', (_label, config) => {
    expect(createRazorpayAdapter(config)).toBeInstanceOf(FakeRazorpayAdapter);
    expect(isLiveRazorpayConfig(config)).toBe(false);
  });

  it('returns the fake for the REPLACE_ME placeholder shipped in the k8s Secret', () => {
    // Non-empty, so a truthiness check would have accepted it. This is the case
    // that could otherwise boot a production gateway on a fake payment provider.
    const config = { keyId: 'REPLACE_ME', keySecret: 'REPLACE_ME', webhookSecret: 'REPLACE_ME' };
    expect(createRazorpayAdapter(config)).toBeInstanceOf(FakeRazorpayAdapter);
    expect(isLiveRazorpayConfig(config)).toBe(false);
  });

  it('returns the real adapter for a well-formed test key', () => {
    const config = { keyId: 'rzp_test_A1b2C3d4E5', keySecret: 'a-real-secret', webhookSecret: 'whsec' };
    expect(createRazorpayAdapter(config)).toBeInstanceOf(RazorpayPaymentAdapter);
    expect(isLiveRazorpayConfig(config)).toBe(true);
  });

  it('returns the real adapter for a live key', () => {
    const config = { keyId: 'rzp_live_A1b2C3d4E5', keySecret: 'a-real-secret', webhookSecret: 'whsec' };
    expect(createRazorpayAdapter(config)).toBeInstanceOf(RazorpayPaymentAdapter);
  });
});

describe('FakeRazorpayAdapter', () => {
  let adapter: FakeRazorpayAdapter;

  beforeEach(() => {
    adapter = new FakeRazorpayAdapter();
  });

  it('createOrder returns an unpaid order carrying the contract id', async () => {
    const order = await adapter.createOrder({
      amountMinor: 50000,
      currency: 'INR',
      contractId: 'AC-TEST1',
    });

    expect(order.orderId).toMatch(/^order_fake_AC-TEST1_\d+$/);
    expect(order.status).toBe('created');
    expect(order.amountMinor).toBe(50000);
    expect(order.currency).toBe('INR');
    expect(order.contractId).toBe('AC-TEST1');
  });

  it('issues distinct order ids for the same contract', async () => {
    const a = await adapter.createOrder({ amountMinor: 1, currency: 'INR', contractId: 'AC-DUP' });
    const b = await adapter.createOrder({ amountMinor: 1, currency: 'INR', contractId: 'AC-DUP' });
    expect(a.orderId).not.toBe(b.orderId);
  });

  it('walks the escrow lifecycle: created → authorized → captured', async () => {
    const order = await adapter.createOrder({
      amountMinor: 250000,
      currency: 'INR',
      contractId: 'AC-LIFE',
    });

    const authorized = await adapter.simulateAuthorization(order.orderId);
    expect(authorized.status).toBe('authorized');
    expect(authorized.captured).toBe(false);
    expect(authorized.orderId).toBe(order.orderId);
    expect(authorized.contractId).toBe('AC-LIFE');

    // The money is held, not taken — fetching must agree before capture.
    const fetched = await adapter.fetchPayment(authorized.paymentId);
    expect(fetched.status).toBe('authorized');
    expect(fetched.captured).toBe(false);

    const captured = await adapter.capturePayment({
      paymentId: authorized.paymentId,
      amountMinor: 250000,
      currency: 'INR',
    });
    expect(captured.status).toBe('captured');
    expect(captured.captured).toBe(true);
    expect(captured.contractId).toBe('AC-LIFE');

    // And the transition sticks, so a double capture is observable.
    expect((await adapter.fetchPayment(authorized.paymentId)).status).toBe('captured');
  });

  it('verifies a genuine checkout signature rather than waving it through', async () => {
    const order = await adapter.createOrder({
      amountMinor: 1000,
      currency: 'INR',
      contractId: 'AC-SIG',
    });
    const payment = await adapter.simulateAuthorization(order.orderId);
    const signature = signCheckout(order.orderId, payment.paymentId, FAKE_KEY_SECRET);

    expect(
      adapter.verifyCheckoutSignature({
        orderId: order.orderId,
        paymentId: payment.paymentId,
        signature,
      }),
    ).toBe(true);

    expect(
      adapter.verifyCheckoutSignature({
        orderId: order.orderId,
        paymentId: payment.paymentId,
        signature: signCheckout(order.orderId, payment.paymentId, 'wrong'),
      }),
    ).toBe(false);
  });

  it('verifies a genuine webhook signature, so the offline flow exercises the real path', async () => {
    const body = JSON.stringify({
      event: 'payment.authorized',
      payload: { payment: { entity: { id: 'pay_fake_1', status: 'authorized' } } },
    });

    const ok = await adapter.verifyWebhook(body, signWebhook(body, FAKE_WEBHOOK_SECRET));
    expect(ok.valid).toBe(true);
    expect(ok.event?.event).toBe('payment.authorized');

    const bad = await adapter.verifyWebhook(body, signWebhook(body, 'not-the-secret'));
    expect(bad.valid).toBe(false);
  });

  it('honours a caller-supplied webhook secret', async () => {
    const custom = new FakeRazorpayAdapter('my_own_secret');
    const body = '{"event":"payment.captured","payload":{}}';

    expect((await custom.verifyWebhook(body, signWebhook(body, 'my_own_secret'))).valid).toBe(true);
    expect((await custom.verifyWebhook(body, signWebhook(body, FAKE_WEBHOOK_SECRET))).valid).toBe(false);
  });

  it('refunds a captured payment', async () => {
    const order = await adapter.createOrder({
      amountMinor: 7500,
      currency: 'INR',
      contractId: 'AC-REF',
    });
    const payment = await adapter.simulateAuthorization(order.orderId);
    await adapter.capturePayment({ paymentId: payment.paymentId, amountMinor: 7500, currency: 'INR' });

    const refund = await adapter.refundPayment({ paymentId: payment.paymentId });
    expect(refund.refundId).toMatch(/^rfnd_fake_\d+$/);
    expect(refund.amountMinor).toBe(7500);
    expect(refund.status).toBe('processed');
  });

  it('satisfies the PaymentPort interface', () => {
    const port: PaymentPort = new FakeRazorpayAdapter();
    expect(typeof port.createOrder).toBe('function');
    expect(typeof port.capturePayment).toBe('function');
    expect(typeof port.verifyCheckoutSignature).toBe('function');
    expect(typeof port.verifyWebhook).toBe('function');
  });
});
