/**
 * Phase 8 live verification — Objective 1 end to end.
 *
 * The plan's gate for this phase:
 *
 *     "append via SQL, verify via JS, mutate a payload row, confirm BOTH
 *      verifyChain() and ML-DSA root verification fail"
 *
 * All three legs run here against live PostgreSQL. The ML-DSA leg shells out to
 * tools/sign_merkle_root.py, because the signing key is Python-side and this
 * script must not be given a second implementation of the signature check — a
 * verifier written inside its own test is the defect this phase exists to
 * remove.
 *
 * Prerequisites:
 *   npm run build
 *   ML_DSA_SEED_HEX set in .env
 *
 * Run:
 *   node tools/verify_phase8_live.mjs
 *
 * Everything is namespaced under a run-specific contract id and deleted in a
 * finally block, so it is safe against a shared database.
 */
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDbConfig } from '@assurecode/config';
import {
  LedgerClient,
  canonicalize,
  chainHash,
  computeRoot,
  hashLeaf,
  verifyInclusionProof,
} from '@assurecode/ledger-client';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── .env ────────────────────────────────────────────────────────────────
{
  const envPath = resolve(REPO_ROOT, '.env');
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
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Configure .env before running this script.');
  process.exit(1);
}

const PYTHON = resolve(REPO_ROOT, 'apps', 'ai-service', '.venv', 'Scripts', 'python.exe');
const SIGN_TOOL = resolve(REPO_ROOT, 'tools', 'sign_merkle_root.py');

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

function runSigner(args) {
  const res = spawnSync(PYTHON, [SIGN_TOOL, ...args], { encoding: 'utf8', cwd: REPO_ROOT });
  return {
    code: res.status,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

// ── Main ────────────────────────────────────────────────────────────────
const contractId = `VERIFY-P8-${randomUUID().slice(0, 8).toUpperCase()}`;
const pool = new pg.Pool(buildDbConfig(DATABASE_URL));
const ledger = new LedgerClient(DATABASE_URL);

console.log('='.repeat(78));
console.log('  Phase 8 live verification — canonical hash chain, Merkle tree, ML-DSA-87');
console.log('='.repeat(78));
console.log(`  contract: ${contractId}`);
console.log(`  database: ${DATABASE_URL.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);

try {
  // ── 0. Preflight ──────────────────────────────────────────────────────
  section('0. Preflight');

  const ver = await pool.query('SHOW server_version');
  check('PostgreSQL reachable', true, `server_version ${ver.rows[0].server_version}`);

  if (!existsSync(PYTHON)) {
    console.error(`\n  Python venv not found at ${PYTHON}.`);
    process.exit(1);
  }
  const pk = runSigner(['--show-public-key']);
  if (pk.code !== 0) {
    console.error(`\n  Signer unavailable: ${pk.stderr || pk.stdout}`);
    process.exit(1);
  }
  check(
    'ML-DSA signing key configured',
    pk.stdout.length === 2592 * 2,
    `public key ${pk.stdout.length / 2} bytes (ML-DSA-87 is 2592)`,
  );

  await pool.query(
    `INSERT INTO contracts (contract_id, client_id, freelancer_id, title, requirements, budget_cents, deadline, status)
     VALUES ($1, 'verify-client', 'verify-freelancer', 'Phase 8 verification', 'Verification fixture.', 250000, '2026-12-31', 'IN_PROGRESS')`,
    [contractId],
  );
  check('fixture contract created', true);

  // ── 1. The SQL and JS hashes now agree ────────────────────────────────
  section('1. The hash written by PostgreSQL is reproducible in JavaScript');

  // Deliberately unsorted keys and a nested object, so key ordering matters.
  const rowA = await ledger.append(contractId, 'GENESIS', {
    zeta: 'last',
    alpha: 1,
    nested: { omega: true, beta: [3, 1, 2] },
  });
  const rowB = await ledger.append(contractId, 'CONTRACT_LOCKED', {
    amountCents: 250000,
    currency: 'USD',
  });
  const rowC = await ledger.append(contractId, 'AUDIT_COMPLETED', {
    passedTests: 20,
    totalTests: 20,
  });

  check(
    'append_ledger stored the canonical bytes',
    rowA.payloadCanonical === '{"alpha":1,"nested":{"beta":[3,1,2],"omega":true},"zeta":"last"}',
    rowA.payloadCanonical ?? 'null',
  );
  check('rows are written at hash_version 2', rowA.hashVersion === 2 && rowC.hashVersion === 2);
  check(
    'the JS recomputation matches the hash PostgreSQL wrote',
    chainHash(rowA.payloadCanonical, rowA.previousHash) === rowA.currentHash,
    rowA.currentHash.slice(0, 24) + '…',
  );
  check(
    'the chain links: each row names its predecessor',
    rowB.previousHash === rowA.currentHash && rowC.previousHash === rowB.currentHash,
  );

  // The old formula, for contrast.
  const oldFormula = createHash('sha256')
    .update(JSON.stringify(rowA.payload) + rowA.previousHash)
    .digest('hex');
  check(
    'the pre-V009 formula still disagrees, as it always did',
    oldFormula !== rowA.currentHash,
    'confirms the two were never capable of matching',
  );

  const v1 = await ledger.verifyChainDetailed(contractId);
  check('verifyChain passes on an untampered chain', v1.valid, JSON.stringify(v1));
  check('all three rows were actually verified, not skipped', v1.verified === 3 && v1.unverifiable === 0);

  // ── 2. A real Merkle tree ─────────────────────────────────────────────
  section('2. The Merkle tree is a tree, with working inclusion proofs');

  const root1 = await ledger.computeAndStoreRoot(contractId);
  check('root computed and stored', root1.leafCount === 3, `${root1.leafCount} leaves`);

  const proof = await ledger.getInclusionProof(contractId, rowB.ledgerId);
  check(
    'an inclusion proof verifies against the root',
    verifyInclusionProof(proof.leafHash, proof.path, proof.root),
    `${proof.path.length} sibling hashes for ${root1.leafCount} leaves`,
  );
  check('the proof is against the stored root', proof.root === root1.root);

  // The property that makes it a tree rather than a chain.
  const bigProof = await (async () => {
    const leaves = Array.from({ length: 1024 }, (_, i) => hashLeaf(`x${i}`));
    const { buildInclusionProof } = await import('@assurecode/ledger-client');
    return buildInclusionProof(leaves, 777);
  })();
  check(
    'proof size is logarithmic, not linear',
    bigProof.path.length === 10,
    `1024 leaves -> ${bigProof.path.length} hashes (a chain would need 1024)`,
  );

  const forgedLeaf = hashLeaf(canonicalize({ never: 'in the tree' }));
  check(
    'a leaf that is not in the tree cannot be proved',
    !verifyInclusionProof(forgedLeaf, proof.path, proof.root),
  );

  // ── 3. ML-DSA-87 over the root ────────────────────────────────────────
  section('3. FIPS 204 ML-DSA-87 signs the root');

  const signed = runSigner([contractId]);
  check('signing succeeded', signed.code === 0, signed.stderr || signed.stdout.split('\n')[0]);

  const storedSig = await pool.query(
    'SELECT signature, public_key, signature_alg FROM merkle_roots WHERE contract_id = $1',
    [contractId],
  );
  const sigRow = storedSig.rows[0] ?? {};
  check(
    'the signature has the ML-DSA-87 size',
    sigRow.signature?.length === 4627,
    `${sigRow.signature?.length ?? 0} bytes (a SHA3-512 digest, which the old code produced, is 64)`,
  );
  check('the algorithm is recorded as ML-DSA-87', sigRow.signature_alg === 'ML-DSA-87', String(sigRow.signature_alg));

  const verified = runSigner(['--verify', contractId]);
  check('the signature verifies', verified.code === 0 && verified.stdout.includes('VALID'), verified.stdout.split('\n')[0]);

  // ── 4. Tampering is detected by BOTH mechanisms ───────────────────────
  section('4. Mutating a payload breaks the chain AND the signature');

  // Rewrite the payload in place, keeping the canonical column consistent so
  // the CHECK constraint is satisfied — i.e. the most careful tamper available
  // to someone with write access.
  const tamperedCanonical = canonicalize({ amountCents: 9_999_999, currency: 'USD' });
  // Two distinct parameters, deliberately. Binding one parameter as both
  // `$1::jsonb` and a text column makes PostgreSQL infer its type as jsonb,
  // and the text column then receives the *jsonb rendering* — key-length
  // ordered, with spaces — rather than the bytes sent. append_ledger is immune
  // because its parameter is declared TEXT, but an ad-hoc UPDATE is not.
  await pool.query(
    `UPDATE merkle_ledger SET payload = $1::jsonb, payload_canonical = $2::text WHERE ledger_id = $3`,
    [tamperedCanonical, tamperedCanonical, rowB.ledgerId],
  );

  const v2 = await ledger.verifyChainDetailed(contractId);
  check('verifyChain now FAILS', !v2.valid, v2.failures[0] ?? 'no failure reported');
  check(
    'it names the row that was altered',
    v2.failures.some((f) => f.includes(`ledger_id ${rowB.ledgerId}`)),
    v2.failures.join('; '),
  );

  const root2 = await ledger.computeAndStoreRoot(contractId);
  check('the Merkle root changed', root2.root !== root1.root, `${root1.root.slice(0, 16)}… -> ${root2.root.slice(0, 16)}…`);

  // computeAndStoreRoot clears the signature, so re-verifying must not silently
  // pass on a stale one.
  const afterTamper = runSigner(['--verify', contractId]);
  check(
    'the ML-DSA signature no longer covers the tree',
    afterTamper.code !== 0,
    afterTamper.stderr.split('\n')[0] || afterTamper.stdout.split('\n')[0],
  );

  // Put the old signature back over the new root — the attack of re-presenting
  // a signature for a tree that has since changed.
  await pool.query(
    `UPDATE merkle_roots SET signature = $1, public_key = $2, signature_alg = 'ML-DSA-87', signed_at = now() WHERE contract_id = $3`,
    [sigRow.signature, sigRow.public_key, contractId],
  );
  const replayed = runSigner(['--verify', contractId]);
  check(
    'a replayed signature over the old root is rejected',
    replayed.code !== 0,
    'the signed root is not the current root',
  );

  // ── 5. The canonical-form check closes the jsonb-equality gap ─────────
  section('5. A jsonb-equal but non-canonical rewrite is still caught');

  // Restore rowB so the chain is otherwise sound, then attack only the
  // canonical column with a string that parses to the same jsonb but is not the
  // canonical form. The database CHECK constraint accepts it.
  const originalCanonical = canonicalize({ amountCents: 250000, currency: 'USD' });
  await pool.query(
    `UPDATE merkle_ledger SET payload = $1::jsonb, payload_canonical = $2::text WHERE ledger_id = $3`,
    [originalCanonical, originalCanonical, rowB.ledgerId],
  );
  const restored = await ledger.verifyChainDetailed(contractId);
  check('chain is sound again after restoring the payload', restored.valid, JSON.stringify(restored.failures));

  // Same keys, same values, different byte string: reordered and re-spaced.
  // This is what PostgreSQL's own jsonb rendering looks like, so it is not a
  // contrived attack — it is what an accidental cast produces.
  const nonCanonical = '{"currency": "USD", "amountCents": 250000}';
  const constraintHeld = await pool
    .query(`UPDATE merkle_ledger SET payload_canonical = $1::text WHERE ledger_id = $2`, [
      nonCanonical,
      rowB.ledgerId,
    ])
    .then(() => true)
    .catch(() => false);
  check(
    'the database accepts it, because it is jsonb-equal',
    constraintHeld,
    'the CHECK constraint alone cannot catch this',
  );

  const v3 = await ledger.verifyChainDetailed(contractId);
  check(
    'verifyChain catches the non-canonical rewrite anyway',
    !v3.valid,
    v3.failures[0] ?? 'no failure reported',
  );

  // ── 6. Legacy rows are reported, not certified ────────────────────────
  section('6. Pre-V009 rows are reported as unverifiable, never as passing');

  const legacy = await pool.query(
    `SELECT count(*) AS n FROM merkle_ledger WHERE hash_version = 1`,
  );
  check(
    'legacy rows still exist and are marked version 1',
    Number(legacy.rows[0].n) > 0,
    `${legacy.rows[0].n} rows written before V009`,
  );

  const legacyContract = await pool.query(
    `SELECT contract_id FROM merkle_ledger WHERE hash_version = 1 LIMIT 1`,
  );
  if (legacyContract.rowCount === 1) {
    const lv = await ledger.verifyChainDetailed(legacyContract.rows[0].contract_id);
    check(
      'they are counted as unverifiable rather than verified',
      lv.unverifiable > 0 && lv.verified === 0,
      `verified=${lv.verified} unverifiable=${lv.unverifiable}`,
    );
  }
} catch (err) {
  console.error('\nUnhandled error during verification:', err);
  failures.push(`unhandled: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  try {
    await pool.query('DELETE FROM merkle_roots WHERE contract_id = $1', [contractId]);
    await pool.query('DELETE FROM merkle_ledger WHERE contract_id = $1', [contractId]);
    await pool.query('DELETE FROM contracts WHERE contract_id = $1', [contractId]);
  } catch (cleanupErr) {
    console.error('Cleanup failed:', cleanupErr);
  }
  await pool.end().catch(() => {});
  await ledger.close().catch(() => {});
}

console.log(`\n${'='.repeat(78)}`);
if (failures.length === 0) {
  console.log(`  ALL ${checks} CHECKS PASSED`);
  console.log('  SQL and JS agree on the hash; the tree proves inclusion; tampering breaks both');
  console.log('  the chain and the ML-DSA-87 signature.');
  process.exit(0);
} else {
  console.log(`  ${failures.length} of ${checks} CHECKS FAILED`);
  for (const f of failures) console.log(`    - ${f}`);
  process.exit(1);
}
