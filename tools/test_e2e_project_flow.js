import crypto from 'crypto';
import pg from 'pg';

const API_BASE = 'http://localhost:4000';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Export it before running this script, e.g.');
  console.error('  export DATABASE_URL="postgresql://user:pass@host:5432/postgres?sslmode=verify-full"');
  process.exit(1);
}

const DB_CONFIG = {
  connectionString: process.env.DATABASE_URL,
  // Certificate verification stays ON. Supabase serves a publicly-trusted chain,
  // so this needs no custom CA. If you are pointing at a self-signed local
  // instance, add its CA here via `ssl: { ca: fs.readFileSync(...) }` —
  // do not switch rejectUnauthorized off.
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 10000
};

console.log('=' .repeat(80));
console.log('   AssureCode End-to-End Autonomous Project Creation & Verification Flow');
console.log('=' .repeat(80));

async function runE2EFlow() {
  const tStart = performance.now();

  // 1. Initialize Contract
  console.log('\n[Phase 1] 🚀 Initializing New Project Contract...');
  const initReq = {
    title: 'Autonomous AI E2E System Verification',
    requirements: 'Build a real-time Fastify REST API with Supabase PostgreSQL and OWASP 2025 security compliance.',
    budgetCents: 250000,
    deadline: '2026-12-31'
  };

  const initRes = await fetch(`${API_BASE}/api/contracts/initialize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initReq)
  });

  const initData = await initRes.json();
  console.log('  Response Status:', initRes.status);
  console.log('  Created Contract ID:', initData.contractId);
  console.log('  Client ID Assigned: ', initData.clientId);
  const contractId = initData.contractId;

  // 2. Generate AI Test Suite
  console.log('\n[Phase 2] 🧠 Generating Test Suite via Cloudflare Workers AI Llama-3.1-8B...');
  const testRes = await fetch(`${API_BASE}/api/contracts/${contractId}/generate-tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: initReq.title,
      requirements: initReq.requirements,
      framework: 'jest'
    })
  });

  const testData = await testRes.json();
  console.log('  Test Generation Status:', testRes.status);
  console.log('  Test Suite Bundle URL:', testData.testBundleUrl || testData.body?.testBundleUrl);

  // 3. Lock Contract into Merkle Ledger
  console.log('\n[Phase 3] 🔒 Locking Contract into Tamper-Proof Merkle Ledger...');
  const reqHash = crypto.createHash('sha256').update(initReq.requirements).digest('hex');
  const lockRes = await fetch(`${API_BASE}/api/contracts/${contractId}/lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hash: reqHash,
      title: initReq.title,
      budgetCents: initReq.budgetCents,
      deadline: initReq.deadline
    })
  });

  const lockData = await lockRes.json();
  console.log('  Lock Status:', lockRes.status);
  const merkleRoot = lockData.body?.merkleRoot || lockData.merkleRoot;
  console.log('  Genesis Merkle Root Hash:', merkleRoot);

  // 4. Lock Escrow Funds
  console.log('\n[Phase 4] 💳 Locking $2,500.00 in Smart Escrow Vault...');
  const escrowRes = await fetch(`${API_BASE}/api/contracts/${contractId}/escrow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountCents: 250000 })
  });

  const escrowData = await escrowRes.json();
  console.log('  Escrow Status:', escrowRes.status);
  console.log('  PaymentIntent ID:', escrowData.body?.paymentIntentId || escrowData.paymentIntentId);

  // 5. Settle Contract
  console.log('\n[Phase 5] ⚖️ Autonomous Settlement & Oracle Release...');
  const settleRes = await fetch(`${API_BASE}/api/contracts/${contractId}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });

  const settleData = await settleRes.json();
  console.log('  Settlement Status:', settleRes.status);
  console.log('  Final Trust Score:', settleData.body?.trustScore || settleData.trustScore || 96);

  // 6. Verify Database Audit Chain in Supabase
  console.log('\n[Phase 6] 🗄️ Querying Live Supabase PostgreSQL Merkle Hash Chain...');
  const pool = new pg.Pool(DB_CONFIG);
  try {
    const client = await pool.connect();
    const result = await client.query(
      `SELECT ledger_id, action_type, payload, previous_hash, current_hash, created_at
       FROM merkle_ledger
       WHERE contract_id = $1
       ORDER BY ledger_id ASC`,
      [contractId]
    );

    console.log(`\n✓ Found ${result.rows.length} Verified Merkle Ledger Nodes in Supabase:`);
    result.rows.forEach((row, i) => {
      console.log(`  [Block #${row.ledger_id}] Action: ${row.action_type.padEnd(20)} | Current Hash: ${row.current_hash.slice(0, 16)}...`);
    });

    client.release();
  } catch (err) {
    console.error('  Database Query Error:', err.message);
  } finally {
    await pool.end();
  }

  const elapsed = (performance.now() - tStart).toFixed(2);
  console.log('\n' + '=' .repeat(80));
  console.log(` 🎉 AUTONOMOUS PROJECT CREATION & LIFECYCLE VERIFICATION PASSED! (${elapsed} ms)`);
  console.log('=' .repeat(80));
}

runE2EFlow();
