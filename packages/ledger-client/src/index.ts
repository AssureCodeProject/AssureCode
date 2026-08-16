import pg, { type Pool, type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import type { LedgerEntry } from '@assurecode/shared';
import { buildDbConfig } from '@assurecode/config';
import { trace } from '@opentelemetry/api';
import { metrics } from '@assurecode/telemetry';
import { canonicalize } from './canonical.js';
import {
  buildInclusionProof,
  computeRoot,
  hashLeaf,
  type InclusionProof,
} from './merkle.js';

const tracer = trace.getTracer('assurecode-ledger-client');

/** The chain hash formula this client can reproduce. See V009. */
export const CURRENT_HASH_VERSION = 2;

export interface LedgerRow {
  ledgerId: number;
  contractId: string;
  actionType: string;
  payload: Record<string, unknown>;
  /** The exact bytes that were hashed. Null only for pre-V009 rows. */
  payloadCanonical: string | null;
  previousHash: string;
  currentHash: string;
  hashVersion: number;
  createdAt: string;
}

/** Map the JSONB row returned by append_ledger into a typed LedgerEntry. */
function normalizeRow(row: Record<string, unknown>): LedgerRow {
  return {
    ledgerId: Number(row.ledger_id),
    contractId: String(row.contract_id),
    actionType: String(row.action_type),
    payload: row.payload as Record<string, unknown>,
    payloadCanonical: row.payload_canonical == null ? null : String(row.payload_canonical),
    previousHash: String(row.previous_hash),
    currentHash: String(row.current_hash),
    hashVersion: Number(row.hash_version ?? 1),
    createdAt: String(row.created_at),
  };
}

/**
 * The chain hash, recomputed from the canonical bytes.
 *
 * This must agree with V009's append_ledger byte for byte. The previous version
 * of this function hashed `JSON.stringify(payload) + previousHash`, which
 * agreed with nothing — see canonical.ts for what the database was actually
 * hashing and why the two could never meet.
 */
export function chainHash(payloadCanonical: string, previousHash: string): string {
  return createHash('sha256')
    .update(`${payloadCanonical}\n${previousHash}`, 'utf8')
    .digest('hex');
}

/** Why a chain failed verification, or that it did not. */
export interface ChainVerification {
  valid: boolean;
  /** Rows checked with the reproducible formula. */
  verified: number;
  /**
   * Pre-V009 rows, which cannot be recomputed by anyone. Reported separately
   * rather than counted as passes: they were written under a formula whose two
   * implementations disagreed, so no verifier can certify them.
   */
  unverifiable: number;
  failures: string[];
}

export class LedgerClient {
  private pool: Pool;

  constructor(databaseUrl: string, poolSize = 5) {
    // buildDbConfig, not a bare connectionString: this client carries contract
    // hashes and payloads, and it was the one component still connecting
    // without the pinned CA the rest of the system uses.
    this.pool = new pg.Pool({ ...buildDbConfig(databaseUrl), max: poolSize });
  }

  /** Append a new entry to the Merkle chain and return the new row. */
  async append(
    contractId: string,
    actionType: string,
    payload: Record<string, unknown>,
    client?: PoolClient,
  ): Promise<LedgerRow> {
    const span = tracer.startSpan('ledger.append', {
      attributes: {
        'ledger.contract_id': contractId,
        'ledger.action_type': actionType,
      },
    });

    const run = async (c: PoolClient) => {
      // Canonical bytes, not JSON.stringify. The database hashes exactly what is
      // sent, so this string is the message being anchored.
      const result = await c.query('SELECT append_ledger($1, $2, $3) AS row', [
        contractId,
        actionType,
        canonicalize(payload),
      ]);
      return normalizeRow(result.rows[0].row as Record<string, unknown>);
    };

    try {
      let row: LedgerRow;
      if (client) {
        row = await run(client);
      } else {
        const c = await this.pool.connect();
        try {
          row = await run(c);
        } finally {
          c.release();
        }
      }
      span.setAttribute('ledger.hash', row.currentHash);
      // contract_id stays on the span, not on the counter — see metrics.ts.
      metrics.ledgerAppendsTotal.inc({ action_type: actionType });
      return row;
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  }

  /** Append within a caller-managed transaction. */
  async appendWith<T>(
    contractId: string,
    actionType: string,
    payload: Record<string, unknown>,
    fn: (client: PoolClient, row: LedgerRow) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.append(contractId, actionType, payload, client);
      const out = await fn(client, row);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Append to Merkle chain AND stage event in outbox table atomically. */
  async appendWithOutbox(
    contractId: string,
    actionType: string,
    ledgerPayload: Record<string, unknown>,
    eventTopic: string,
    eventPayload: Record<string, unknown>,
    correlationId?: string,
  ): Promise<LedgerRow> {
    const span = tracer.startSpan('ledger.appendWithOutbox', {
      attributes: {
        'ledger.contract_id': contractId,
        'ledger.action_type': actionType,
        'event.topic': eventTopic,
      },
    });

    const client = await this.pool.connect();
    try {
      try {
        const result = await client.query(
          'SELECT append_ledger_and_outbox($1, $2, $3, $4, $5::jsonb, $6) AS row',
          [
            contractId,
            actionType,
            canonicalize(ledgerPayload),
            eventTopic,
            JSON.stringify(eventPayload),
            correlationId || null,
          ],
        );
        const row = normalizeRow(result.rows[0].row as Record<string, unknown>);
        span.setAttribute('ledger.hash', row.currentHash);
        metrics.ledgerAppendsTotal.inc({ action_type: actionType });
        return row;
      } catch (procErr) {
        // BUG-019: Record and log the stored procedure error before falling back
        // so it is not silently swallowed — constraint violations must not be hidden.
        span.recordException(procErr as Error);
        console.warn('[ledger-client] appendWithOutbox stored procedure failed, using manual fallback:', procErr);
        // Fallback: execute transaction with append_ledger + insert outbox
        await client.query('BEGIN');
        try {
          const ledgerRow = await this.append(contractId, actionType, ledgerPayload, client);
          await client.query(
            'INSERT INTO outbox (topic, payload, correlation_id) VALUES ($1, $2::jsonb, $3)',
            [eventTopic, JSON.stringify(eventPayload), correlationId || null],
          );
          await client.query('COMMIT');
          return ledgerRow;
        } catch (txErr) {
          await client.query('ROLLBACK');
          span.recordException(txErr as Error);
          throw txErr;
        }
      }
    } finally {
      span.end();
      client.release();
    }
  }

  /** Get the full chain for a contract (ordered). */
  async getChain(contractId: string): Promise<LedgerRow[]> {
    const result = await this.pool.query(
      'SELECT * FROM merkle_ledger WHERE contract_id = $1 ORDER BY ledger_id ASC',
      [contractId],
    );
    return result.rows.map((r) => normalizeRow(r));
  }

  /**
   * Verify a contract's chain, entirely in this process.
   *
   * The previous implementation asked PostgreSQL to recompute each hash with
   * the *same expression* that wrote it and compared the two. That comparison
   * can only fail if the database is inconsistent with itself, so it passed on
   * any chain — including one whose payloads had been edited, since the
   * recomputation read the edited payload. It also had a JavaScript fallback
   * that was unreachable (the `try` had no `catch`, so a query error propagated
   * instead of falling through) and, had it run, would have failed on every
   * honest chain because its formula matched nothing.
   *
   * Verification now happens here, from the row's own bytes, so the database is
   * not asked to vouch for itself.
   */
  async verifyChainDetailed(contractId: string): Promise<ChainVerification> {
    const rows = await this.getChain(contractId);
    const failures: string[] = [];
    let verified = 0;
    let unverifiable = 0;

    let previous = 'GENESIS';

    for (const row of rows) {
      if (row.previousHash !== previous) {
        failures.push(
          `ledger_id ${row.ledgerId}: previous_hash ${row.previousHash.slice(0, 16)}… does not ` +
            `link to the preceding entry (${previous.slice(0, 16)}…)`,
        );
      }

      if (row.hashVersion < CURRENT_HASH_VERSION || row.payloadCanonical === null) {
        // Not a pass and not a failure: nothing can recompute these. Counting
        // them as verified would be the same lie the old code told.
        unverifiable++;
      } else {
        const expected = chainHash(row.payloadCanonical, row.previousHash);
        if (expected !== row.currentHash) {
          failures.push(
            `ledger_id ${row.ledgerId}: current_hash does not match SHA256(canonical || LF || prev)`,
          );
        } else if (canonicalize(row.payload) !== row.payloadCanonical) {
          // The database's CHECK constraint already forces payload_canonical to
          // parse to the same jsonb as payload. This catches the remaining gap:
          // canonical bytes that are jsonb-equal but not canonically equal — a
          // reordered or re-spaced string that would satisfy the constraint
          // while changing what was hashed.
          failures.push(
            `ledger_id ${row.ledgerId}: stored canonical bytes are not the canonical form of the payload`,
          );
        } else {
          verified++;
        }
      }

      previous = row.currentHash;
    }

    return { valid: failures.length === 0, verified, unverifiable, failures };
  }

  /** Boolean form, for callers that only need the verdict. */
  async verifyChain(contractId: string): Promise<boolean> {
    return (await this.verifyChainDetailed(contractId)).valid;
  }

  // ── Merkle tree ────────────────────────────────────────────────────────

  /**
   * Leaf hashes for a contract, in ledger order.
   *
   * The leaf commits to the whole row, not just the payload: an entry's meaning
   * depends on which contract it belongs to, what kind of action it was, and
   * where it sits in the chain. Committing to the payload alone would let a row
   * be replayed under a different action type with its proof still valid.
   */
  private leafBytes(row: LedgerRow): Buffer {
    const material = canonicalize({
      ledgerId: row.ledgerId,
      contractId: row.contractId,
      actionType: row.actionType,
      payload: row.payload,
      previousHash: row.previousHash,
      currentHash: row.currentHash,
    });
    return hashLeaf(material);
  }

  /** Recompute the Merkle root over a contract's chain and persist it. */
  async computeAndStoreRoot(
    contractId: string,
  ): Promise<{ root: string; leafCount: number; maxLedgerId: number | null }> {
    const rows = await this.getChain(contractId);
    const leaves = rows.map((r) => this.leafBytes(r));
    const root = computeRoot(leaves).toString('hex');
    const maxLedgerId = rows.length === 0 ? null : rows[rows.length - 1].ledgerId;

    await this.pool.query(
      `INSERT INTO merkle_roots (contract_id, root_hash, leaf_count, max_ledger_id, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (contract_id) DO UPDATE
         SET root_hash = EXCLUDED.root_hash,
             leaf_count = EXCLUDED.leaf_count,
             max_ledger_id = EXCLUDED.max_ledger_id,
             -- A new root invalidates the old signature. Clearing it here means
             -- a stale signature can never be presented as covering the current
             -- tree; re-signing is an explicit act.
             signature = NULL,
             public_key = NULL,
             signed_at = NULL,
             signature_alg = NULL,
             updated_at = now()`,
      [contractId, root, leaves.length, maxLedgerId],
    );

    return { root, leafCount: leaves.length, maxLedgerId };
  }

  /** The stored root for a contract, with its signature if one exists. */
  async getRoot(contractId: string): Promise<{
    rootHash: string;
    leafCount: number;
    maxLedgerId: number | null;
    signature: Buffer | null;
    publicKey: Buffer | null;
    signatureAlg: string | null;
    signedAt: string | null;
  } | null> {
    const res = await this.pool.query(
      `SELECT root_hash, leaf_count, max_ledger_id, signature, public_key, signature_alg, signed_at
         FROM merkle_roots WHERE contract_id = $1`,
      [contractId],
    );
    if (res.rowCount === 0) return null;
    const r = res.rows[0];
    return {
      rootHash: r.root_hash,
      leafCount: Number(r.leaf_count),
      maxLedgerId: r.max_ledger_id == null ? null : Number(r.max_ledger_id),
      signature: r.signature ?? null,
      publicKey: r.public_key ?? null,
      signatureAlg: r.signature_alg ?? null,
      signedAt: r.signed_at ? new Date(r.signed_at).toISOString() : null,
    };
  }

  /**
   * An inclusion proof for one ledger entry.
   *
   * This is the operation the tree exists for: a third party can be handed one
   * entry, ~log2(n) sibling hashes, and the signed root, and can check
   * membership without seeing any other entry in the contract.
   */
  async getInclusionProof(contractId: string, ledgerId: number): Promise<InclusionProof> {
    const rows = await this.getChain(contractId);
    const index = rows.findIndex((r) => r.ledgerId === ledgerId);
    if (index === -1) {
      throw new Error(`ledger_id ${ledgerId} does not belong to contract ${contractId}`);
    }
    return buildInclusionProof(
      rows.map((r) => this.leafBytes(r)),
      index,
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export { canonicalize, NotCanonicalizableError } from './canonical.js';
export {
  buildInclusionProof,
  computeRoot,
  hashLeaf,
  hashNode,
  verifyInclusionProof,
  EMPTY_ROOT,
  type InclusionProof,
  type ProofStep,
} from './merkle.js';

export {
  LEGACY_ANCHOR_ACTION,
  NoLegacyRowsError,
  buildLegacyAnchorPayload,
  canonicalAnchorBytes,
  isLegacyRow,
  reportLegacySegment,
  selectLegacyRows,
  verifyLegacyAnchor,
  type AnchorCheck,
  type LegacyAnchorPayload,
  type LegacySegmentReport,
} from './legacy-anchor.js';

export { pg };
export type { Pool, PoolClient };
export type { LedgerEntry };
