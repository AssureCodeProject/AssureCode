/**
 * Settlement oracle gate.
 *
 * These tests exercise the shipped OracleStore against live Postgres. The
 * previous version of this file defined its own `checkOracle` helper inside the
 * test and asserted against that — so it passed whether or not the worker had a
 * gate at all, and it kept passing through a rewrite that moved the entire
 * decision into a different module. A test that reimplements the thing it is
 * checking measures nothing.
 *
 * Objective 4's gate is `trustScore >= 85 && criticalVulns === 0`, on top of the
 * four CI signals. Each is asserted separately, including the boundary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadDotEnv } from '../../../tools/test-support/env.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';
import { buildDbConfig } from '@assurecode/config';
import { OracleStore, TRUST_SCORE_THRESHOLD } from '../src/oracle-store.js';

loadDotEnv();

const available = await postgresAvailable();
if (!available) announceSkip('settlement oracle', 'PostgreSQL (DATABASE_URL)');

describe.skipIf(!available)('settlement oracle gate', () => {
  let pool: pg.Pool;
  let store: OracleStore;
  const contractId = `AC-ORACLE-TEST-${Date.now()}`;

  /** Put the contract in a state where every signal passes. */
  async function makeFullyPassing(): Promise<void> {
    await store.recordAudit(contractId, {
      astPassed: true,
      testsPassed: true,
      securityPassed: true,
    });
    await store.recordScore(contractId, 92, 0);
    await pool.query('DELETE FROM scope_checks WHERE contract_id = $1', [contractId]);
  }

  beforeAll(async () => {
    pool = new pg.Pool(buildDbConfig(process.env.DATABASE_URL!));
    store = new OracleStore(pool);
    await pool.query(
      `INSERT INTO contracts (contract_id, client_id, title, requirements, budget_cents, deadline, status)
       VALUES ($1, 'client-test', 'Oracle gate test', 'requirements', 100000, '2026-12-31', 'LOCKED')
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM scope_checks WHERE contract_id = $1', [contractId]);
    await pool.query('DELETE FROM oracle_state WHERE contract_id = $1', [contractId]);
    await pool.query('DELETE FROM contracts WHERE contract_id = $1', [contractId]);
    await pool.end();
  });

  it('blocks a contract with no recorded state, and says why', async () => {
    const verdict = await store.evaluate(`AC-NEVER-AUDITED-${Date.now()}`);
    expect(verdict.approved).toBe(false);
    expect(verdict.signals.trustScore).toBeNull();
    expect(verdict.blockers.join(' ')).toContain('no audit or score');
  });

  it('approves only when every signal and the trust gate pass', async () => {
    await makeFullyPassing();
    const verdict = await store.evaluate(contractId);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.approved).toBe(true);
  });

  it('blocks when any single CI signal is withheld', async () => {
    const signals = ['astPassed', 'testsPassed', 'securityPassed'] as const;
    for (const withheld of signals) {
      await store.recordAudit(contractId, {
        astPassed: withheld !== 'astPassed',
        testsPassed: withheld !== 'testsPassed',
        securityPassed: withheld !== 'securityPassed',
      });
      await store.recordScore(contractId, 92, 0);
      const verdict = await store.evaluate(contractId);
      expect(verdict.approved, `${withheld} must gate settlement`).toBe(false);
    }
  });

  it('blocks below the trust threshold and passes at exactly 85', async () => {
    await makeFullyPassing();

    await store.recordScore(contractId, TRUST_SCORE_THRESHOLD - 1, 0);
    const below = await store.evaluate(contractId);
    expect(below.approved).toBe(false);
    expect(below.blockers.join(' ')).toContain('below the 85 threshold');

    // The objective says `>= 85`, so the boundary itself must settle.
    await store.recordScore(contractId, TRUST_SCORE_THRESHOLD, 0);
    const atBoundary = await store.evaluate(contractId);
    expect(atBoundary.approved).toBe(true);
  });

  it('blocks on a critical vulnerability even with a high trust score', async () => {
    await makeFullyPassing();
    await store.recordScore(contractId, 99, 1);
    const verdict = await store.evaluate(contractId);
    expect(verdict.approved).toBe(false);
    expect(verdict.blockers.join(' ')).toContain('critical vulnerability');
  });

  it('does not let one allowed message latch the scope signal open', async () => {
    // The regression this covers: the old in-memory oracle set scopePassed on
    // any allowed message and never cleared it, so the rejection below would
    // have been invisible to settlement.
    await makeFullyPassing();

    const insert = (allowed: boolean) =>
      pool.query(
        `INSERT INTO scope_checks (contract_id, sender, message, allowed, similarity, threshold, genesis_hash)
         VALUES ($1, 'client', $2, $3, 0.5, 0.2731, $4)`,
        [contractId, allowed ? 'in scope' : 'out of scope', allowed, 'a'.repeat(64)],
      );

    await insert(true);
    expect((await store.evaluate(contractId)).approved).toBe(true);

    await insert(false);
    const afterRejection = await store.evaluate(contractId);
    expect(afterRejection.signals.scopePassed).toBe(false);
    expect(afterRejection.approved).toBe(false);
    expect(afterRejection.blockers.join(' ')).toContain('scope check(s) were rejected');
  });
});
