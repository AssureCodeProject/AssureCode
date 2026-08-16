/**
 * Sealing the pre-V009 ledger rows.
 *
 * The problem
 * -----------
 * 17 rows were written before V009 and hashed with the old SQL expression
 * `sha256((to_jsonb(payload) || to_jsonb(previous_hash))::text)`. Because
 * `jsonb || jsonb` promotes an object and a scalar into a two-element array,
 * the bytes that were hashed were `[{"a": 1}, "GENESIS"]` — PostgreSQL's own
 * jsonb text rendering, with its own key ordering and spacing. Nothing outside
 * PostgreSQL reproduces those bytes, so `verifyChainDetailed` counts these rows
 * as `unverifiable` rather than certifying a pass it cannot justify.
 *
 * Why there is no backfill
 * -----------------------
 * The obvious "fix" is to recompute `current_hash` under the V2 formula and set
 * `hash_version = 2`. That would make every row verify — and would destroy the
 * only property the ledger exists to provide. A tamper-evident log whose hashes
 * are recomputed on demand records nothing: the recomputation is exactly what
 * an attacker rewriting history would do, and afterwards the two are
 * indistinguishable. **These rows cannot be made retroactively verifiable, and
 * that is a permanent property of the data, not a defect awaiting a migration.**
 *
 * What can be done instead
 * ------------------------
 * Seal them going forward. This module builds a normal V2 ledger entry whose
 * payload commits to the ordered list of legacy `current_hash` values. That
 * anchor entry *is* reproducible and verifiable by anyone, so from the moment
 * it is appended:
 *
 *   * the legacy hashes are fixed — altering one now contradicts the anchor;
 *   * the anchor itself is chained and Merkle-committed like any other entry,
 *     so it inherits the signed root; and
 *   * the claim the paper can make is precise: "rows before the anchor are not
 *     independently verifiable, but have been immutable since <anchor date>",
 *     rather than the weaker "17 rows are unverifiable".
 *
 * This is the standard notarisation answer to un-verifiable historical records.
 * It does not manufacture evidence about the past; it starts the evidence now
 * and says so.
 */
import { canonicalize } from './canonical.js';
import { hashLeaf, computeRoot } from './merkle.js';
import { CURRENT_HASH_VERSION, type LedgerRow } from './index.js';

/** Action type of the sealing entry. */
export const LEGACY_ANCHOR_ACTION = 'LEGACY_SEGMENT_ANCHORED';

export interface LegacyAnchorPayload {
  /** Schema marker, so a future reader can tell what this entry means. */
  kind: typeof LEGACY_ANCHOR_ACTION;
  contractId: string;
  /** Hash formula version the sealed rows were written under. */
  sealedHashVersion: number;
  /** Ledger ids of the sealed rows, ascending. */
  sealedLedgerIds: number[];
  /** Their `current_hash` values, in the same order. */
  sealedHashes: string[];
  /** RFC 6962 root over the sealed hashes — one value to quote in a paper. */
  sealedMerkleRoot: string;
  /**
   * What this entry does and does not assert. Carried in the payload rather
   * than only in this file, because the payload is what a third party reads.
   */
  assertion: string;
}

/** A row that cannot be recomputed by anyone outside the original database. */
export function isLegacyRow(row: LedgerRow): boolean {
  return row.hashVersion < CURRENT_HASH_VERSION || row.payloadCanonical === null;
}

/** The legacy rows of a chain, in ledger order. */
export function selectLegacyRows(rows: LedgerRow[]): LedgerRow[] {
  return rows.filter(isLegacyRow).sort((a, b) => a.ledgerId - b.ledgerId);
}

export class NoLegacyRowsError extends Error {
  constructor(contractId: string) {
    super(`contract ${contractId} has no pre-V009 rows; there is nothing to seal`);
    this.name = 'NoLegacyRowsError';
  }
}

/**
 * Build the payload that seals a contract's legacy segment.
 *
 * Throws when there is nothing to seal, rather than writing an anchor over an
 * empty set — an anchor asserting nothing is worse than no anchor, because it
 * looks like the segment was checked.
 */
export function buildLegacyAnchorPayload(
  contractId: string,
  rows: LedgerRow[],
): LegacyAnchorPayload {
  const legacy = selectLegacyRows(rows);
  if (legacy.length === 0) throw new NoLegacyRowsError(contractId);

  const sealedHashes = legacy.map((r) => r.currentHash);
  const root = computeRoot(sealedHashes.map((h) => hashLeaf(h))).toString('hex');

  return {
    kind: LEGACY_ANCHOR_ACTION,
    contractId,
    // All legacy rows are version 1 by construction; recorded explicitly so the
    // entry still reads correctly if a version 3 is ever introduced.
    sealedHashVersion: Math.max(...legacy.map((r) => r.hashVersion)),
    sealedLedgerIds: legacy.map((r) => r.ledgerId),
    sealedHashes,
    sealedMerkleRoot: root,
    assertion:
      'These rows predate the V009 canonicalization migration and were hashed with a ' +
      'PostgreSQL-specific expression that cannot be reproduced independently. This entry ' +
      'does NOT assert that they are correct or that their contents are what they claim. ' +
      'It asserts only that their current_hash values were exactly these at the time this ' +
      'entry was appended, and — because this entry is itself chained and Merkle-committed ' +
      'under the current formula — that they have not been altered since.',
  };
}

export interface AnchorCheck {
  /** True when every sealed hash still matches the live rows. */
  intact: boolean;
  /** Human-readable discrepancies. Empty when intact. */
  discrepancies: string[];
  /** Rows the anchor covers. */
  sealedCount: number;
}

/**
 * Re-check a previously written anchor against the current rows.
 *
 * This is the part that gives the anchor its value: after it exists, altering a
 * legacy row is detectable, because the alteration contradicts an entry that is
 * itself verifiable.
 */
export function verifyLegacyAnchor(
  payload: LegacyAnchorPayload,
  rows: LedgerRow[],
): AnchorCheck {
  const discrepancies: string[] = [];
  const byId = new Map(rows.map((r) => [r.ledgerId, r]));

  for (const [index, ledgerId] of payload.sealedLedgerIds.entries()) {
    const row = byId.get(ledgerId);
    if (!row) {
      // A missing row is a stronger signal than a changed one: rows are never
      // deleted in normal operation.
      discrepancies.push(`ledger_id ${ledgerId} is sealed by the anchor but no longer exists`);
      continue;
    }
    const expected = payload.sealedHashes[index];
    if (row.currentHash !== expected) {
      discrepancies.push(
        `ledger_id ${ledgerId}: current_hash ${row.currentHash.slice(0, 16)}… does not match the ` +
          `sealed value ${expected.slice(0, 16)}…`,
      );
    }
  }

  // Recompute the root too, so a doctored anchor payload — one whose hash list
  // was edited to match doctored rows — fails as well. Editing the payload
  // changes the entry's own canonical bytes and therefore its chain hash, but
  // checking the root here means this function alone catches it.
  const recomputed = computeRoot(payload.sealedHashes.map((h) => hashLeaf(h))).toString('hex');
  if (recomputed !== payload.sealedMerkleRoot) {
    discrepancies.push(
      `the anchor's own sealedMerkleRoot does not match its sealedHashes; the payload has been edited`,
    );
  }

  return {
    intact: discrepancies.length === 0,
    discrepancies,
    sealedCount: payload.sealedLedgerIds.length,
  };
}

/** Canonical bytes of an anchor payload, for appending via LedgerClient. */
export function canonicalAnchorBytes(payload: LegacyAnchorPayload): string {
  return canonicalize(payload as unknown as Record<string, unknown>);
}

export interface LegacySegmentReport {
  contractId: string;
  totalRows: number;
  legacyRows: number;
  verifiableRows: number;
  legacyLedgerIds: number[];
  /** ISO timestamps of the first and last legacy row, or null when there are none. */
  legacyDateRange: { first: string; last: string } | null;
  /** True when the legacy rows form an unbroken prefix of the chain. */
  legacyIsPrefix: boolean;
}

/**
 * Characterise a chain's legacy segment.
 *
 * `legacyIsPrefix` is the interesting field. If the un-verifiable rows are a
 * contiguous prefix, the chain has one clean boundary: everything from row N is
 * independently checkable, which is a statable result. Legacy rows interleaved
 * with modern ones would mean the migration ran mid-chain and the caveat is
 * messier to describe.
 */
export function reportLegacySegment(contractId: string, rows: LedgerRow[]): LegacySegmentReport {
  const ordered = [...rows].sort((a, b) => a.ledgerId - b.ledgerId);
  const legacy = ordered.filter(isLegacyRow);
  const firstModernIndex = ordered.findIndex((r) => !isLegacyRow(r));

  const legacyIsPrefix =
    legacy.length === 0 ||
    (firstModernIndex === -1
      ? true
      : ordered.slice(0, firstModernIndex).every(isLegacyRow) &&
        ordered.slice(firstModernIndex).every((r) => !isLegacyRow(r)));

  return {
    contractId,
    totalRows: ordered.length,
    legacyRows: legacy.length,
    verifiableRows: ordered.length - legacy.length,
    legacyLedgerIds: legacy.map((r) => r.ledgerId),
    legacyDateRange: legacy.length
      ? { first: legacy[0].createdAt, last: legacy[legacy.length - 1].createdAt }
      : null,
    legacyIsPrefix,
  };
}
