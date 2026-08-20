/**
 * AssureCode benchmark — real HTTP against a running system.
 *
 * What this replaced
 * ------------------
 * The previous version probed `/healthz`, ignored the answer beyond printing
 * "OFFLINE (Simulated Engine Execution)", and then measured `setTimeout`:
 *
 *     const tInit0 = Date.now();
 *     await delay(45);                       // <- the "init latency"
 *     const initLatencyMs = Date.now() - tInit0;
 *
 * Every latency it published was the sleep it had just performed, jittered by
 * 10%. The scope-accuracy figures were worse. It declared OFF_SCOPE_PROMPTS and
 * IN_SCOPE_PROMPTS at the top of the file and never referenced either one; the
 * classification was:
 *
 *     const isInScopeExpected = idx <= 80;   // ground truth
 *     ...
 *     if (isInScopeExpected) { isAllowedActual = true; }   // prediction
 *
 * Prediction was assigned from ground truth, so TP=80, TN=20, FP=FN=0 and
 * accuracy, precision, recall and F1 were all exactly 100% — by construction,
 * for any system, including no system at all. Those numbers reached the
 * specification as measurements.
 *
 * What this does instead
 * ----------------------
 * Drives the real endpoints over HTTP and times the responses. The scope
 * classification sends the prompts that were sitting unused and compares the
 * gateway's actual verdict against the label. It is expected NOT to score 100%
 * — the scope threshold was calibrated at 14/16 on its own selection set, with
 * two false positives — and a benchmark that reports less than perfect accuracy
 * is the one worth reading.
 *
 * No simulation path exists. If the gateway is unreachable the process exits
 * non-zero, because a benchmark that degrades to sleeping produces numbers
 * indistinguishable from measurements.
 *
 * Usage:
 *   node tools/benchmark.js                     # 30 contracts, concurrency 5
 *   node tools/benchmark.js --contracts 100 --concurrency 10
 *   node tools/benchmark.js --keep              # do not delete the fixtures
 *
 * Requires the api-gateway, ai-service and scope-guard to be running.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig } from '@assurecode/config';

// This is a machine caller, not a logged-in user — it authenticates with the
// shared SERVICE_TOKEN the gateway's auth guard accepts in place of a JWT.
const SERVICE_TOKEN = loadConfig().SERVICE_TOKEN;

// ── Fixtures ────────────────────────────────────────────────────────────
//
// These are the arrays the old benchmark declared and never used. They are the
// input now, so the reported accuracy is a property of the scope guard rather
// than of the loop that calls it.

const REQUIREMENTS = [
  'Build a REST API for user login and session management using Fastify.',
  'Persist user accounts and sessions in PostgreSQL with schema migrations.',
  'Return JSON error responses with appropriate HTTP status codes.',
  'Write Jest integration tests covering the authentication endpoints.',
  'Add input validation and sanitization on all user-supplied fields.',
].join(' ');

const IN_SCOPE_PROMPTS = [
  'Please update the user settings page according to requirement specification section 3.2.',
  'Implement the unit tests for the authentication endpoint.',
  'Fix the cyclomatic complexity warning in the database connection handler.',
  'Add input sanitization for the profile name field.',
  'Refactor the API response helper to handle standard error status codes.',
];

const OFF_SCOPE_PROMPTS = [
  'Can you please overhaul the whole architecture for free?',
  'Add a mobile app without extra budget.',
  'Redesign everything and include extra feature at no extra cost.',
  'Include unpaid maintenance for 5 years.',
  'Design a new company logo and brand guidelines.',
];

const BENCH_PREFIX = 'AC-BENCH-';

// ── Argument parsing ────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    contracts: 30,
    concurrency: 5,
    gatewayUrl: process.env.GATEWAY_URL || 'http://localhost:4000',
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--contracts') opts.contracts = Number(argv[++i]);
    else if (argv[i] === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (argv[i] === '--gateway') opts.gatewayUrl = argv[++i];
    else if (argv[i] === '--keep') opts.keep = true;
  }
  return opts;
}

// ── Statistics ──────────────────────────────────────────────────────────

function percentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return Number(sorted[Math.max(0, index)].toFixed(2));
}

function mean(arr) {
  if (arr.length === 0) return null;
  return Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2));
}

function stdev(arr) {
  if (arr.length < 2) return null;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Number(Math.sqrt(v).toFixed(2));
}

/** Latency summary. Nulls, not zeros, when nothing was measured — a zero here
 *  would read as "instantaneous" rather than "never ran". */
function summarize(arr) {
  return {
    n: arr.length,
    mean: mean(arr),
    stdev: stdev(arr),
    p50: percentile(arr, 50),
    p90: percentile(arr, 90),
    p99: percentile(arr, 99),
    min: arr.length ? Number(Math.min(...arr).toFixed(2)) : null,
    max: arr.length ? Number(Math.max(...arr).toFixed(2)) : null,
  };
}

// ── Timed HTTP ──────────────────────────────────────────────────────────

async function timed(fn) {
  const t0 = performance.now();
  try {
    const res = await fn();
    return { ms: Number((performance.now() - t0).toFixed(2)), res, error: null };
  } catch (err) {
    return {
      ms: Number((performance.now() - t0).toFixed(2)),
      res: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function post(url, body, timeoutMs = 20_000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-service-token': SERVICE_TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

// ── Main ────────────────────────────────────────────────────────────────

export async function runBenchmark(opts) {
  const { contracts: totalContracts, concurrency, gatewayUrl, keep } = opts;

  console.log('='.repeat(72));
  console.log('  AssureCode benchmark — live HTTP, no simulation path');
  console.log('='.repeat(72));
  console.log(`  gateway     : ${gatewayUrl}`);
  console.log(`  contracts   : ${totalContracts}`);
  console.log(`  concurrency : ${concurrency}`);

  // ── Preflight. Offline is fatal. ──────────────────────────────────────
  let health;
  try {
    health = await fetch(`${gatewayUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
  } catch (err) {
    console.error(
      `\nGateway unreachable at ${gatewayUrl}: ${err instanceof Error ? err.message : String(err)}\n` +
        'Refusing to produce benchmark numbers without a system to measure.\n' +
        'Start it with:  npm run dev:gateway',
    );
    return { exitCode: 1 };
  }
  if (!health.ok) {
    console.error(`\nGateway returned HTTP ${health.status} from /healthz. Aborting.`);
    return { exitCode: 1 };
  }

  // Readiness tells us whether the dependencies the benchmark exercises are
  // actually up, so a run against a half-started system is labelled rather than
  // quietly producing fast, meaningless numbers.
  let readiness = null;
  try {
    const r = await fetch(`${gatewayUrl}/readyz`, { signal: AbortSignal.timeout(5000) });
    readiness = await r.json();
  } catch {
    readiness = null;
  }
  console.log(`  readiness   : ${readiness ? JSON.stringify(readiness) : 'unavailable'}`);
  if (readiness && readiness.redis !== 'ok') {
    // Recorded, not tolerated silently. With no Redis the gateway runs an
    // in-process bus, so these latencies exclude the cost of a real event
    // publish and are a lower bound on a deployed system's.
    console.log(
      `  NOTE        : redis is "${readiness.redis}" — event publishes are in-process, so the\n` +
        '                latencies below exclude broker round-trips and understate production.',
    );
  }
  console.log('-'.repeat(72) + '\n');

  const startTime = performance.now();
  const results = [];
  const queue = Array.from({ length: totalContracts }, (_, i) => i + 1);

  async function worker() {
    for (;;) {
      const idx = queue.shift();
      if (idx === undefined) break;

      // 80/20 in-scope to off-scope, and the label is used ONLY to choose which
      // prompt to send and to score the answer afterwards. It is never used to
      // decide the verdict.
      const expectInScope = idx <= Math.floor(totalContracts * 0.8);
      const prompt = expectInScope
        ? IN_SCOPE_PROMPTS[idx % IN_SCOPE_PROMPTS.length]
        : OFF_SCOPE_PROMPTS[idx % OFF_SCOPE_PROMPTS.length];

      const row = {
        idx,
        contractId: null,
        expectInScope,
        prompt,
        allowedActual: null,
        similarity: null,
        phases: {},
        errors: [],
        status: 'OK',
      };

      // 1. initialize
      const init = await timed(() =>
        post(`${gatewayUrl}/api/contracts/initialize`, {
          title: `Benchmark contract ${idx}`,
          requirements: REQUIREMENTS,
          budgetCents: 250000,
          deadline: '2026-12-31',
        }),
      );
      row.phases.initialize = init.ms;
      if (init.error || !init.res?.ok) {
        row.status = 'INIT_FAILED';
        row.errors.push(`initialize: ${init.error ?? `HTTP ${init.res?.status}`}`);
        results.push(row);
        continue;
      }
      row.contractId = init.res.json?.contractId ?? null;

      // 2. lock — appends to the ledger and triggers RAG ingest
      const lock = await timed(() =>
        post(`${gatewayUrl}/api/contracts/${row.contractId}/lock`, {
          title: `Benchmark contract ${idx}`,
          requirements: REQUIREMENTS,
          budgetCents: 250000,
          deadline: '2026-12-31',
        }),
      );
      row.phases.lock = lock.ms;
      if (lock.error || !lock.res?.ok) {
        row.status = 'LOCK_FAILED';
        row.errors.push(`lock: ${lock.error ?? `HTTP ${lock.res?.status}`}`);
      }

      // 3. escrow
      const escrow = await timed(() =>
        post(`${gatewayUrl}/api/contracts/${row.contractId}/escrow`, { amountCents: 250000 }),
      );
      row.phases.escrow = escrow.ms;
      if (escrow.error || !escrow.res?.ok) {
        row.status = row.status === 'OK' ? 'ESCROW_FAILED' : row.status;
        row.errors.push(`escrow: ${escrow.error ?? `HTTP ${escrow.res?.status}`}`);
      }

      // 4. scope check.
      //
      // Ingest is fire-and-forget from lock, so a contract may not be indexed
      // yet and the guard answers 409. That is retried on a bounded budget and
      // the wait is recorded separately, so ingest latency is not smuggled into
      // the scope-check figure.
      // The budget is 30s rather than a few seconds because the first ingest of
      // a cold process loads all-MiniLM-L6-v2, which takes tens of seconds. A
      // short budget made every contract in a run report SCOPE_UNAVAILABLE and
      // looked like a broken scope guard rather than a cold model.
      const scopeStart = performance.now();
      let scope = null;
      let waits = 0;
      for (let attempt = 0; attempt < 30; attempt++) {
        scope = await timed(() =>
          post(`${gatewayUrl}/api/contracts/${row.contractId}/chat`, {
            message: prompt,
            sender: 'client',
          }),
        );
        // 409 from the guard means "nothing indexed for this contract yet".
        if (scope.res?.status === 409) {
          waits++;
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        break;
      }
      row.phases.scopeWaitForIngestMs = Number((performance.now() - scopeStart - (scope?.ms ?? 0)).toFixed(2));
      row.phases.scopeCheck = scope?.ms ?? null;
      row.ingestRetries = waits;

      if (scope?.error) {
        row.status = row.status === 'OK' ? 'SCOPE_ERROR' : row.status;
        row.errors.push(`scope: ${scope.error}`);
      } else if (scope?.res?.status === 200) {
        row.allowedActual = true;
        row.status = row.status === 'OK' ? 'DELIVERED' : row.status;
      } else if (scope?.res?.status === 403) {
        row.allowedActual = false;
        row.status = row.status === 'OK' ? 'SCOPE_BLOCKED' : row.status;
      } else {
        // 409 after the retry budget, or 503 — no verdict was produced, so this
        // contract contributes to neither the numerator nor the denominator of
        // the accuracy figures. Excluding it is the honest treatment; scoring it
        // as a miss would blame the classifier for never having been asked.
        row.status = row.status === 'OK' ? 'SCOPE_UNAVAILABLE' : row.status;
        row.errors.push(`scope: HTTP ${scope?.res?.status} after ${waits} retries`);
      }

      results.push(row);
      if (results.length % 10 === 0 || results.length === totalContracts) {
        process.stdout.write(`  progress: ${results.length}/${totalContracts}\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const durationSeconds = Number(((performance.now() - startTime) / 1000).toFixed(2));

  // ── Scope accuracy, over contracts that actually got a verdict ────────
  const scored = results.filter((r) => r.allowedActual !== null);
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (const r of scored) {
    if (r.expectInScope && r.allowedActual) tp++;
    else if (!r.expectInScope && !r.allowedActual) tn++;
    else if (!r.expectInScope && r.allowedActual) fp++;
    else fn++;
  }

  const div = (a, b) => (b === 0 ? null : Number(((a / b) * 100).toFixed(2)));
  const precision = div(tp, tp + fp);
  const recall = div(tp, tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : Number(((2 * precision * recall) / (precision + recall)).toFixed(2));

  const collect = (key) => results.map((r) => r.phases[key]).filter((v) => typeof v === 'number');

  const summary = {
    timestamp: new Date().toISOString(),
    gatewayUrl,
    readiness,
    totalContracts,
    concurrency,
    durationSeconds,
    throughputContractsPerSec: Number((totalContracts / durationSeconds).toFixed(2)),
    completed: results.filter((r) => r.errors.length === 0).length,
    withErrors: results.filter((r) => r.errors.length > 0).length,
    latencyMs: {
      initialize: summarize(collect('initialize')),
      lock: summarize(collect('lock')),
      escrow: summarize(collect('escrow')),
      scopeCheck: summarize(collect('scopeCheck')),
    },
    ingest: {
      contractsNeedingRetry: results.filter((r) => (r.ingestRetries ?? 0) > 0).length,
      waitMs: summarize(collect('scopeWaitForIngestMs')),
      note: 'RAG ingest is fire-and-forget from lock; this wait is excluded from scopeCheck.',
    },
    scopeAccuracy: {
      scoredContracts: scored.length,
      excludedNoVerdict: results.length - scored.length,
      truePositives: tp,
      trueNegatives: tn,
      falsePositives: fp,
      falseNegatives: fn,
      accuracy: div(tp + tn, scored.length),
      precision,
      recall,
      f1,
      note:
        'Labels choose which prompt is sent and score the answer. They never determine the ' +
        'verdict. Contracts that received no verdict are excluded, not counted as errors.',
    },
    statusCounts: results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {}),
    results,
  };

  // ── Report ────────────────────────────────────────────────────────────
  const outputDir = path.join(process.cwd(), 'docs', 'benchmarks');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'benchmark_results.json');
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf-8');

  const fmt = (v) => (v === null ? 'n/a' : v);
  console.log('\n' + '-'.repeat(72));
  console.log(' RESULTS');
  console.log('-'.repeat(72));
  console.log(` duration                : ${summary.durationSeconds}s`);
  console.log(` throughput              : ${summary.throughputContractsPerSec} contracts/s`);
  console.log(` contracts with errors   : ${summary.withErrors}/${totalContracts}`);
  console.log('');
  for (const [phase, s] of Object.entries(summary.latencyMs)) {
    console.log(
      ` ${phase.padEnd(12)} n=${String(s.n).padStart(4)}  mean ${String(fmt(s.mean)).padStart(8)} ms` +
        `  sd ${String(fmt(s.stdev)).padStart(8)}  p50 ${String(fmt(s.p50)).padStart(8)}` +
        `  p90 ${String(fmt(s.p90)).padStart(8)}  p99 ${String(fmt(s.p99)).padStart(8)}`,
    );
  }
  console.log('');
  const a = summary.scopeAccuracy;
  console.log(` scope verdicts scored   : ${a.scoredContracts} (${a.excludedNoVerdict} excluded, no verdict)`);
  console.log(` TP ${a.truePositives}  TN ${a.trueNegatives}  FP ${a.falsePositives}  FN ${a.falseNegatives}`);
  console.log(` accuracy                : ${fmt(a.accuracy)}%`);
  console.log(` precision / recall      : ${fmt(a.precision)}% / ${fmt(a.recall)}%`);
  console.log(` F1                      : ${fmt(a.f1)}%`);
  console.log('');
  console.log(` status counts           : ${JSON.stringify(summary.statusCounts)}`);
  console.log(` results written to      : ${outputPath}`);
  console.log('='.repeat(72));

  if (a.f1 === 100 && a.scoredContracts > 0) {
    console.log(
      '\nNOTE: a perfect F1 on this fixture is suspicious rather than good. The scope threshold\n' +
        'measures 79% accuracy on a held-out split of its calibration corpus, so 100% here\n' +
        'suggests the prompts are too easy to separate, not that the classifier is flawless.',
    );
  } else if (a.recall !== null && a.recall < 60) {
    console.log(
      `\nNOTE: recall is ${a.recall}% — ${a.falseNegatives} in-scope requests were blocked. The\n` +
        'threshold (SCOPE_SIMILARITY_THRESHOLD, default 0.3056) was selected on a different\n' +
        'set of contracts, and this measures how far that choice generalises. It is a\n' +
        'property of the calibration, not a transient fault: precision is ' +
        `${a.precision}%, so the guard is not\nmisfiring at random, it is simply too strict for this contract text.`,
    );
  }

  // ── Cleanup ───────────────────────────────────────────────────────────
  if (!keep) {
    const removed = await cleanup(results.map((r) => r.contractId).filter(Boolean));
    console.log(`\ncleanup: removed ${removed} benchmark contracts (pass --keep to retain).`);
  } else {
    console.log('\n--keep given: benchmark contracts left in the database.');
  }

  // A run in which nothing could be scored is not a successful run.
  const exitCode = a.scoredContracts === 0 || summary.withErrors === totalContracts ? 1 : 0;
  return { exitCode, summary };
}

/** Delete the fixtures this run created. Best-effort and reported. */
async function cleanup(contractIds) {
  if (contractIds.length === 0) return 0;
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const envPath = path.join(repoRoot, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const [k, ...rest] = t.split('=');
      if (process.env[k.trim()] === undefined) {
        process.env[k.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  if (!process.env.DATABASE_URL) return 0;

  try {
    const { default: pg } = await import('pg');
    const { buildDbConfig } = await import('@assurecode/config');
    const pool = new pg.Pool(buildDbConfig(process.env.DATABASE_URL));
    try {
      for (const table of ['scope_checks', 'escrow', 'oracle_state', 'merkle_roots', 'merkle_ledger', 'rag_embeddings']) {
        await pool.query(`DELETE FROM ${table} WHERE contract_id = ANY($1)`, [contractIds]).catch(() => {});
      }
      const res = await pool.query('DELETE FROM contracts WHERE contract_id = ANY($1)', [contractIds]);
      return res.rowCount ?? 0;
    } finally {
      await pool.end();
    }
  } catch (err) {
    console.warn(`cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

if (import.meta.filename === process.argv[1]) {
  const opts = parseArgs(process.argv.slice(2));
  runBenchmark(opts)
    .then(({ exitCode }) => process.exit(exitCode))
    .catch((err) => {
      console.error('Benchmark failed:', err);
      process.exit(1);
    });
}
