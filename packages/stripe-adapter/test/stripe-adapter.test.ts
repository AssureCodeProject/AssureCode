/**
 * Tests for the stripe-adapter package (task 1.8).
 *
 * Verifies the FakeEscrowAdapter returns deterministic test data and the
 * factory selects the fake when no real key is configured.
 */
import { describe, it, expect } from 'vitest';
import {
  createEscrowAdapter,
  FakeEscrowAdapter,
  type EscrowPort,
} from '../src/index.js';

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
