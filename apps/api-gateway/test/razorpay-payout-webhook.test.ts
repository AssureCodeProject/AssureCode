/**
 * Route-level tests for the payout half of POST /webhooks/razorpay.
 *
 * A payout webhook carries neither `orderId` nor `paymentId` — it resolves
 * through `settlements.payout_id`, not the `escrow` table the payment/order
 * branch uses. Before this branch existed, a payout webhook fell straight
 * into the route's `!orderId && !paymentId` early-return and was silently
 * dropped; these tests exist to pin that it now resolves correctly and,
 * separately, that an unrecognized payoutId still answers 200 without
 * erroring — matching the existing "unknown escrow" convention.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import server from '../src/server.js';
import { FAKE_WEBHOOK_SECRET } from '@assurecode/razorpay-adapter';
import { loadConfig, buildDbConfig, getDatabaseUrl } from '@assurecode/config';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('Razorpay payout webhook', 'a running PostgreSQL on DATABASE_URL');

const WEBHOOK_SECRET = loadConfig().RAZORPAY_WEBHOOK_SECRET || FAKE_WEBHOOK_SECRET;

function sign(rawBody: string, secret = WEBHOOK_SECRET): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function payoutWebhookBody(event: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    entity: 'event',
    event,
    account_id: 'acc_TEST',
    contains: ['payout'],
    payload: {
      payout: {
        entity: {
          id: 'pout_TESTPAYOUT1',
          amount: 250000,
          currency: 'INR',
          status: event === 'payout.processed' ? 'processed' : 'failed',
          ...overrides,
        },
      },
    },
    created_at: 1700000000,
  });
}

function inject(payload: string, signature: string, eventId = 'evt_payout_test') {
  return server.inject({
    method: 'POST',
    url: '/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
    payload,
  });
}

describe.skipIf(!PG_UP)('POST /webhooks/razorpay — payout branch', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  const contractId = `AC-PAYOUT-WEBHOOK-${Date.now()}`;
  const payoutId = `pout_test_${Date.now()}`;

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO contracts (contract_id, client_id, title, requirements, budget_cents, deadline, status)
       VALUES ($1, 'legacy-client', 'payout webhook test', 'n/a', 250000, '2026-12-31', 'LOCKED')
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId],
    );
    await pool.query(
      `INSERT INTO settlements (contract_id, status, payout_status, payout_id)
       VALUES ($1, 'COMPLETED', 'PROCESSING', $2)
       ON CONFLICT (contract_id) DO UPDATE SET payout_status = 'PROCESSING', payout_id = $2`,
      [contractId, payoutId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM payment_events WHERE contract_id = $1`, [contractId]);
    await pool.query(`DELETE FROM settlements WHERE contract_id = $1`, [contractId]);
    await pool.query(`DELETE FROM contracts WHERE contract_id = $1`, [contractId]);
    await pool.end();
  });

  it('moves payout_status to COMPLETED on payout.processed', async () => {
    const body = payoutWebhookBody('payout.processed', { id: payoutId });
    const res = await inject(body, sign(body));

    expect(res.statusCode).toBe(200);

    const row = await pool.query(
      `SELECT payout_status, payout_updated_at FROM settlements WHERE contract_id = $1`,
      [contractId],
    );
    expect(row.rows[0].payout_status).toBe('COMPLETED');
    expect(row.rows[0].payout_updated_at).not.toBeNull();
  });

  it('moves payout_status to FAILED on payout.failed, with a reason', async () => {
    await pool.query(`UPDATE settlements SET payout_status = 'PROCESSING' WHERE contract_id = $1`, [
      contractId,
    ]);
    const body = payoutWebhookBody('payout.failed', {
      id: payoutId,
      failure_reason: 'insufficient_balance',
    });
    const res = await inject(body, sign(body), `evt_payout_failed_${Date.now()}`);

    expect(res.statusCode).toBe(200);

    const row = await pool.query(
      `SELECT payout_status, payout_failure_reason FROM settlements WHERE contract_id = $1`,
      [contractId],
    );
    expect(row.rows[0].payout_status).toBe('FAILED');
    expect(row.rows[0].payout_failure_reason).toBe('insufficient_balance');
  });

  it('moves payout_status to FAILED on payout.rejected (a distinct real terminal-failure state)', async () => {
    await pool.query(`UPDATE settlements SET payout_status = 'PROCESSING' WHERE contract_id = $1`, [
      contractId,
    ]);
    const body = payoutWebhookBody('payout.rejected', {
      id: payoutId,
      failure_reason: 'invalid_beneficiary_details',
    });
    const res = await inject(body, sign(body), `evt_payout_rejected_${Date.now()}`);

    expect(res.statusCode).toBe(200);

    const row = await pool.query(
      `SELECT payout_status, payout_failure_reason FROM settlements WHERE contract_id = $1`,
      [contractId],
    );
    expect(row.rows[0].payout_status).toBe('FAILED');
    expect(row.rows[0].payout_failure_reason).toBe('invalid_beneficiary_details');
  });

  it('returns 200 without error for an unknown payoutId, matching the unknown-escrow convention', async () => {
    const body = payoutWebhookBody('payout.processed', { id: 'pout_never_seen' });
    const res = await inject(body, sign(body), `evt_payout_unknown_${Date.now()}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
  });
});
