/**
 * Single-fire settlement under concurrency (plan2 6.3, DoD #6).
 *
 * What this replaced, and why it mattered
 * ---------------------------------------
 * The previous version of this file had no `skipIf`. When Postgres was absent
 * its `catch` fell through to an in-process `Set` that satisfied exactly the
 * same assertions, so the suite reported green with no database and proved
 * nothing at all — the single worst failure mode a test can have, because it
 * looks like evidence.
 *
 * It also re-typed the guard SQL inline as `ON CONFLICT DO NOTHING`. The worker
 * has not used that statement for some time: `claimSettlement` is
 * `ON CONFLICT DO UPDATE ... WHERE settlements.status = 'FAILED'`, precisely so
 * a contract whose settlement failed transiently is not left permanently
 * unsettleable with money held in escrow. A test asserting against a
 * re-implementation cannot notice that the real one changed, and this one
 * could never have covered the re-claim path the WHERE clause exists for.
 *
 * So this imports `claimSettlement` from the worker and exercises the shipped
 * guard. If the statement changes, these tests change with it or fail.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { loadDotEnv } from '../../../tools/test-support/env.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';
import { buildDbConfig, getDatabaseUrl, loadConfig } from '@assurecode/config';

loadDotEnv();

const available = await postgresAvailable();
if (!available) announceSkip('single-fire settlement', 'PostgreSQL (DATABASE_URL)');

describe.skipIf(!available)('settlement is single-fire under concurrency', () => {
  const contractId = `AC-SINGLEFIRE-${Date.now()}`;
  let pool: pg.Pool;
  let claimSettlement: (contractId: string) => Promise<boolean>;

  beforeAll(async () => {
    // Imported dynamically so the module's top-level pool/bus construction
    // happens only when this suite is actually going to run.
    ({ claimSettlement } = await import('../src/worker.js'));

    pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
    await pool.query(
      `INSERT INTO contracts (contract_id, client_id, title, requirements, budget_cents, deadline, status)
       VALUES ($1, 'legacy-client', 'Single-fire test', 'requirements', 100000, '2026-12-31', 'LOCKED')
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId],
    );
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM settlements WHERE contract_id = $1', [contractId]);
  });

  afterAll(async () => {
    await pool?.query('DELETE FROM settlements WHERE contract_id = $1', [contractId]);
    await pool?.query('DELETE FROM contracts WHERE contract_id = $1', [contractId]);
    await pool?.end();
  });

  it('lets exactly one of five concurrent claims through', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimSettlement(contractId)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => !r)).toHaveLength(4);

    const { rows } = await pool.query(
      'SELECT status FROM settlements WHERE contract_id = $1',
      [contractId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PROCESSING');
  });

  it('refuses a second claim while the first is still PROCESSING', async () => {
    expect(await claimSettlement(contractId)).toBe(true);
    // The exactly-once case: an in-flight settlement must not be re-entered,
    // or the held payment could be captured twice.
    expect(await claimSettlement(contractId)).toBe(false);
  });

  it('refuses a claim on a COMPLETED settlement', async () => {
    await claimSettlement(contractId);
    await pool.query(
      `UPDATE settlements SET status = 'COMPLETED' WHERE contract_id = $1`,
      [contractId],
    );

    expect(await claimSettlement(contractId)).toBe(false);
  });

  // The path the WHERE clause exists for, and the one the old test could not
  // reach. Without it, any transient failure — a Razorpay timeout, a database
  // blip — left the contract permanently unsettleable with the client's money
  // still held in escrow.
  it('re-claims a FAILED settlement so a transient failure is recoverable', async () => {
    await claimSettlement(contractId);
    await pool.query(
      `UPDATE settlements SET status = 'FAILED' WHERE contract_id = $1`,
      [contractId],
    );

    expect(await claimSettlement(contractId)).toBe(true);

    const { rows } = await pool.query(
      'SELECT status FROM settlements WHERE contract_id = $1',
      [contractId],
    );
    expect(rows[0].status).toBe('PROCESSING');
  });

  it('still admits exactly one claimant when five race to re-claim a FAILED row', async () => {
    await claimSettlement(contractId);
    await pool.query(
      `UPDATE settlements SET status = 'FAILED' WHERE contract_id = $1`,
      [contractId],
    );

    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimSettlement(contractId)),
    );

    // Recovery must not become a second way to double-capture.
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
