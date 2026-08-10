/**
 * Phase 5 live verification — Objective 4 end to end.
 *
 * The plan's gate for this phase is two claims:
 *
 *     "trust score varies with real telemetry; settlement rejects below 85"
 *
 * Both are checked here against live PostgreSQL and a live ai-service, using the
 * shipped code paths rather than copies of them: `PostgresAuditStore` writes the
 * telemetry, the real `/xai/score` endpoint computes the score, and `OracleStore`
 * — the same class the settlement worker calls — decides whether to release.
 *
 * Why it is written this way
 * --------------------------
 * The previous settlement test defined its own `checkOracle` helper inside the
 * test file and asserted against that, so it passed whether or not the shipped
 * gate existed. A verification script that reimplements the thing it verifies
 * proves only that the author can write the same bug twice. Every assertion
 * below therefore runs through an import from the built packages.
 *
 * There is no simulation fallback. If Postgres or the ai-service is unreachable,
 * this exits non-zero and says which one — an unverifiable claim is not a
 * passing one.
 *
 * Prerequisites:
 *   npm run build
 *   cd apps/ai-service && .venv/Scripts/python.exe -m uvicorn app.main:app --port 8000
 *
 * Run:
 *   node tools/verify_phase5_live.mjs
 *
 * Everything it writes is namespaced under a run-specific contract id and
 * deleted in a finally block, so it is safe against a shared database.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDbConfig } from '@assurecode/config';
import { OracleStore, TRUST_SCORE_THRESHOLD } from '@assurecode/oracle';
import { PostgresAuditStore } from '@assurecode/ci-worker/dist/audit-store.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

// ── .env ────────────────────────────────────────────────────────────────
{
  const envPath = resolve(REPO_ROOT, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [k, ...rest] = trimmed.split('=');
      if (process.env[k.trim()] === undefined) {
        process.env[k.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
      }
    }
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Configure .env before running this script.');
  process.exit(1);
}

// ── Assertion plumbing ──────────────────────────────────────────────────
const failures = [];
let checks = 0;

function check(label, ok, detail = '') {
  checks += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

// ── The published formula, recomputed independently ─────────────────────
//
// This is the one deliberate duplication in the file. Re-deriving the score by
// hand is how we check that the service computes the formula in the paper
// rather than some other formula that happens to be deterministic.
const W = { test: 0.4, maint: 0.25, sec: 0.2, scope: 0.15 };

function expectedScore(t, adherenceRatio) {
  const sTest = (100 * t.passed_tests) / t.total_tests;
  const sMaint = t.maintainability;
  const sSec = Math.max(
    0,
    100 - 40 * t.critical_vulnerabilities - 20 * t.high_vulnerabilities - 5 * t.total_vulnerabilities,
  );

  if (adherenceRatio === null) {
    // Unmeasured scope: the three measured weights renormalise over their sum.
    const norm = W.test + W.maint + W.sec;
    return (
      round2((W.test / norm) * sTest) +
      round2((W.maint / norm) * sMaint) +
      round2((W.sec / norm) * sSec)
    );
  }
  return (
    round2(W.test * sTest) +
    round2(W.maint * sMaint) +
    round2(W.sec * sSec) +
    round2(W.scope * (100 * adherenceRatio))
  );
}

// The service rounds each contribution to 2dp and sums those, so the check has
// to round the same way to compare exactly rather than approximately.
const round2 = (n) => Math.round(n * 100) / 100;

// ── Telemetry fixtures ──────────────────────────────────────────────────
const GOOD = {
  maintainability: 88.0,
  cyclomatic_complexity: 4,
  passed_tests: 20,
  total_tests: 20,
  total_vulnerabilities: 0,
  critical_vulnerabilities: 0,
  high_vulnerabilities: 0,
};

const MEDIOCRE = {
  maintainability: 55.0,
  cyclomatic_complexity: 19,
  passed_tests: 13,
  total_tests: 20,
  total_vulnerabilities: 3,
  critical_vulnerabilities: 0,
  high_vulnerabilities: 1,
};

const CRITICAL = {
  maintainability: 92.0,
  cyclomatic_complexity: 3,
  passed_tests: 20,
  total_tests: 20,
  total_vulnerabilities: 1,
  critical_vulnerabilities: 1,
  high_vulnerabilities: 0,
};

// ── Helpers ─────────────────────────────────────────────────────────────
async function scoreVia(contractId, telemetry) {
  const res = await fetch(`${AI_SERVICE_URL}/xai/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contract_id: contractId,
      freelancer_id: 'verify-freelancer',
      telemetry,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function auditPayload(contractId, telemetry) {
  return {
    contractId,
    maintainability: telemetry.maintainability,
    cyclomaticComplexity: telemetry.cyclomatic_complexity,
    passedTests: telemetry.passed_tests,
    totalTests: telemetry.total_tests,
    vulnerabilities: telemetry.total_vulnerabilities,
    criticalVulns: telemetry.critical_vulnerabilities,
    highVulns: telemetry.high_vulnerabilities,
    securityScore: 0,
    passed: telemetry.total_vulnerabilities === 0,
    scanDuration: 0.01,
    timestamp: new Date().toISOString(),
  };
}

// ── Main ────────────────────────────────────────────────────────────────
const contractId = `VERIFY-P5-${randomUUID().slice(0, 8).toUpperCase()}`;
const pool = new pg.Pool(buildDbConfig(DATABASE_URL));
const oracle = new OracleStore(pool);
const auditStore = new PostgresAuditStore(DATABASE_URL);

console.log('='.repeat(78));
console.log('  Phase 5 live verification — telemetry-driven trust score + settlement oracle');
console.log('='.repeat(78));
console.log(`  contract: ${contractId}`);
console.log(`  database: ${DATABASE_URL.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
console.log(`  ai-service: ${AI_SERVICE_URL}`);

try {
  // ── 0. Preflight ──────────────────────────────────────────────────────
  section('0. Preflight');

  await pool.query('SELECT 1');
  check('PostgreSQL reachable', true);

  let aiUp = false;
  try {
    const res = await fetch(`${AI_SERVICE_URL}/healthz`, { signal: AbortSignal.timeout(5000) });
    aiUp = res.ok;
  } catch {
    aiUp = false;
  }
  if (!aiUp) {
    console.error(
      `\n  ai-service is not answering at ${AI_SERVICE_URL}. Start it with:\n` +
        '    cd apps/ai-service && .venv/Scripts/python.exe -m uvicorn app.main:app --port 8000\n' +
        '  Refusing to report a Phase 5 result without the scorer under test.',
    );
    process.exit(1);
  }
  check('ai-service reachable', true);

  await pool.query(
    `INSERT INTO contracts (contract_id, client_id, freelancer_id, title, requirements, budget_cents, deadline, status)
     VALUES ($1, 'verify-client', 'verify-freelancer', 'Phase 5 verification', 'Verification fixture.', 250000, '2026-12-31', 'IN_PROGRESS')`,
    [contractId],
  );
  check('fixture contract created', true);

  // ── 1. The score varies with telemetry ────────────────────────────────
  section('1. The trust score is a function of telemetry, not a constant');

  const good = await scoreVia(contractId, GOOD);
  const mediocre = await scoreVia(contractId, MEDIOCRE);

  check('good telemetry scores 200', good.status === 200, `HTTP ${good.status}`);
  check('mediocre telemetry scores 200', mediocre.status === 200, `HTTP ${mediocre.status}`);

  const goodScore = good.body.trust_score;
  const mediocreScore = mediocre.body.trust_score;

  check(
    'different telemetry produces different scores',
    goodScore !== mediocreScore,
    `${goodScore} vs ${mediocreScore}`,
  );
  check(
    'better telemetry scores higher',
    goodScore > mediocreScore,
    `${goodScore} > ${mediocreScore}`,
  );
  check(
    'the old hardcoded 0.92 is gone',
    goodScore !== 0.92 && mediocreScore !== 0.92,
    'neither score is the former constant',
  );
  check(
    'the score is on 0-100, as the settlement gate requires',
    goodScore > 1 && goodScore <= 100,
    `${goodScore}`,
  );

  // ── 2. It matches the published formula ───────────────────────────────
  section('2. The score is the published formula, recomputed independently');

  // No scope checks recorded yet, so the fourth term is unmeasured.
  check(
    'scope term reported unmeasured with no recorded checks',
    good.body.scope_measured === false,
    `scope_measured=${good.body.scope_measured}`,
  );

  const goodExpected = expectedScore(GOOD, null);
  check(
    'good telemetry matches hand-computed value',
    Math.abs(goodScore - goodExpected) < 0.011,
    `service ${goodScore}, independent ${goodExpected}`,
  );

  const mediocreExpected = expectedScore(MEDIOCRE, null);
  check(
    'mediocre telemetry matches hand-computed value',
    Math.abs(mediocreScore - mediocreExpected) < 0.011,
    `service ${mediocreScore}, independent ${mediocreExpected}`,
  );

  const repeat = await scoreVia(contractId, GOOD);
  check(
    'the same telemetry always produces the same score (deterministic)',
    repeat.body.trust_score === goodScore,
    `${repeat.body.trust_score} == ${goodScore}`,
  );

  check(
    'contributions sum to the reported score',
    Math.abs(good.body.terms.reduce((a, t) => a + t.contribution, 0) - goodScore) < 0.011,
    `terms sum to ${round2(good.body.terms.reduce((a, t) => a + t.contribution, 0))}`,
  );

  // ── 3. Refusals rather than defaults ──────────────────────────────────
  section('3. Missing or inconsistent telemetry is refused, not defaulted');

  const noTests = await scoreVia(contractId, { ...GOOD, passed_tests: 0, total_tests: 0 });
  check('0/0 tests is refused with 409', noTests.status === 409, `HTTP ${noTests.status}`);

  const inconsistent = await scoreVia(contractId, {
    ...GOOD,
    total_vulnerabilities: 1,
    critical_vulnerabilities: 2,
  });
  check(
    'critical+high exceeding the total is refused with 422',
    inconsistent.status === 422,
    `HTTP ${inconsistent.status}`,
  );

  const empty = await fetch(`${AI_SERVICE_URL}/xai/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contract_id: contractId, freelancer_id: 'f', telemetry: {} }),
  });
  check(
    'an empty telemetry body is rejected rather than scored on defaults',
    empty.status === 422,
    `HTTP ${empty.status}`,
  );

  // ── 4. The scope term comes from recorded decisions ───────────────────
  section('4. The fourth term is read from recorded scope decisions');

  const genesis = 'a'.repeat(64);
  const insertScope = (allowed) =>
    pool.query(
      `INSERT INTO scope_checks (contract_id, sender, message, allowed, similarity, threshold, genesis_hash)
       VALUES ($1, 'client', 'verification message', $2, 0.5, 0.2731, $3)`,
      [contractId, allowed, genesis],
    );

  await insertScope(true);
  await insertScope(true);
  await insertScope(true);
  await insertScope(false);

  const withScope = await scoreVia(contractId, GOOD);
  check(
    'scope term becomes measured once decisions exist',
    withScope.body.scope_measured === true,
    `scope_measured=${withScope.body.scope_measured}`,
  );
  check(
    'the score changes when the scope term appears',
    withScope.body.trust_score !== goodScore,
    `${goodScore} (unmeasured) -> ${withScope.body.trust_score} (3/4 adherence)`,
  );
  check(
    'the scope-weighted score matches the hand-computed value',
    Math.abs(withScope.body.trust_score - expectedScore(GOOD, 3 / 4)) < 0.011,
    `service ${withScope.body.trust_score}, independent ${expectedScore(GOOD, 3 / 4)}`,
  );

  // Clear them again so the oracle section starts from a clean scope history.
  await pool.query('DELETE FROM scope_checks WHERE contract_id = $1', [contractId]);

  // ── 5. The settlement gate ────────────────────────────────────────────
  section(`5. Settlement rejects below ${TRUST_SCORE_THRESHOLD} (the plan's stated gate)`);

  // Nothing recorded yet.
  let verdict = await oracle.evaluate(contractId);
  check(
    'an unaudited contract is blocked',
    !verdict.approved,
    `${verdict.blockers.length} blocker(s)`,
  );
  check(
    'an unscored contract blocks on the missing score, not a default',
    verdict.blockers.some((b) => b.includes('no trust score recorded')),
    verdict.blockers.find((b) => b.includes('trust score')) ?? 'no such blocker',
  );

  await oracle.recordAudit(contractId, {
    astPassed: true,
    testsPassed: true,
    securityPassed: true,
  });

  // Just below the threshold.
  await oracle.recordScore(contractId, TRUST_SCORE_THRESHOLD - 0.01, 0);
  verdict = await oracle.evaluate(contractId);
  check(
    `${TRUST_SCORE_THRESHOLD - 0.01} is rejected`,
    !verdict.approved,
    verdict.blockers.join('; ') || 'approved',
  );

  // Exactly at the threshold — `>= 85` must include 85.
  await oracle.recordScore(contractId, TRUST_SCORE_THRESHOLD, 0);
  verdict = await oracle.evaluate(contractId);
  check(
    `exactly ${TRUST_SCORE_THRESHOLD} is approved (the gate is >=, not >)`,
    verdict.approved,
    verdict.blockers.join('; ') || 'approved',
  );

  // Above the threshold but with a critical finding.
  await oracle.recordScore(contractId, 99, 1);
  verdict = await oracle.evaluate(contractId);
  check(
    'a critical vulnerability blocks even at score 99',
    !verdict.approved,
    verdict.blockers.join('; ') || 'approved',
  );

  // Back to a passing state, then reject a scope check.
  await oracle.recordScore(contractId, 95, 0);
  verdict = await oracle.evaluate(contractId);
  check('score 95 with no criticals is approved', verdict.approved, verdict.blockers.join('; '));

  await insertScope(true);
  verdict = await oracle.evaluate(contractId);
  check('an allowed scope check keeps it approved', verdict.approved, verdict.blockers.join('; '));

  await insertScope(false);
  verdict = await oracle.evaluate(contractId);
  check(
    'one rejected scope check blocks settlement (the signal cannot latch open)',
    !verdict.approved && !verdict.signals.scopePassed,
    verdict.blockers.join('; ') || 'approved',
  );

  await pool.query('DELETE FROM scope_checks WHERE contract_id = $1', [contractId]);

  // ── 6. Real audit telemetry drives the whole chain ────────────────────
  section('6. The shipped audit store feeds the shipped scorer');

  await auditStore.save(auditPayload(contractId, CRITICAL));
  const stored = await pool.query(
    'SELECT payload FROM audit_results WHERE contract_id = $1 ORDER BY created_at DESC LIMIT 1',
    [contractId],
  );
  check('PostgresAuditStore persisted the run', stored.rowCount === 1);

  const p = stored.rows[0].payload;
  check(
    'severity counts survive the round trip',
    p.criticalVulns === 1 && p.highVulns === 0,
    `critical=${p.criticalVulns} high=${p.highVulns}`,
  );

  const fromStored = await scoreVia(contractId, {
    maintainability: p.maintainability,
    cyclomatic_complexity: p.cyclomaticComplexity,
    passed_tests: p.passedTests,
    total_tests: p.totalTests,
    total_vulnerabilities: p.vulnerabilities,
    critical_vulnerabilities: p.criticalVulns,
    high_vulnerabilities: p.highVulns,
  });
  check(
    'a contract with perfect tests and one critical still scores 200',
    fromStored.status === 200,
    `HTTP ${fromStored.status}`,
  );
  check(
    'the critical count reaches the oracle payload',
    fromStored.body.critical_vulnerabilities === 1,
    `critical_vulnerabilities=${fromStored.body.critical_vulnerabilities}`,
  );

  // The end-to-end point: high score, one critical, therefore no release.
  await oracle.recordScore(
    contractId,
    fromStored.body.trust_score,
    fromStored.body.critical_vulnerabilities,
  );
  verdict = await oracle.evaluate(contractId);
  check(
    'high-scoring code with a critical finding does not release escrow',
    !verdict.approved,
    `score ${fromStored.body.trust_score}, blockers: ${verdict.blockers.join('; ')}`,
  );
} catch (err) {
  console.error('\nUnhandled error during verification:', err);
  failures.push(`unhandled: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  // ── Cleanup ───────────────────────────────────────────────────────────
  try {
    await pool.query('DELETE FROM scope_checks WHERE contract_id = $1', [contractId]);
    await pool.query('DELETE FROM oracle_state WHERE contract_id = $1', [contractId]);
    await pool.query('DELETE FROM audit_results WHERE contract_id = $1', [contractId]);
    await pool.query('DELETE FROM contracts WHERE contract_id = $1', [contractId]);
  } catch (cleanupErr) {
    console.error('Cleanup failed:', cleanupErr);
  }
  await pool.end().catch(() => {});
  await auditStore.close?.().catch(() => {});
}

console.log(`\n${'='.repeat(78)}`);
if (failures.length === 0) {
  console.log(`  ALL ${checks} CHECKS PASSED`);
  console.log('  Trust score varies with real telemetry; settlement rejects below 85.');
  process.exit(0);
} else {
  console.log(`  ${failures.length} of ${checks} CHECKS FAILED`);
  for (const f of failures) console.log(`    - ${f}`);
  process.exit(1);
}
