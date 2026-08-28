/**
 * The audit -> scoring -> gate chain, end to end, without a gateway.
 *
 * score-trigger.test.ts proves the HTTP client behaves. This proves the thing
 * that actually matters: that an AUDIT_COMPLETED event, on its own, ends with a
 * trust score in oracle_state. Before the trigger existed it did not — the
 * three CI booleans landed and `trust_score` stayed NULL until somebody opened
 * the XAI tab in a browser, so every contract stalled one signal short of the
 * settlement gate and nothing in the test suite noticed.
 *
 * The stub stands in for the gateway's GET /score: it answers 200 and publishes
 * XAI_SCORED on the same bus, which is exactly what apps/api-gateway does. The
 * worker's own two subscriptions do the rest, unmodified.
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
if (!available) announceSkip('automatic scoring chain', 'PostgreSQL (DATABASE_URL)');

describe.skipIf(!available)('AUDIT_COMPLETED reaches the trust-score gate on its own', () => {
  const contractId = `AC-CHAIN-TEST-${Date.now()}`;
  let stub: Server;
  let pool: pg.Pool;
  let worker: typeof import('../src/worker.js');
  let scoreCalls: string[] = [];

  beforeAll(async () => {
    // The stub has to exist and GATEWAY_URL has to point at it before worker.ts
    // is imported, because the worker reads its config at module scope.
    stub = createServer((req, res) => {
      const match = /^\/api\/contracts\/(.+)\/score$/.exec(req.url ?? '');
      if (!match) {
        res.writeHead(404).end('{}');
        return;
      }
      const id = decodeURIComponent(match[1]);
      scoreCalls.push(id);

      const scorePayload = {
        contractId: id,
        freelancerId: 'FL-TEST',
        trustScore: 93.5,
        criticalVulns: 0,
        justifications: ['stub'],
        scoredAt: new Date().toISOString(),
      };

      // Publishing before replying mirrors the gateway, which publishes
      // XAI_SCORED at the end of the handler and then sends the body.
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
    // 'legacy-client' is the seeded row the other integration suites use; V012
    // added an FK from contracts.client_id to users.user_id.
    await pool.query(
      `INSERT INTO contracts (contract_id, client_id, title, requirements, budget_cents, deadline, status)
       VALUES ($1, 'legacy-client', 'Scoring chain test', 'requirements', 100000, '2026-12-31', 'LOCKED')
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId],
    );
  });

  afterAll(async () => {
    await pool?.query('DELETE FROM oracle_state WHERE contract_id = $1', [contractId]);
    await pool?.query('DELETE FROM contracts WHERE contract_id = $1', [contractId]);
    await pool?.end();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    // worker.start() opens the real Prometheus listener on SETTLEMENT_WORKER_PORT
    // (bypassing the NODE_ENV=test guard, deliberately, to exercise the real
    // startup path). Left open, it collides with the next process that calls
    // start() on the same port — e.g. the golden-path suite immediately after.
    if (worker.metricsServer) {
      await new Promise<void>((resolve) => worker.metricsServer!.close(() => resolve()));
    }
  });

  it('records the CI signals and a trust score from one audit event', async () => {
    await worker.eventBus.publish(EVENT_TOPICS.AUDIT_COMPLETED, {
      contractId,
      maintainability: 82,
      passedTests: 10,
      totalTests: 10,
      vulnerabilities: 0,
      criticalVulns: 0,
      securityScanComplete: true,
    });

    // InMemoryBus awaits its handlers, and the handler awaits the trigger, so
    // by the time publish() resolves the whole chain has run. No polling.
    expect(scoreCalls).toEqual([contractId]);

    const { rows } = await pool.query(
      `SELECT ast_passed, tests_passed, security_passed, trust_score, critical_vulns
         FROM oracle_state WHERE contract_id = $1`,
      [contractId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].ast_passed).toBe(true);
    expect(rows[0].tests_passed).toBe(true);
    expect(rows[0].security_passed).toBe(true);
    // The assertion this whole file exists for.
    expect(rows[0].trust_score).not.toBeNull();
    expect(Number(rows[0].trust_score)).toBeCloseTo(93.5, 1);
    expect(rows[0].critical_vulns).toBe(0);
  });

  it('does not call the scorer when the audit event carries no contract id', async () => {
    scoreCalls = [];
    await worker.eventBus.publish(EVENT_TOPICS.AUDIT_COMPLETED, { maintainability: 82 });
    expect(scoreCalls).toEqual([]);
  });
});
