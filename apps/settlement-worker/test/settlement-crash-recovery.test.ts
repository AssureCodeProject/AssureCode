/**
 * Chaos test: settlement survives a worker crash (plan2 DoD #6, Phase 1.5a /
 * Phase 2 item 2.2).
 *
 * settlement-concurrency.test.ts proves single-fire against concurrent
 * *callers*. This proves the harder case: a *crash*. `claimSettlement` moves a
 * row to 'PROCESSING' before `capturePayment` runs, and only re-claims rows in
 * status 'FAILED' (worker.ts:274-276) — never 'PROCESSING'. If the process
 * dies between `capturePayment` (worker.ts:461) and `commitSettlement`
 * (worker.ts:480), no `catch` ever runs (`markSettlementFailed` only fires
 * from the `catch` at :497), so the row would be abandoned at 'PROCESSING'
 * forever while the payment has already been captured — were it not for
 * `reconcileAbandonedSettlements()`, run once at the end of `start()`, which
 * sweeps exactly these rows and resumes them (re-running capture, idempotent
 * either way, then the same commit/ledger/trust-score path the normal flow
 * uses). This test proves that recovery survives a real kill, not just a
 * reading of the code.
 *
 * The worker is run as a genuine child process, not imported in-process like
 * the other worker suites: you cannot cleanly interrupt an in-flight `await`
 * to simulate a crash, so recovery has to be observed purely through
 * Postgres, the way an operator would see it.
 *
 * Locating the kill precisely: FakeRazorpayAdapter's capturePayment() is an
 * in-memory Map operation with no simulated latency, so the true
 * capture-to-commit window is well under Node's timer resolution — not
 * reliably catchable by polling from an external process. Rather than modify
 * worker.ts to add a test hook (out of scope here; the fix belongs with 2.2,
 * not this test), a separate connection holds `SELECT ... FOR UPDATE` on the
 * escrow row before the settlement is triggered. commitSettlement's
 * transaction (worker.ts:299) updates that same row, so it blocks on this
 * lock — widening the observable PROCESSING window to exactly as long as
 * this test wants it, deterministically rather than by racing a timer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pg from 'pg';
import { loadDotEnv } from '../../../tools/test-support/env.js';
import { postgresAvailable, redisAvailable, announceSkip } from '../../../tools/test-support/infra.js';
import { buildDbConfig, getDatabaseUrl, loadConfig } from '@assurecode/config';
import { createEventBus, eventBusOptionsFromConfig } from '@assurecode/event-bus';
import { EVENT_TOPICS } from '@assurecode/shared';

loadDotEnv();

// The spawned worker forces a real event bus (EVENT_BUS_FORCE_REAL) rather
// than the in-memory one, since the crash has to be observable from outside
// its process — so this needs actual Redis, not just Postgres. The `test` CI
// job only brings up a Postgres service container (no Redis), which is
// exactly why every other Redis-dependent suite skips there; this one must
// too, or the spawned worker floods stderr with ECONNREFUSED and the test
// hangs instead of skipping.
const [pgUp, redisUp] = await Promise.all([postgresAvailable(), redisAvailable()]);
const available = pgUp && redisUp;
if (!pgUp) announceSkip('settlement crash recovery', 'PostgreSQL (DATABASE_URL)');
else if (!redisUp) announceSkip('settlement crash recovery', 'Redis (REDIS_URL)');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const workerDir = path.join(repoRoot, 'apps', 'settlement-worker');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

/** Polls rather than sleeping a fixed amount, matching the golden-path suite's waitFor. */
async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last !== null) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
}

describe.skipIf(!available)('settlement survives a worker crash', () => {
  const contractId = `AC-CRASH-TEST-${Date.now()}`;
  const freelancerId = 'FL-CRASH-TEST';
  const orderId = `order_crash_${Date.now()}`;
  const paymentId = `pay_crash_${Date.now()}`;
  let pool: pg.Pool;
  let worker: ChildProcess | undefined;

  const childEnv = () => ({
    ...process.env,
    // worker.ts only calls start() itself when NODE_ENV !== 'test'
    // (worker.ts:534) — every other suite imports the module under test and
    // calls start() explicitly, but a spawned child can't be driven that way,
    // so it needs the real auto-start path instead.
    NODE_ENV: 'development',
    // The child needs the same real bus as this test process, or it will
    // never see the SETTLEMENT_REQUESTED event published below — each
    // process otherwise gets its own private in-memory bus.
    EVENT_BUS_FORCE_REAL: 'true',
  });

  let workerOutput = '';
  let workerExited = false;

  function startWorker(): ChildProcess {
    workerOutput = '';
    workerExited = false;
    // Run from repoRoot with a repo-relative path, matching scripts/e2e.mjs's
    // convention (`npx tsx tools/migrate.ts`) — tsx/Node's ESM resolver ties
    // relative-path resolution to the process cwd, and on Windows `npx` does
    // not preserve a `cwd` passed only via spawn options the way running from
    // workerDir directly would suggest.
    const child = spawn(
      process.execPath,
      [tsxCli, path.relative(repoRoot, path.join(workerDir, 'src', 'worker.ts'))],
      {
        cwd: repoRoot,
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.on('data', (d) => {
      workerOutput += String(d);
      process.stdout.write(`[worker] ${d}`);
    });
    child.stderr?.on('data', (d) => {
      workerOutput += String(d);
      process.stderr.write(`[worker] ${d}`);
    });
    // A signal-terminated process (SIGKILL) reports exitCode: null and
    // signalCode: 'SIGKILL' instead — never exitCode — so this flag is what
    // killWorker()'s caller actually waits on, not exitCode/signalCode
    // directly.
    child.on('exit', () => {
      workerExited = true;
    });
    worker = child;
    return child;
  }

  /**
   * RedisStreamsBus creates its consumer group at '$' (worker.ts's
   * subscribeSettlementRequests -> event-bus RedisStreamsBus.subscribe) —
   * meaning only messages published *after* the group exists are ever
   * delivered. Publishing before the worker finishes subscribing silently
   * drops the event with no error on either side, so this has to be an
   * explicit wait rather than a short sleep-and-hope.
   */
  async function waitForWorkerReady(): Promise<void> {
    await waitFor(
      'worker ready log',
      async () => (workerOutput.includes('Settlement oracle ready.') ? true : null),
      15_000,
    );
  }

  function killWorker(signal: NodeJS.Signals = 'SIGKILL') {
    if (worker && !workerExited && !worker.killed) {
      worker.kill(signal);
    }
  }

  beforeAll(async () => {
    process.env.EVENT_BUS_FORCE_REAL = 'true';

    pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));

    await pool.query(
      `INSERT INTO contracts (contract_id, client_id, title, requirements, budget_cents, deadline, status)
       VALUES ($1, 'legacy-client', 'Crash recovery test', 'requirements', 250000, '2026-12-31', 'LOCKED')
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId],
    );

    // Escrow held and authorized, so OracleStore.findEscrowPayment() has
    // something to release — mirrors what the real flow reaches after a
    // funded escrow and a signed webhook (see golden-path.e2e.test.ts).
    await pool.query(
      `INSERT INTO escrow (order_id, contract_id, payment_id, amount_cents, currency, status, authorized_at)
       VALUES ($1, $2, $3, 250000, 'INR', 'AUTHORIZED', now())
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, contractId, paymentId],
    );

    // Every oracle gate satisfied, so evaluate() approves without needing to
    // drive CI or a real audit through this contract.
    await pool.query(
      `INSERT INTO oracle_state (contract_id, ast_passed, tests_passed, security_passed, trust_score, critical_vulns, scored_at, updated_at)
       VALUES ($1, true, true, true, 95, 0, now(), now())
       ON CONFLICT (contract_id) DO UPDATE
         SET ast_passed = true, tests_passed = true, security_passed = true,
             trust_score = 95, critical_vulns = 0, scored_at = now(), updated_at = now()`,
      [contractId],
    );
  }, 60_000);

  afterAll(async () => {
    killWorker();
    await pool?.query('DELETE FROM merkle_ledger WHERE contract_id = $1', [contractId]);
    await pool?.query('DELETE FROM settlements WHERE contract_id = $1', [contractId]);
    await pool?.query('DELETE FROM oracle_state WHERE contract_id = $1', [contractId]);
    await pool?.query('DELETE FROM escrow WHERE contract_id = $1', [contractId]);
    await pool?.query('DELETE FROM contracts WHERE contract_id = $1', [contractId]);
    await pool?.end();
  });

  it(
    'recovers to exactly one COMPLETED settlement after the worker is killed mid-settlement',
    async () => {
      // Held for the whole test, released only after the worker is killed —
      // see the header comment on why this, rather than a timing race,
      // is what pins the worker inside the PROCESSING window.
      const lockClient = new pg.Client(buildDbConfig(getDatabaseUrl(loadConfig())));
      await lockClient.connect();
      await lockClient.query('BEGIN');
      await lockClient.query('SELECT * FROM escrow WHERE contract_id = $1 FOR UPDATE', [
        contractId,
      ]);

      try {
        startWorker();
        await waitForWorkerReady();

        // The bus this test process publishes on has to be the same real bus
        // the child subscribes to — same reasoning as EVENT_BUS_FORCE_REAL
        // above, applied to this process's own eventBus construction.
        const bus = createEventBus(eventBusOptionsFromConfig(loadConfig()));
        await bus.publish(EVENT_TOPICS.SETTLEMENT_REQUESTED, {
          contractId,
          freelancerId,
          amountCents: 250000,
          requestedAt: new Date().toISOString(),
        });

        // claimSettlement() moves the row to PROCESSING and capturePayment()
        // resolves immediately after; commitSettlement() then blocks on the
        // lock held above, so PROCESSING persists until this test releases
        // it — no race with a timer.
        await waitFor('settlement PROCESSING', async () => {
          const { rows } = await pool.query(
            `SELECT status FROM settlements WHERE contract_id = $1 AND status = 'PROCESSING'`,
            [contractId],
          );
          return rows[0] ?? null;
        });

        killWorker('SIGKILL');
        await waitFor('worker process exit', async () => (workerExited ? true : null));
      } finally {
        // Release the lock regardless of outcome: the worker's own connection
        // is already gone (killed), so its blocked UPDATE was already rolled
        // back by Postgres — this only unblocks anything else on that row.
        await lockClient.query('ROLLBACK').catch(() => undefined);
        await lockClient.end().catch(() => undefined);
      }

      // Nothing today recovers an abandoned PROCESSING row — restarting the
      // worker exercises exactly the recovery path (a reconciler on startup,
      // or equivalent) that Phase 2 item 2.2 has not been built yet. This is
      // expected to time out / fail until that lands.
      startWorker();
      await waitForWorkerReady();

      const settlement = await waitFor(
        'settlement COMPLETED',
        async () => {
          const { rows } = await pool.query(
            `SELECT status FROM settlements WHERE contract_id = $1 AND status = 'COMPLETED'`,
            [contractId],
          );
          return rows[0] ?? null;
        },
        45_000,
      );
      expect(settlement.status).toBe('COMPLETED');

      const { rows: allSettlements } = await pool.query(
        `SELECT status FROM settlements WHERE contract_id = $1`,
        [contractId],
      );
      expect(allSettlements).toHaveLength(1);

      const { rows: ledgerEntries } = await pool.query(
        `SELECT action_type FROM merkle_ledger WHERE contract_id = $1 AND action_type = 'SETTLEMENT_COMPLETED'`,
        [contractId],
      );
      expect(ledgerEntries).toHaveLength(1);
    },
    120_000,
  );
});
