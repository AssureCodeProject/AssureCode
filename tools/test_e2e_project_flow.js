/**
 * End-to-end demo flow: login -> initialize -> match -> assign -> lock ->
 * escrow -> push -> audit -> score -> settle, as an authenticated user.
 *
 * What this replaced
 * -------------------
 * The previous version called every endpoint, printed whatever came back, and
 * then unconditionally printed "PASSED" at the end regardless of any response
 * status — a 500 from every single step still produced a green checkmark.
 * `/simulate-push` also carried no code, so even a fully running ci-worker
 * pipeline could never audit anything through this path (processCodePush
 * throws "No code supplied" without one — see apps/ci-worker/src/worker.ts).
 * Both are fixed here: every step checks its response, and the acceptance
 * check at the end is the plan's own query — real rows in all six evidence
 * tables, scoped to the contract this run created, not a global snapshot.
 *
 * What this cannot do without cross-process infra
 * -------------------------------------------------
 * audit_results only appears once ci-worker actually consumes the
 * CODE_PUSH_RECEIVED event this script publishes via /simulate-push, which
 * requires a real event bus between processes (Redis or Kafka —
 * EVENT_BUS_TYPE) and ci-worker running. Without that, this script will
 * correctly report the audit step as never landing rather than pretending it
 * did — the same "fail loud, don't fabricate" rule the rest of this codebase
 * follows. See DEMO.md for what's running where.
 */
import pg from 'pg';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildDbConfig, loadConfig } from '@assurecode/config';
import { FAKE_KEY_SECRET, isLiveRazorpayConfig } from '@assurecode/razorpay-adapter';

/**
 * Whether the gateway this script talks to is using real Razorpay credentials.
 *
 * loadConfig() rather than bare process.env, because it reads .env — which is
 * where the credentials actually live when this script is run by hand, and the
 * only place the gateway itself got them from.
 *
 * It asks the same factory the gateway asks rather than re-deriving the rules:
 * two implementations of "is this key real" would eventually disagree, and the
 * disagreement would surface as a confusing 401 halfway through a demo.
 */
const LIVE_RAZORPAY = (() => {
  const cfg = loadConfig();
  return isLiveRazorpayConfig({
    keyId: cfg.RAZORPAY_KEY_ID ?? '',
    keySecret: cfg.RAZORPAY_KEY_SECRET ?? '',
    webhookSecret: cfg.RAZORPAY_WEBHOOK_SECRET ?? '',
  });
})();

const API_BASE = process.env.API_BASE || 'http://localhost:4000';
const AUDIT_POLL_TIMEOUT_MS = 15_000;
const AUDIT_POLL_INTERVAL_MS = 1_000;

if (!process.env.DATABASE_URL && fs.existsSync('.env')) {
  const envContent = fs.readFileSync('.env', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/);
    if (match) {
      process.env.DATABASE_URL = match[1].replace(/^["']|["']$/g, '').trim();
      break;
    }
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Export it before running this script.');
  process.exit(1);
}

// Same TLS policy as every other service (A1's fix): the pinned Supabase CA
// bundle, verification on. This script used to build its own `{ ssl:
// rejectUnauthorized: true }` with no CA, which fails against Supabase's
// self-signed root — the exact defect buildDbConfig() exists to prevent.
const DB_CONFIG = buildDbConfig(process.env.DATABASE_URL);

const DEMO_CODE = `function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n`;

/** POST/GET with a hard failure on non-2xx — no step is allowed to "pass" silently. */
async function call(method, path, headers, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body is reported via the raw text below */
  }
  return { status: res.status, ok: res.ok, json, text };
}

function fail(step, res) {
  console.error(`\n✗ FAILED at ${step}: HTTP ${res.status}`);
  console.error(`  ${res.text.slice(0, 500)}`);
  console.error('\n' + '='.repeat(80));
  console.error(' E2E FLOW FAILED — see the step above. Nothing after it ran.');
  console.error('='.repeat(80));
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runE2EFlow() {
  const tStart = performance.now();
  console.log('='.repeat(80));
  console.log('   AssureCode End-to-End Flow — real assertions, not a printed banner');
  console.log('='.repeat(80));

  // 0. Login
  console.log('\n[Phase 0] Logging in as client-acme...');
  const login = await call('POST', '/auth/login', { 'Content-Type': 'application/json' }, {
    email: 'client@acme.com',
    password: 'demo1234',
  });
  if (!login.ok) fail('login', login);
  const token = login.json.token;
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const clientUserId = login.json.user?.userId ?? login.json.userId;
  console.log(`  ✓ Authenticated as client@acme.com (${clientUserId})`);

  // 0.5 KYC
  //
  // The escrow routes sit behind `clientVerified`, which reads users.kyc_status
  // from the database and fails closed. Seeded users start UNVERIFIED, so this
  // script used to die at Phase 4 with a 403 KYC_REQUIRED — it had no step that
  // cleared the gate, because escrow was previously reached only by callers
  // authenticating with SERVICE_TOKEN, which bypasses the guard entirely.
  //
  // This is the real flow a client goes through, and it is backed by
  // FakeKycAdapter: verification is terminal on the first call, so there is no
  // pending state to poll.
  console.log('\n[Phase 0.5] Clearing the KYC gate...');
  const kyc = await call('POST', '/api/kyc/verify', auth, {
    userId: clientUserId,
    idType: 'PASSPORT',
  });
  if (!kyc.ok) fail('kyc/verify', kyc);
  console.log(`  ✓ KYC ${kyc.json.kycStatus}, session ${kyc.json.sessionId}`);

  // 1. Initialize
  console.log('\n[Phase 1] Initializing contract...');
  const initReq = {
    title: 'E2E Verification Run',
    requirements: 'Build a real-time Fastify REST API with PostgreSQL and OWASP 2025 security compliance.',
    budgetCents: 250000,
    deadline: '2026-12-31',
  };
  const init = await call('POST', '/api/contracts/initialize', auth, initReq);
  if (!init.ok) fail('initialize', init);
  const contractId = init.json.contractId;
  console.log(`  ✓ Contract ${contractId}, client_id=${init.json.clientId}`);

  // 1.5 Match + assign
  console.log('\n[Phase 1.5] Matching and assigning a freelancer...');
  const match = await call('POST', `/api/contracts/${contractId}/match`, auth, {
    requirements: initReq.requirements,
    topK: 5,
  });
  if (!match.ok) fail('match', match);
  const top = match.json.results?.[0];
  if (!top) fail('match (no candidates returned)', match);
  console.log(`  ✓ Top candidate: ${top.freelancer_name || top.freelancer_id} (score ${top.score})`);

  const assign = await call('POST', `/api/contracts/${contractId}/assign`, auth, {
    freelancerId: top.freelancer_id,
  });
  if (!assign.ok) fail('assign', assign);
  console.log(`  ✓ Assigned to ${top.freelancer_id}`);

  // 2. Generate tests
  console.log('\n[Phase 2] Generating hidden test suite...');
  const gen = await call('POST', `/api/contracts/${contractId}/generate-tests`, auth, {
    title: initReq.title,
    requirements: initReq.requirements,
    framework: 'jest',
  });
  if (!gen.ok) fail('generate-tests', gen);
  console.log(`  ✓ ${gen.json.testBundleUrl ? 'Test bundle generated' : 'Stub response (ai-service unavailable)'}`);

  // 3. Lock
  console.log('\n[Phase 3] Locking contract to the Merkle hash chain...');
  const lock = await call('POST', `/api/contracts/${contractId}/lock`, auth, {
    title: initReq.title,
    requirements: initReq.requirements,
    budgetCents: initReq.budgetCents,
    deadline: initReq.deadline,
  });
  if (!lock.ok) fail('lock', lock);
  console.log(`  ✓ Locked, hash ${lock.json.hash?.slice(0, 16)}...`);

  // 4. Escrow — two steps under Razorpay, not one.
  //
  // Creating the order does not fund anything: the order is payable, and until
  // someone pays it the escrow row sits at PENDING with no payment id. The
  // settlement oracle selects on AUTHORIZED, so a run that stopped here would
  // reach Phase 8 and correctly refuse to settle an escrow nobody funded.
  console.log('\n[Phase 4] Creating escrow order...');
  const escrow = await call('POST', `/api/contracts/${contractId}/escrow`, auth, {
    amountMinor: initReq.budgetCents,
    currency: 'INR',
  });
  if (!escrow.ok) fail('escrow', escrow);
  console.log(`  ✓ Order ${escrow.json.orderId}, status ${escrow.json.status}`);

  // Stand in for the customer completing Razorpay Checkout.
  //
  // In a browser this signature comes back from Checkout; here we construct it
  // the same way Razorpay does — HMAC-SHA256 over `orderId|paymentId` — using
  // FakeRazorpayAdapter's key secret. That exercises the real /escrow/verify
  // path including its signature check, rather than reaching into the database
  // to flip a status.
  //
  // It only works against the fake adapter, and cannot be made to work against
  // real credentials: the signature would need the live key secret, and even
  // with it, /escrow/verify re-reads the payment from Razorpay's API — where a
  // synthetic `pay_fake_*` id does not exist. Simulating a payment against a
  // real payment processor is not a thing. So detect it and stop cleanly rather
  // than failing at a 401 that looks like a signature bug.
  if (LIVE_RAZORPAY) {
    console.log('\n[Phase 4b] SKIPPED — live Razorpay credentials are configured.');
    console.log('  A payment cannot be simulated against the real API. Fund this contract in the');
    console.log(`  web UI (Escrow tab, contract ${contractId}) with test card 4111 1111 1111 1111,`);
    console.log('  then re-run with RAZORPAY_KEY_ID=rzp_test_mock to exercise the automated path.');
    console.log('  Settlement below will correctly refuse: the escrow is not AUTHORIZED yet.');
  } else {
    console.log('\n[Phase 4b] Simulating Checkout payment (fake adapter)...');
    const fakePaymentId = `pay_fake_e2e_${Date.now()}`;
    const checkoutSignature = crypto
      .createHmac('sha256', FAKE_KEY_SECRET)
      .update(`${escrow.json.orderId}|${fakePaymentId}`)
      .digest('hex');

    const funded = await call('POST', `/api/contracts/${contractId}/escrow/verify`, auth, {
      razorpayOrderId: escrow.json.orderId,
      razorpayPaymentId: fakePaymentId,
      razorpaySignature: checkoutSignature,
    });
    if (!funded.ok) fail('escrow/verify', funded);
    console.log(`  ✓ Payment ${funded.json.paymentId} AUTHORIZED — funds held, not captured`);
  }

  // 5. Push + poll for audit
  console.log('\n[Phase 5] Simulating a code push and waiting for the audit pipeline...');
  const push = await call('POST', `/api/contracts/${contractId}/simulate-push`, auth, { code: DEMO_CODE });
  if (!push.ok) fail('simulate-push', push);
  console.log(`  Push event ${push.json.eventId} published — polling for audit_results...`);

  let auditLanded = false;
  const pollStart = Date.now();
  while (Date.now() - pollStart < AUDIT_POLL_TIMEOUT_MS) {
    const results = await call('GET', `/api/audits/${contractId}/results`, auth);
    if (results.ok) {
      auditLanded = true;
      console.log(`  ✓ Audit landed: maintainability=${results.json.maintainability}, tests=${results.json.passedTests}/${results.json.totalTests}, vulns=${results.json.vulnerabilities}`);
      break;
    }
    await sleep(AUDIT_POLL_INTERVAL_MS);
  }
  if (!auditLanded) {
    console.warn(
      `  ⚠ No audit_results after ${AUDIT_POLL_TIMEOUT_MS / 1000}s. This requires ci-worker running with a real\n` +
      '    cross-process event bus (EVENT_BUS_TYPE=redis or kafka) — an in-memory bus only works within\n' +
      '    a single process. Continuing so the rest of the flow reports its own real status.',
    );
  }

  // 6. Score (only meaningful once audit landed — a 409 here is a correct
  // refusal, not a bug, if the audit step above did not complete)
  console.log('\n[Phase 6] Requesting XAI trust score...');
  const score = await call('GET', `/api/contracts/${contractId}/score`, auth);
  if (score.ok) {
    console.log(`  ✓ Trust score ${score.json.trustScore} (threshold ${score.json.threshold})`);
    if (score.json.narrative) console.log(`  Narrative: ${score.json.narrative}`);
  } else {
    console.warn(`  ⚠ Score unavailable (HTTP ${score.status}): ${score.json?.error || score.text.slice(0, 200)}`);
  }

  // 7. Settle — a rejection here (oracle declines) is a correct, informative
  // outcome, not a script failure; only a transport/HTTP failure is fatal.
  console.log('\n[Phase 7] Requesting settlement...');
  const settle = await call('POST', `/api/contracts/${contractId}/settle`, auth, {
    freelancerId: top.freelancer_id,
    amountCents: initReq.budgetCents,
  });
  if (!settle.ok) fail('settle', settle);
  console.log(`  Settlement request accepted (HTTP ${settle.status}): ${settle.json.status || JSON.stringify(settle.json)}`);
  if (settle.json.status === 'pending_oracle_verification') {
    console.log('  Waiting a few seconds for the settlement worker to evaluate...');
    await sleep(4000);
  }

  // 8. The plan's actual acceptance criterion: real rows in every evidence
  // table, scoped to this contract — not a global snapshot that could already
  // be non-zero from unrelated prior runs.
  console.log('\n[Phase 8] Checking evidence tables for this contract...');
  const pool = new pg.Pool(DB_CONFIG);
  const evidence = {};
  try {
    const contractRow = await pool.query(
      `SELECT freelancer_id, status FROM contracts WHERE contract_id = $1`,
      [contractId],
    );
    evidence.assigned = contractRow.rows[0]?.freelancer_id != null;
    evidence.completed = contractRow.rows[0]?.status === 'COMPLETED';

    const counts = await pool.query(
      `SELECT
         (SELECT count(*) FROM merkle_ledger WHERE contract_id = $1) AS ledger,
         (SELECT count(*) FROM audit_results  WHERE contract_id = $1) AS audits,
         (SELECT count(*) FROM escrow         WHERE contract_id = $1) AS escrows,
         (SELECT count(*) FROM settlements    WHERE contract_id = $1) AS settlements,
         (SELECT count(*) FROM merkle_roots   WHERE contract_id = $1) AS roots`,
      [contractId],
    );
    Object.assign(evidence, counts.rows[0]);
  } finally {
    await pool.end();
  }

  const rows = [
    ['contracts.freelancer_id assigned', evidence.assigned === true],
    ['contracts.status = COMPLETED', evidence.completed === true],
    ['merkle_ledger rows', Number(evidence.ledger) > 0],
    ['audit_results rows', Number(evidence.audits) > 0],
    ['escrow rows', Number(evidence.escrows) > 0],
    ['settlements rows', Number(evidence.settlements) > 0],
    ['merkle_roots rows', Number(evidence.roots) > 0],
  ];

  console.log(`\n  Contract: ${contractId}`);
  for (const [label, pass] of rows) {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
  }

  const allPassed = rows.every(([, pass]) => pass);
  const elapsed = (performance.now() - tStart).toFixed(0);

  console.log('\n' + '='.repeat(80));
  if (allPassed) {
    console.log(` ✓ ALL SIX EVIDENCE TABLES POPULATED FOR ${contractId} (${elapsed} ms)`);
  } else {
    console.log(` ✗ INCOMPLETE — some evidence tables have no row for ${contractId} (${elapsed} ms)`);
    console.log('   This is expected without ci-worker + a real cross-process event bus running');
    console.log('   (see the Phase 5 warning above). It is not the same as the script failing.');
  }
  console.log('='.repeat(80));

  process.exit(allPassed ? 0 : 1);
}

runE2EFlow().catch((err) => {
  console.error('\nUnhandled error in E2E flow:', err);
  process.exit(1);
});
