/**
 * @assurecode/stripe-adapter — Stripe escrow port + adapters.
 *
 * Hexagonal seam: the gateway calls createPaymentIntent / capturePaymentIntent
 * / verifyWebhook through the EscrowPort interface. Real adapter talks to
 * Stripe's API; fake adapter returns deterministic test data.
 *
 * Usage:
 *   import { createEscrowAdapter } from '@assurecode/stripe-adapter';
 *   const escrow = createEscrowAdapter({ secretKey: 'sk_test_...' });
 *   const pi = await escrow.createPaymentIntent({ amountCents: 50000, contractId: 'AC-...' });
 */

import Stripe from 'stripe';

export interface PaymentIntentResult {
  paymentIntentId: string;
  clientSecret: string;
  status: 'requires_payment_method' | 'requires_confirmation' | 'succeeded' | 'canceled';
  amountCents: number;
  contractId: string;
}

export interface WebhookVerificationResult {
  valid: boolean;
  event: StripeWebhookEvent | null;
  error?: string;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      [key: string]: unknown;
    };
  };
}

export interface EscrowPort {
  /** Create a PaymentIntent for escrow funding. */
  createPaymentIntent(params: {
    amountCents: number;
    contractId: string;
    metadata?: Record<string, string>;
  }): Promise<PaymentIntentResult>;

  /** Capture an existing PaymentIntent (transfer funds from hold). */
  capturePaymentIntent(paymentIntentId: string): Promise<PaymentIntentResult>;

  /** Cancel/refund a PaymentIntent. */
  cancelPaymentIntent(paymentIntentId: string): Promise<{ canceled: boolean; paymentIntentId: string }>;

  /** Verify a Stripe webhook signature. */
  verifyWebhook(payload: string | Buffer, signature: string): Promise<WebhookVerificationResult>;

  /** Execute a transfer to a freelancer's Stripe Connect account. */
  transferToFreelancer(params: {
    amountCents: number;
    destinationAccountId: string;
    contractId: string;
  }): Promise<{ transferId: string; amountCents: number }>;
}

// ── Configuration ─────────────────────────────────────────────────────

export interface EscrowConfig {
  secretKey: string;
  webhookSecret: string;
  isTest?: boolean;
}

// ── Factory ────────────────────────────────────────────────────────────

export function createEscrowAdapter(config: EscrowConfig): EscrowPort {
  // If no real key or explicitly flagged or mock key, return the fake.
  if (
    !config.secretKey ||
    !config.secretKey.startsWith('sk_') ||
    config.secretKey.includes('mock') ||
    config.secretKey.includes('...') ||
    config.isTest
  ) {
    return new FakeEscrowAdapter();
  }
  return new StripeEscrowAdapter(config);
}

// ── Fake Adapter ───────────────────────────────────────────────────────

export class FakeEscrowAdapter implements EscrowPort {
  async createPaymentIntent(params: {
    amountCents: number;
    contractId: string;
    metadata?: Record<string, string>;
  }): Promise<PaymentIntentResult> {
    return {
      paymentIntentId: `pi_fake_${params.contractId}_${Date.now()}`,
      clientSecret: `pi_fake_${params.contractId}_secret_test`,
      status: 'requires_payment_method',
      amountCents: params.amountCents,
      contractId: params.contractId,
    };
  }

  async capturePaymentIntent(paymentIntentId: string): Promise<PaymentIntentResult> {
    return {
      paymentIntentId,
      clientSecret: '',
      status: 'succeeded',
      amountCents: 0,
      contractId: '',
    };
  }

  async cancelPaymentIntent(paymentIntentId: string): Promise<{ canceled: boolean; paymentIntentId: string }> {
    return { canceled: true, paymentIntentId };
  }

  async verifyWebhook(payload: string | Buffer, signature: string): Promise<WebhookVerificationResult> {
    if (signature.startsWith('mock_')) {
      try {
        const bodyObj = typeof payload === 'string' ? JSON.parse(payload) : JSON.parse(payload.toString());
        return {
          valid: true,
          event: {
            id: bodyObj.id || `evt_fake_${Date.now()}`,
            type: bodyObj.type || 'payment_intent.succeeded',
            data: {
              object: bodyObj.data?.object || {
                id: bodyObj.paymentIntentId || bodyObj.id || 'pi_mock_123',
                metadata: {
                  contractId: bodyObj.contractId || bodyObj.metadata?.contractId || '',
                },
              },
            },
          },
        };
      } catch (err: any) {
        return { valid: false, event: null, error: err.message };
      }
    }
    return {
      valid: false,
      event: null,
      error: 'Fake adapter cannot verify real webhooks',
    };
  }

  async transferToFreelancer(params: {
    amountCents: number;
    destinationAccountId: string;
    contractId: string;
  }): Promise<{ transferId: string; amountCents: number }> {
    return {
      transferId: `tr_fake_${params.contractId}_${Date.now()}`,
      amountCents: params.amountCents,
    };
  }
}

// ── Real Stripe Adapter ────────────────────────────────────────────────

export class StripeEscrowAdapter implements EscrowPort {
  private stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(config: EscrowConfig) {
    this.webhookSecret = config.webhookSecret;
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: '2025-02-24.acacia' as any,
    });
  }

  async createPaymentIntent(params: {
    amountCents: number;
    contractId: string;
    metadata?: Record<string, string>;
  }): Promise<PaymentIntentResult> {
    const pi = await this.stripe.paymentIntents.create({
      amount: params.amountCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        contractId: params.contractId,
        ...params.metadata,
      },
      // Escrow: capture_method manual means funds are held until we call capture.
      capture_method: 'manual',
    });

    return {
      paymentIntentId: pi.id,
      clientSecret: pi.client_secret ?? '',
      status: pi.status as PaymentIntentResult['status'],
      amountCents: pi.amount,
      contractId: params.contractId,
    };
  }

  async capturePaymentIntent(paymentIntentId: string): Promise<PaymentIntentResult> {
    const pi = await this.stripe.paymentIntents.capture(paymentIntentId);
    return {
      paymentIntentId: pi.id,
      clientSecret: '',
      status: pi.status as PaymentIntentResult['status'],
      amountCents: pi.amount,
      contractId: (pi.metadata as Record<string, string>)?.contractId ?? '',
    };
  }

  async cancelPaymentIntent(paymentIntentId: string): Promise<{ canceled: boolean; paymentIntentId: string }> {
    const pi = await this.stripe.paymentIntents.cancel(paymentIntentId);
    return { canceled: pi.status === 'canceled', paymentIntentId: pi.id };
  }

  async verifyWebhook(
    payload: string | Buffer,
    signature: string,
  ): Promise<WebhookVerificationResult> {
    try {
      const event = this.stripe.webhooks.constructEvent(
        typeof payload === 'string' ? payload : payload.toString('utf-8'),
        signature,
        this.webhookSecret,
      );

      return {
        valid: true,
        event: {
          id: event.id,
          type: event.type,
          data: {
            object: event.data.object as unknown as { id: string; [key: string]: unknown },
          },
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, event: null, error: msg };
    }
  }

  async transferToFreelancer(params: {
    amountCents: number;
    destinationAccountId: string;
    contractId: string;
  }): Promise<{ transferId: string; amountCents: number }> {
    const transfer = await this.stripe.transfers.create({
      amount: params.amountCents,
      currency: 'usd',
      destination: params.destinationAccountId,
      metadata: { contractId: params.contractId },
    });

    return {
      transferId: transfer.id,
      amountCents: transfer.amount,
    };
  }
}
