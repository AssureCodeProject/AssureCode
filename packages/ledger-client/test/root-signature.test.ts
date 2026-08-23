/**
 * The guarded write that attaches an ML-DSA signature to a stored Merkle root.
 *
 * Signing is a three-step sequence: read the root, ask the signer to sign that
 * exact triple, write the signature back. If the tree grew between step one and
 * step three, the signature covers a root the ledger no longer holds, and
 * writing it anyway would present a stale signature as the current one. The
 * guard on (root_hash, leaf_count) is what makes that impossible, and it had no
 * test before — nor did the invariant it complements, that computeAndStoreRoot
 * clears any existing signature when the tree moves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { LedgerClient } from '../src/index.js';
import { loadDotEnv } from '../../../tools/test-support/env.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';
import { getDatabaseUrl, loadConfig } from '@assurecode/config';

loadDotEnv();

const available = await postgresAvailable();
if (!available) announceSkip('merkle root signature storage', 'PostgreSQL (DATABASE_URL)');

describe.skipIf(!available)('storeRootSignature', () => {
  const contractId = `AC-ROOTSIG-TEST-${Date.now()}`;
  let ledger: LedgerClient;
  let pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

  // Real ML-DSA-87 sizes, so the round trip through bytea is exercised at the
  // width the production path actually writes.
  const signature = randomBytes(4627);
  const publicKey = randomBytes(2592);

  beforeAll(async () => {
    ledger = new LedgerClient(getDatabaseUrl(loadConfig()));
    pool = (ledger as any).pool;

    // client_id 'legacy-client' rather than an invented id: V012 added an FK
    // from contracts.client_id to users.user_id, and this is the seeded row the
    // other integration suites use.
    await pool.query(
      `INSERT INTO contracts (contract_id, client_id, title, requirements, budget_cents, deadline, status)
       VALUES ($1, 'legacy-client', 'Root signature test', 'requirements', 100000, '2026-12-31', 'LOCKED')
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId],
    );
    await ledger.append(contractId, 'CONTRACT_INITIALIZED', { seq: 1 });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM merkle_roots WHERE contract_id = $1', [contractId]);
    await pool.query('DELETE FROM merkle_ledger WHERE contract_id = $1', [contractId]);
    await pool.query('DELETE FROM contracts WHERE contract_id = $1', [contractId]);
    await (ledger as any).pool.end?.();
  });

  it('writes the signature when the root still matches', async () => {
    const { root, leafCount } = await ledger.computeAndStoreRoot(contractId);

    const stored = await ledger.storeRootSignature({
      contractId,
      rootHash: root,
      leafCount,
      signature,
      publicKey,
      algorithm: 'ML-DSA-87',
    });

    expect(stored).toBe(true);

    const after = await ledger.getRoot(contractId);
    expect(after?.signature?.equals(signature)).toBe(true);
    expect(after?.publicKey?.equals(publicKey)).toBe(true);
    expect(after?.signatureAlg).toBe('ML-DSA-87');
    expect(after?.signedAt).not.toBeNull();
  });

  it('refuses a signature whose root no longer matches, and writes nothing', async () => {
    const before = await ledger.getRoot(contractId);

    const stored = await ledger.storeRootSignature({
      contractId,
      rootHash: 'f'.repeat(64), // a root this contract never had
      leafCount: before!.leafCount,
      signature: randomBytes(4627),
      publicKey,
      algorithm: 'ML-DSA-87',
    });

    // False, not a throw: "the tree moved on" is an expected consequence of a
    // concurrent append, and the caller's answer is to recompute and re-sign.
    expect(stored).toBe(false);

    const after = await ledger.getRoot(contractId);
    expect(after?.signature?.equals(signature)).toBe(true); // still the original
  });

  it('refuses when the leaf count moved even though the hash was passed correctly', async () => {
    const before = await ledger.getRoot(contractId);

    const stored = await ledger.storeRootSignature({
      contractId,
      rootHash: before!.rootHash,
      leafCount: before!.leafCount + 1,
      signature: randomBytes(4627),
      publicKey,
      algorithm: 'ML-DSA-87',
    });

    expect(stored).toBe(false);
  });

  it('clears the signature when the tree grows, so a stale one can never be served', async () => {
    // The invariant computeAndStoreRoot documents but nothing tested: a new
    // root invalidates the old signature, and re-signing is an explicit act.
    await ledger.append(contractId, 'TESTS_GENERATED', { seq: 2 });
    const { leafCount } = await ledger.computeAndStoreRoot(contractId);

    expect(leafCount).toBe(2);

    const after = await ledger.getRoot(contractId);
    expect(after?.signature).toBeNull();
    expect(after?.publicKey).toBeNull();
    expect(after?.signatureAlg).toBeNull();
    expect(after?.signedAt).toBeNull();
  });
});
