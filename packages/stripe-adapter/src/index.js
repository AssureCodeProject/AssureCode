/**
 * @assurecode/stripe-adapter — Stripe escrow port + adapters.
 */
import Stripe from 'stripe';

export function createEscrowAdapter(config) {
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

export class FakeEscrowAdapter {
  async createPaymentIntent(params) {
    return {
      paymentIntentId: `pi_fake_${params.contractId}_${Date.now()}`,
      clientSecret: `pi_fake_${params.contractId}_secret_test`,
      status: 'requires_payment_method',
      amountCents: params.amountCents,
      contractId: params.contractId,
    };
  }

  async capturePaymentIntent(paymentIntentId) {
    return {
      paymentIntentId,
      clientSecret: '',
      status: 'succeeded',
      amountCents: 0,
      contractId: '',
    };
  }

  async cancelPaymentIntent(paymentIntentId) {
    return { canceled: true, paymentIntentId };
  }

  async verifyWebhook(payload, signature) {
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
      } catch (err) {
        return { valid: false, event: null, error: err.message };
      }
    }
    return {
      valid: false,
      event: null,
      error: 'Fake adapter cannot verify real webhooks',
    };
  }

  async transferToFreelancer(params) {
    return {
      transferId: `tr_fake_${params.contractId}_${Date.now()}`,
      amountCents: params.amountCents,
    };
  }
}

export class StripeEscrowAdapter {
  constructor(config) {
    this.webhookSecret = config.webhookSecret;
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: '2025-02-24.acacia',
    });
  }

  async createPaymentIntent(params) {
    const pi = await this.stripe.paymentIntents.create({
      amount: params.amountCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        contractId: params.contractId,
        ...params.metadata,
      },
      capture_method: 'manual',
    });

    return {
      paymentIntentId: pi.id,
      clientSecret: pi.client_secret ?? '',
      status: pi.status,
      amountCents: pi.amount,
      contractId: params.contractId,
    };
  }

  async capturePaymentIntent(paymentIntentId) {
    const pi = await this.stripe.paymentIntents.capture(paymentIntentId);
    return {
      paymentIntentId: pi.id,
      clientSecret: '',
      status: pi.status,
      amountCents: pi.amount,
      contractId: pi.metadata?.contractId ?? '',
    };
  }

  async cancelPaymentIntent(paymentIntentId) {
    const pi = await this.stripe.paymentIntents.cancel(paymentIntentId);
    return { canceled: pi.status === 'canceled', paymentIntentId: pi.id };
  }

  async verifyWebhook(payload, signature) {
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
            object: event.data.object,
          },
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, event: null, error: msg };
    }
  }

  async transferToFreelancer(params) {
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
