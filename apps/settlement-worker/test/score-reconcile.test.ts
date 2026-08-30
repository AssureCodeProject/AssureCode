/**
 * The score-reconciliation leg: attemptScoring and reconcileMissingScores.
 *
 * Mirrors payout-leg.test.ts's shape for the same reason: these are the real
 * functions the golden-path CI failure traced back to (see V021's migration
 * header) — triggerScoring gives up after a ~20s budget with no second
 * chance, so a contract whose first attempt lost the race against a
 * cold-started ai-service stayed at trust_score NULL forever. This suite is
 * the regression guard for the fix: a periodic sweep, capped the same way
 * the payout leg already is.
 *
 * The stub stands in for the gateway's GET /score, matching
 * scoring-chain.test.ts's approach — this suite is about the retry/cap
 * bookkeeping around that call, not about proving the HTTP client itself
 * (gateway-client.test.ts already does that).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import pg from 'pg';
import { loadDotEnv } from '../../../tools/test-support/env.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';
import { buildDbConfig, getDatabaseUrl, loadConfig } from '@assurecode/config';
import { EVENT_TOPICS } from '@assurecode/shared';

loadDotEnv();

const available = await postgresAvailable();
if (!available) announceSkip('score reconciliation', 'PostgreSQL (DATABASE_URL)');

describe.skipIf(!available)('score reconciliation', () => {
  let pool: pg.Pool;
  let worker: typeof import('../src/worker.js');
  let stub: Server;
  /** Set per-test to control what the stub answers for the next /score call. */
  let stubMode: 'score' | 'decline' = 'score';
  let scoreCalls: string[] = [];

  beforeAll(async () => {
    stub = createServer((req, res) => {
      const match = /^\/api\/contracts\/(.+)\/score$/.exec(req.url ?? '');
      if (!match) {
        res.writeHead(404).end('{}');
        return;
      }
      const id = decodeURIComponent(match[1]);
      scoreCalls.push(id);

      if (stubMode === 'decline') {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no audit_results row' }));
        return;
      }

      const scorePayload = {
        contractId: id,
        freelancerId: 'FL-TEST',
        trustScore: 91.2,
        criticalVulns: 0,
        justifications: ['stub'],
        scoredAt: new Date().toISOString(),
      };
      void worker.eventBus.publish(EVENT_TOPICS.XAI_SCORED, scorePayload).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(scorePayload));
      });
    });

    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const { port } = stub.address() as AddressInfo;

    process.env.GATEWAY_URL = `http://127.0.0.1:${port}`;
    process.env.ENABLE_AUTO_SCORING = 'true';

    worker = await import('../src/worker.js');
    await worker.start();

    pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  });

  afterAll(async () => {
    await pool?.end();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    // Same reasoning as scoring-chain.test.ts: worker.start() opened a real
    // Prometheus listener that must not survive this file.
    if (worker.metricsServer) {
      await new Promise<void>((resolve) => worker.metricsServer!.close(() => resolve()));
    }
  });

  async function seedUnscoredContract(contractId: string, scoreAttempts = 0): Promise<void> {
    await pool.query(
      `INSERT INTO contracts (contract_id, client_id, title, requirements, budget_cents, deadline, status)
       VALUES ($1, 'legacy-client', 'score reconcile test', 'n/a', 100000, '2026-12-31', 'LOCKED')
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId],
    );
    await pool.query(
      `INSERT INTO oracle_state (contract_id, ast_passed, tests_passed, security_passed, score_attempts, updated_at)
       VALUES ($1, true, true, true, $2, NOW())
       ON CONFLICT (contract_id) DO UPDATE SET score_attempts = $2, trust_score = NULL`,
      [contractId, scoreAttempts],
    );
  }

  async function cleanupContract(contractId: string): Promise<void> {
    await pool.query(`DELETE FROM oracle_state WHERE contract_id = $1`, [contractId]);
    await pool.query(`DELETE FROM contracts WHERE contract_id = $1`, [contractId]);
  }

  it('reconcileMissingScores scores a contract stuck at trust_score NULL', async () => {
    const contractId = `AC-SCORE-RECONCILE-${Date.now()}`;
    await seedUnscoredContract(contractId);
    stubMode = 'score';
    scoreCalls = [];

    await worker.reconcileMissingScores();

    expect(scoreCalls).toContain(contractId);
    const row = await pool.query(
      `SELECT trust_score, score_attempts FROM oracle_state WHERE contract_id = $1`,
      [contractId],
    );
    expect(Number(row.rows[0].trust_score)).toBeCloseTo(91.2, 1);
    expect(row.rows[0].score_attempts).toBe(1);

    await cleanupContract(contractId);
  });

  it('reconcileMissingScores does not retry a row already at the attempt cap', async () => {
    const contractId = `AC-SCORE-CAP-${Date.now()}`;
    await seedUnscoredContract(contractId, worker.SCORE_MAX_ATTEMPTS);
    stubMode = 'score';
    scoreCalls = [];

    await worker.reconcileMissingScores();

    // The WHERE clause excludes it outright -- the stub must never be hit.
    expect(scoreCalls).not.toContain(contractId);
    const row = await pool.query(
      `SELECT trust_score, score_attempts FROM oracle_state WHERE contract_id = $1`,
      [contractId],
    );
    expect(row.rows[0].trust_score).toBeNull();
    expect(row.rows[0].score_attempts).toBe(worker.SCORE_MAX_ATTEMPTS);

    await cleanupContract(contractId);
  });

  it('reconcileMissingScores still retries a row below the cap', async () => {
    const contractId = `AC-SCORE-BELOWCAP-${Date.now()}`;
    await seedUnscoredContract(contractId, worker.SCORE_MAX_ATTEMPTS - 1);
    stubMode = 'score';
    scoreCalls = [];

    await worker.reconcileMissingScores();

    expect(scoreCalls).toContain(contractId);
    const row = await pool.query(
      `SELECT trust_score, score_attempts FROM oracle_state WHERE contract_id = $1`,
      [contractId],
    );
    expect(Number(row.rows[0].trust_score)).toBeCloseTo(91.2, 1);
    expect(row.rows[0].score_attempts).toBe(worker.SCORE_MAX_ATTEMPTS);

    await cleanupContract(contractId);
  });

  it('attemptScoring jumps straight to the cap on a declined (terminal) response', async () => {
    const contractId = `AC-SCORE-DECLINED-${Date.now()}`;
    await seedUnscoredContract(contractId);
    stubMode = 'decline';
    scoreCalls = [];

    await worker.attemptScoring(contractId);

    expect(scoreCalls).toContain(contractId);
    const row = await pool.query(
      `SELECT trust_score, score_attempts FROM oracle_state WHERE contract_id = $1`,
      [contractId],
    );
    // One real attempt happened, but the row must not be eligible for the
    // sweep to pick up again -- a 409 "no audit" verdict cannot change on
    // retry, and reconcileMissingScores must not keep re-asking.
    expect(row.rows[0].trust_score).toBeNull();
    expect(row.rows[0].score_attempts).toBe(worker.SCORE_MAX_ATTEMPTS);

    await cleanupContract(contractId);
  });

  it('reconcileMissingScores is a no-op when there is nothing unscored', async () => {
    stubMode = 'score';
    scoreCalls = [];
    await expect(worker.reconcileMissingScores()).resolves.toBeUndefined();
  });
});
