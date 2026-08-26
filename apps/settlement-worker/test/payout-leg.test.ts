/**
 * The payout leg: attemptPayout and reconcilePendingPayouts.
 *
 * Imports the real functions from worker.ts, the same reasoning
 * settlement-concurrency.test.ts's header already documents for
 * claimSettlement — a test that reimplements the thing it checks measures
 * nothing.
 *
 * The most important test here is the idempotency proof. RazorpayX's own
 * idempotency guarantee is what makes it safe for reconcilePendingPayouts
 * to retry a payout whose result this process never saw (see attemptPayout's
 * header comment in worker.ts) — a blind retry that isn't idempotency-keyed
 * would risk literally double-paying a freelancer. FakePayoutAdapter
 * implements that guarantee (a repeated idempotencyKey returns the original
 * PayoutResult rather than minting a new one), and this suite is the
 * regression guard for it: if that check were ever removed, the payoutId
 * assertion below would fail.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadDotEnv } from '../../../tools/test-support/env.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';
import { buildDbConfig, getDatabaseUrl, loadConfig } from '@assurecode/config';

loadDotEnv();

// .env's RAZORPAY_KEY_ID is a genuine rzp_test_ key that createPayoutAdapter
// treats as "live enough" to select RazorpayXPayoutAdapter — and it correctly
// does, since this suite is about the payout leg's LOGIC (idempotency, state
// transitions), not about proving a real RazorpayX Payouts account (a
// separate activation from plain Razorpay test-mode payments — see the
// plan's "cannot be verified without real RazorpayX credentials" note).
// Overriding to a key containing 'mock' forces createPayoutAdapter's guard
// to select FakePayoutAdapter for this file, same trick other suites use.
// Must happen before the dynamic import below, since worker.ts reads
// process.env at module-evaluation time.
process.env.RAZORPAY_KEY_ID = 'rzp_test_mock_payout_leg';

const available = await postgresAvailable();
if (!available) announceSkip('payout leg', 'PostgreSQL (DATABASE_URL)');

describe.skipIf(!available)('payout leg', () => {
  let pool: pg.Pool;
  let attemptPayout: (contractId: string, freelancerId: string) => Promise<void>;
  let reconcilePendingPayouts: () => Promise<void>;

  const freelancerId = `freelancer-payout-test-${Date.now()}`;
  const freelancerNoAccountId = `freelancer-no-account-${Date.now()}`;

  beforeAll(async () => {
    // Dynamic import, matching settlement-concurrency.test.ts: the module's
    // top-level pool/adapter construction should only happen when this
    // suite actually runs.
    ({ attemptPayout, reconcilePendingPayouts } = await import('../src/worker.js'));

    pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));

    await pool.query(
      `INSERT INTO users (user_id, email, password_hash, role, display_name, payout_account_id)
       VALUES ($1, $1 || '@example.com', 'unusable-no-login', 'freelancer', 'Payout Test Freelancer', 'fa_fake_account_1')
       ON CONFLICT (user_id) DO UPDATE SET payout_account_id = EXCLUDED.payout_account_id`,
      [freelancerId],
    );
    await pool.query(
      `INSERT INTO users (user_id, email, password_hash, role, display_name, payout_account_id)
       VALUES ($1, $1 || '@example.com', 'unusable-no-login', 'freelancer', 'No Account Freelancer', NULL)
       ON CONFLICT (user_id) DO UPDATE SET payout_account_id = NULL`,
      [freelancerNoAccountId],
    );
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM users WHERE user_id IN ($1, $2)`, [
      freelancerId,
      freelancerNoAccountId,
    ]);
    await pool?.end();
  });

  /** A settled contract + its captured escrow row, ready for attemptPayout. */
  async function seedSettledContract(
    contractId: string,
    forFreelancerId: string,
  ): Promise<{ paymentId: string }> {
    const paymentId = `pay_${contractId}`;
    await pool.query(
      `INSERT INTO contracts (contract_id, client_id, freelancer_id, title, requirements, budget_cents, deadline, status)
       VALUES ($1, 'legacy-client', $2, 'payout test', 'n/a', 250000, '2026-12-31', 'COMPLETED')
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId, forFreelancerId],
    );
    await pool.query(
      `INSERT INTO escrow (order_id, contract_id, payment_id, amount_cents, currency, status)
       VALUES ($1, $2, $3, 250000, 'INR', 'RELEASED')
       ON CONFLICT (order_id) DO NOTHING`,
      [`order_${contractId}`, contractId, paymentId],
    );
    await pool.query(
      `INSERT INTO settlements (contract_id, status, transfer_id)
       VALUES ($1, 'COMPLETED', $2)
       ON CONFLICT (contract_id) DO UPDATE SET status = 'COMPLETED', transfer_id = $2`,
      [contractId, paymentId],
    );
    return { paymentId };
  }

  async function cleanupContract(contractId: string): Promise<void> {
    await pool.query(`DELETE FROM settlements WHERE contract_id = $1`, [contractId]);
    await pool.query(`DELETE FROM escrow WHERE contract_id = $1`, [contractId]);
    await pool.query(`DELETE FROM contracts WHERE contract_id = $1`, [contractId]);
  }

  it('pays out and records the payout id when the freelancer has a payout account', async () => {
    const contractId = `AC-PAYOUT-HAPPY-${Date.now()}`;
    await seedSettledContract(contractId, freelancerId);

    await attemptPayout(contractId, freelancerId);

    const row = await pool.query(
      `SELECT payout_status, payout_id FROM settlements WHERE contract_id = $1`,
      [contractId],
    );
    expect(row.rows[0].payout_status).toBe('COMPLETED');
    expect(row.rows[0].payout_id).toBeTruthy();

    await cleanupContract(contractId);
  });

  it('leaves payout_status PENDING, and does not throw, when the freelancer has no payout account', async () => {
    const contractId = `AC-PAYOUT-NOACCOUNT-${Date.now()}`;
    await seedSettledContract(contractId, freelancerNoAccountId);

    await expect(attemptPayout(contractId, freelancerNoAccountId)).resolves.toBeUndefined();

    const row = await pool.query(`SELECT payout_status, payout_id FROM settlements WHERE contract_id = $1`, [
      contractId,
    ]);
    expect(row.rows[0].payout_status).toBe('PENDING');
    expect(row.rows[0].payout_id).toBeNull();

    await cleanupContract(contractId);
  });

  it('does not throw when there is no freelancerId (a settlement with no assigned payee)', async () => {
    const contractId = `AC-PAYOUT-NOFREELANCER-${Date.now()}`;
    await seedSettledContract(contractId, freelancerId);

    await expect(attemptPayout(contractId, '')).resolves.toBeUndefined();

    await cleanupContract(contractId);
  });

  it('is idempotent: retrying for the same contract does not mint a second payout', async () => {
    const contractId = `AC-PAYOUT-IDEMPOTENT-${Date.now()}`;
    await seedSettledContract(contractId, freelancerId);

    await attemptPayout(contractId, freelancerId);
    const firstRow = await pool.query(`SELECT payout_id FROM settlements WHERE contract_id = $1`, [
      contractId,
    ]);
    const firstPayoutId = firstRow.rows[0].payout_id;
    expect(firstPayoutId).toBeTruthy();

    // Simulate the crash-recovery retry path: attemptPayout is called again
    // for the same contract, exactly as reconcilePendingPayouts would.
    await attemptPayout(contractId, freelancerId);
    const secondRow = await pool.query(`SELECT payout_id FROM settlements WHERE contract_id = $1`, [
      contractId,
    ]);

    // This is the property that must hold: the SAME payoutId, not a new one.
    // A break here means the idempotency key stopped working and a real
    // deployment would double-pay the freelancer on every retry.
    expect(secondRow.rows[0].payout_id).toBe(firstPayoutId);

    await cleanupContract(contractId);
  });

  it('reconcilePendingPayouts retries a FAILED payout for a freelancer who has an account', async () => {
    const contractId = `AC-PAYOUT-RECONCILE-${Date.now()}`;
    await seedSettledContract(contractId, freelancerId);
    await pool.query(
      `UPDATE settlements SET payout_status = 'FAILED', payout_failure_reason = 'simulated prior failure' WHERE contract_id = $1`,
      [contractId],
    );

    await reconcilePendingPayouts();

    const row = await pool.query(`SELECT payout_status, payout_id FROM settlements WHERE contract_id = $1`, [
      contractId,
    ]);
    expect(row.rows[0].payout_status).toBe('COMPLETED');
    expect(row.rows[0].payout_id).toBeTruthy();

    await cleanupContract(contractId);
  });

  it('reconcilePendingPayouts skips a settlement whose freelancer has no payout account', async () => {
    const contractId = `AC-PAYOUT-RECONCILE-SKIP-${Date.now()}`;
    await seedSettledContract(contractId, freelancerNoAccountId);

    // Should not throw, and should leave the row untouched — the JOIN on
    // users.payout_account_id IS NOT NULL excludes it from the sweep.
    await expect(reconcilePendingPayouts()).resolves.toBeUndefined();

    const row = await pool.query(`SELECT payout_status FROM settlements WHERE contract_id = $1`, [
      contractId,
    ]);
    expect(row.rows[0].payout_status).toBe('PENDING');

    await cleanupContract(contractId);
  });
});
