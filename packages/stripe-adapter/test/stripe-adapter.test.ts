/**
 * Tests for the stripe-adapter package (task 1.8).
 *
 * Verifies the FakeEscrowAdapter returns deterministic test data and the
 * factory selects the fake when no real key is configured.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  createEscrowAdapter,
  FakeEscrowAdapter,
  StripeEscrowAdapter,
  type EscrowPort,
} from '../src/index.js';

/**
 * Why this block exists
 * ---------------------
 * The gateway verified webhooks against `JSON.stringify(request.body)` because
 * the raw body was never captured — `config: { rawBody: true }` names an option
 * belonging to a plugin that was not installed. Re-serialising the parsed body
 * produces different bytes than Stripe signed, so the HMAC could never match
 * and every genuine webhook was rejected 401. The tests below pin both halves:
 * the raw bytes verify, the re-serialised ones do not.
 */
describe('stripe webhook signature — raw bytes vs re-serialised', () => {
  const WEBHOOK_SECRET = 'whsec_test_secret_for_signature_verification';

  /** A `Stripe-Signature` header, built the way Stripe builds it. */
  function signPayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
    const signed = `${timestamp}.${payload}`;
    const v1 = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
    return `t=${timestamp},v1=${v1}`;
  }

  // Whitespace after the colon is what a re-serialise loses; Stripe's own
  // payloads are compact, but any formatting difference breaks the HMAC
  // identically, so this stands in for all of them.
  const RAW_PAYLOAD =
    '{\n  "id": "evt_test_1",\n  "type": "payment_intent.succeeded",\n' +
    '  "data": { "object": { "id": "pi_test_1", "metadata": { "contractId": "AC-1" } } }\n}';

  const adapter = new StripeEscrowAdapter({
    secretKey: 'sk_test_not_used_for_signature_checks',
    webhookSecret: WEBHOOK_SECRET,
  });

  it('accepts the exact bytes that were signed', async () => {
    const sig = signPayload(RAW_PAYLOAD, WEBHOOK_SECRET);
    const result = await adapter.verifyWebhook(RAW_PAYLOAD, sig);

    expect(result.valid).toBe(true);
    expect(result.event?.id).toBe('evt_test_1');
    expect(result.event?.type).toBe('payment_intent.succeeded');
  });

  it('accepts a Buffer of those bytes, which is what the route now passes', async () => {
    const sig = signPayload(RAW_PAYLOAD, WEBHOOK_SECRET);
    const result = await adapter.verifyWebhook(Buffer.from(RAW_PAYLOAD, 'utf8'), sig);

    expect(result.valid).toBe(true);
    expect(result.event?.id).toBe('evt_test_1');
  });

  it('rejects a re-serialised body — the exact bug that 401d every real webhook', async () => {
    const sig = signPayload(RAW_PAYLOAD, WEBHOOK_SECRET);
    const reSerialised = JSON.stringify(JSON.parse(RAW_PAYLOAD));

    // Same JSON value, different bytes.
    expect(reSerialised).not.toBe(RAW_PAYLOAD);

    const result = await adapter.verifyWebhook(reSerialised, sig);
    expect(result.valid).toBe(false);
    expect(result.event).toBeNull();
  });

  it('rejects a payload signed with the wrong secret', async () => {
    const sig = signPayload(RAW_PAYLOAD, 'whsec_a_different_secret');
    const result = await adapter.verifyWebhook(RAW_PAYLOAD, sig);
    expect(result.valid).toBe(false);
  });
});

describe('createEscrowAdapter factory', () => {
  it('returns FakeEscrowAdapter when secretKey is empty', () => {
    const adapter = createEscrowAdapter({ secretKey: '', webhookSecret: '' });
    expect(adapter).toBeInstanceOf(FakeEscrowAdapter);
  });

  it('returns FakeEscrowAdapter when secretKey does not start with sk_', () => {
    const adapter = createEscrowAdapter({
      secretKey: 'not-a-key',
      webhookSecret: 'whsec_...',
    });
    expect(adapter).toBeInstanceOf(FakeEscrowAdapter);
  });

  it('returns FakeEscrowAdapter when isTest flag is set', () => {
    const adapter = createEscrowAdapter({
      secretKey: 'sk_test_abc',
      webhookSecret: 'whsec_...',
      isTest: true,
    });
    expect(adapter).toBeInstanceOf(FakeEscrowAdapter);
  });
});

describe('FakeEscrowAdapter', () => {
  let adapter: EscrowPort;

  it('can be constructed', () => {
    adapter = new FakeEscrowAdapter();
    expect(adapter).toBeDefined();
  });

  it('createPaymentIntent returns requires_payment_method status', async () => {
    adapter = new FakeEscrowAdapter();
    const pi = await adapter.createPaymentIntent({
      amountCents: 50000,
      contractId: 'AC-TEST1',
    });
    expect(pi.paymentIntentId).toMatch(/^pi_fake_AC-TEST1_\d+$/);
    expect(pi.clientSecret).toContain('_secret_test');
    expect(pi.status).toBe('requires_payment_method');
    expect(pi.amountCents).toBe(50000);
    expect(pi.contractId).toBe('AC-TEST1');
  });

  it('capturePaymentIntent transitions to succeeded', async () => {
    adapter = new FakeEscrowAdapter();
    const pi = await adapter.capturePaymentIntent('pi_fake_123');
    expect(pi.status).toBe('succeeded');
    expect(pi.paymentIntentId).toBe('pi_fake_123');
  });

  it('cancelPaymentIntent returns canceled=true', async () => {
    adapter = new FakeEscrowAdapter();
    const result = await adapter.cancelPaymentIntent('pi_fake_456');
    expect(result.canceled).toBe(true);
    expect(result.paymentIntentId).toBe('pi_fake_456');
  });

  it('verifyWebhook returns valid=false for fake adapter', async () => {
    adapter = new FakeEscrowAdapter();
    const result = await adapter.verifyWebhook('payload', 'sig');
    expect(result.valid).toBe(false);
    expect(result.event).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('createPaymentIntent accepts metadata', async () => {
    adapter = new FakeEscrowAdapter();
    const pi = await adapter.createPaymentIntent({
      amountCents: 10000,
      contractId: 'AC-META',
      metadata: { clientId: 'client-1', source: 'test' },
    });
    expect(pi.contractId).toBe('AC-META');
  });
});
