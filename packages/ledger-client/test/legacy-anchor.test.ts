/**
 * Tests for sealing the pre-V009 ledger segment.
 *
 * The property under test is narrow and worth stating plainly: the anchor does
 * NOT make legacy rows verifiable. It makes them *immutable from now on*. The
 * tests are written to fail if anyone later widens that claim.
 */
import { describe, it, expect } from 'vitest';
import {
  LEGACY_ANCHOR_ACTION,
  NoLegacyRowsError,
  buildLegacyAnchorPayload,
  canonicalAnchorBytes,
  isLegacyRow,
  reportLegacySegment,
  selectLegacyRows,
  verifyLegacyAnchor,
} from '../src/legacy-anchor.js';
import type { LedgerRow } from '../src/index.js';

function row(overrides: Partial<LedgerRow> & { ledgerId: number }): LedgerRow {
  return {
    contractId: 'AC-1',
    actionType: 'CONTRACT_LOCKED',
    payload: { a: 1 },
    payloadCanonical: '{"a":1}',
    previousHash: 'GENESIS',
    currentHash: String(overrides.ledgerId).padStart(64, '0'),
    hashVersion: 2,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as LedgerRow;
}

const legacy = (id: number, extra: Partial<LedgerRow> = {}) =>
  row({ ledgerId: id, hashVersion: 1, payloadCanonical: null, ...extra });

describe('isLegacyRow / selectLegacyRows', () => {
  it('treats an old hash version as legacy', () => {
    expect(isLegacyRow(row({ ledgerId: 1, hashVersion: 1 }))).toBe(true);
  });

  it('treats a null canonical payload as legacy even at the current version', () => {
    // Both conditions matter: a row can carry version 2 and still have no
    // canonical bytes, and it is equally un-recomputable.
    expect(isLegacyRow(row({ ledgerId: 1, payloadCanonical: null }))).toBe(true);
  });

  it('does not treat a modern row as legacy', () => {
    expect(isLegacyRow(row({ ledgerId: 1 }))).toBe(false);
  });

  it('returns legacy rows in ledger order regardless of input order', () => {
    const selected = selectLegacyRows([legacy(3), row({ ledgerId: 4 }), legacy(1), legacy(2)]);
    expect(selected.map((r) => r.ledgerId)).toEqual([1, 2, 3]);
  });
});

describe('buildLegacyAnchorPayload', () => {
  const rows = [legacy(1), legacy(2), legacy(3), row({ ledgerId: 4 })];

  it('seals exactly the legacy rows, not the modern ones', () => {
    const payload = buildLegacyAnchorPayload('AC-1', rows);
    expect(payload.sealedLedgerIds).toEqual([1, 2, 3]);
    expect(payload.sealedHashes).toHaveLength(3);
  });

  it('records the action kind and contract', () => {
    const payload = buildLegacyAnchorPayload('AC-1', rows);
    expect(payload.kind).toBe(LEGACY_ANCHOR_ACTION);
    expect(payload.contractId).toBe('AC-1');
    expect(payload.sealedHashVersion).toBe(1);
  });

  it('computes a Merkle root over the sealed hashes', () => {
    const payload = buildLegacyAnchorPayload('AC-1', rows);
    expect(payload.sealedMerkleRoot).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    // The anchor is appended to a hash chain; a payload that varied between
    // constructions could not be re-derived by a third party.
    const a = canonicalAnchorBytes(buildLegacyAnchorPayload('AC-1', rows));
    const b = canonicalAnchorBytes(buildLegacyAnchorPayload('AC-1', [...rows].reverse()));
    expect(a).toBe(b);
  });

  it('states in the payload what it does not assert', () => {
    // The disclaimer travels with the data, because the payload is what a third
    // party reads — not this test file and not the module docstring.
    const payload = buildLegacyAnchorPayload('AC-1', rows);
    expect(payload.assertion).toMatch(/does NOT assert that they are correct/);
    expect(payload.assertion).toMatch(/have not been altered since/);
  });

  it('refuses to seal an empty set', () => {
    // An anchor asserting nothing is worse than no anchor: it looks like the
    // segment was checked.
    expect(() => buildLegacyAnchorPayload('AC-2', [row({ ledgerId: 1 })])).toThrow(NoLegacyRowsError);
  });
});

describe('verifyLegacyAnchor', () => {
  const rows = [legacy(1), legacy(2), legacy(3)];
  const payload = buildLegacyAnchorPayload('AC-1', rows);

  it('reports an untouched segment as intact', () => {
    const check = verifyLegacyAnchor(payload, rows);
    expect(check.intact).toBe(true);
    expect(check.discrepancies).toEqual([]);
    expect(check.sealedCount).toBe(3);
  });

  it('detects a legacy row whose hash changed after sealing', () => {
    // This is the whole point: before the anchor, altering one of these rows was
    // undetectable, because nothing could recompute it.
    const tampered = [legacy(1), legacy(2, { currentHash: 'f'.repeat(64) }), legacy(3)];
    const check = verifyLegacyAnchor(payload, tampered);

    expect(check.intact).toBe(false);
    expect(check.discrepancies[0]).toMatch(/ledger_id 2/);
  });

  it('detects a sealed row that has been deleted', () => {
    const check = verifyLegacyAnchor(payload, [legacy(1), legacy(3)]);
    expect(check.intact).toBe(false);
    expect(check.discrepancies[0]).toMatch(/no longer exists/);
  });

  it('detects an edited anchor payload', () => {
    // An attacker who changes a row and edits the anchor's hash list to match
    // must also fix the root; this catches them without consulting the chain.
    const doctored = { ...payload, sealedHashes: [...payload.sealedHashes] };
    doctored.sealedHashes[1] = 'f'.repeat(64);

    const check = verifyLegacyAnchor(doctored, [
      legacy(1),
      legacy(2, { currentHash: 'f'.repeat(64) }),
      legacy(3),
    ]);

    expect(check.intact).toBe(false);
    expect(check.discrepancies.some((d) => /payload has been edited/.test(d))).toBe(true);
  });

  it('is unaffected by modern rows appended after the anchor', () => {
    const check = verifyLegacyAnchor(payload, [...rows, row({ ledgerId: 9 })]);
    expect(check.intact).toBe(true);
  });
});

describe('reportLegacySegment', () => {
  it('counts legacy and verifiable rows separately', () => {
    const report = reportLegacySegment('AC-1', [legacy(1), legacy(2), row({ ledgerId: 3 })]);
    expect(report.totalRows).toBe(3);
    expect(report.legacyRows).toBe(2);
    expect(report.verifiableRows).toBe(1);
  });

  it('reports the legacy date range', () => {
    const report = reportLegacySegment('AC-1', [
      legacy(1, { createdAt: '2026-08-01T00:00:00.000Z' }),
      legacy(2, { createdAt: '2026-08-04T00:00:00.000Z' }),
    ]);
    expect(report.legacyDateRange).toEqual({
      first: '2026-08-01T00:00:00.000Z',
      last: '2026-08-04T00:00:00.000Z',
    });
  });

  it('reports a clean boundary when legacy rows are a contiguous prefix', () => {
    // A single boundary is a statable result: "everything from row N is
    // independently checkable".
    const report = reportLegacySegment('AC-1', [legacy(1), legacy(2), row({ ledgerId: 3 })]);
    expect(report.legacyIsPrefix).toBe(true);
  });

  it('reports no clean boundary when legacy rows are interleaved', () => {
    const report = reportLegacySegment('AC-1', [legacy(1), row({ ledgerId: 2 }), legacy(3)]);
    expect(report.legacyIsPrefix).toBe(false);
  });

  it('handles a chain with no legacy rows at all', () => {
    const report = reportLegacySegment('AC-1', [row({ ledgerId: 1 })]);
    expect(report.legacyRows).toBe(0);
    expect(report.legacyDateRange).toBeNull();
    expect(report.legacyIsPrefix).toBe(true);
  });
});
