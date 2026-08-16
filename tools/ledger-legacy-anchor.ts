/**
 * Report on — and optionally seal — the pre-V009 ledger rows.
 *
 *   npx tsx tools/ledger-legacy-anchor.ts                 # report every contract
 *   npx tsx tools/ledger-legacy-anchor.ts --contract AC-1 # one contract
 *   npx tsx tools/ledger-legacy-anchor.ts --seal          # append anchor entries
 *   npx tsx tools/ledger-legacy-anchor.ts --check         # re-verify existing anchors
 *
 * Read `packages/ledger-client/src/legacy-anchor.ts` before using --seal.
 *
 * Short version: 17 rows were written before the V009 canonicalization
 * migration, hashed with a PostgreSQL expression nothing outside PostgreSQL can
 * reproduce. They CANNOT be made retroactively verifiable. Recomputing their
 * hashes under the current formula would make them all "verify" and would
 * destroy the property the ledger exists for, because recomputation is exactly
 * what rewriting history looks like.
 *
 * `--seal` therefore does not touch them. It appends a new, ordinary,
 * fully-verifiable entry that commits to their hashes, so that from that moment
 * on any alteration is detectable. It converts "17 rows are unverifiable" into
 * "17 rows are not independently verifiable but have been immutable since
 * <date>", which is a weaker claim than full verification and a much stronger
 * one than nothing.
 *
 * Default is report-only. Sealing writes to the ledger and is not reversible —
 * the entry becomes part of the chain — so it requires the explicit flag.
 */
import {
  LedgerClient,
  buildLegacyAnchorPayload,
  reportLegacySegment,
  verifyLegacyAnchor,
  NoLegacyRowsError,
  LEGACY_ANCHOR_ACTION,
  type LedgerRow,
  type LegacyAnchorPayload,
} from '@assurecode/ledger-client';
import { getDatabaseUrl } from '@assurecode/config';
import pg from 'pg';

const args = new Set(process.argv.slice(2));
const contractArgIndex = process.argv.indexOf('--contract');
const onlyContract = contractArgIndex === -1 ? null : process.argv[contractArgIndex + 1];
const doSeal = args.has('--seal');
const doCheck = args.has('--check');

async function listContracts(pool: pg.Pool): Promise<string[]> {
  if (onlyContract) return [onlyContract];
  const res = await pool.query<{ contract_id: string }>(
    'SELECT DISTINCT contract_id FROM merkle_ledger ORDER BY contract_id',
  );
  return res.rows.map((r) => r.contract_id);
}

/** The anchor entry already written for a contract, if any. */
function findExistingAnchor(rows: LedgerRow[]): LedgerRow | undefined {
  return rows.find((r) => r.actionType === LEGACY_ANCHOR_ACTION);
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: getDatabaseUrl() });
  const ledger = new LedgerClient(pool);

  try {
    const contracts = await listContracts(pool);
    if (contracts.length === 0) {
      console.log('No contracts found in merkle_ledger.');
      return;
    }

    let totalLegacy = 0;
    let totalSealed = 0;
    let anyDiscrepancy = false;

    for (const contractId of contracts) {
      const rows = await ledger.getChain(contractId);
      const report = reportLegacySegment(contractId, rows);
      const existing = findExistingAnchor(rows);

      totalLegacy += report.legacyRows;

      if (report.legacyRows === 0 && !existing) continue;

      console.log(`\n── ${contractId} ──`);
      console.log(`  rows          : ${report.totalRows} (${report.verifiableRows} verifiable, ${report.legacyRows} legacy)`);
      if (report.legacyDateRange) {
        console.log(`  legacy window : ${report.legacyDateRange.first} … ${report.legacyDateRange.last}`);
        console.log(`  legacy ids    : ${report.legacyLedgerIds.join(', ')}`);
        // A contiguous prefix means one clean boundary to describe in a paper:
        // "everything from row N is independently checkable".
        console.log(`  clean boundary: ${report.legacyIsPrefix ? 'yes — legacy rows are a contiguous prefix' : 'NO — legacy rows are interleaved with modern ones'}`);
      }

      if (existing) {
        const payload = existing.payload as unknown as LegacyAnchorPayload;
        const check = verifyLegacyAnchor(payload, rows);
        totalSealed += check.sealedCount;
        console.log(`  anchor        : ledger_id ${existing.ledgerId}, sealed ${check.sealedCount} rows, ${check.intact ? 'INTACT' : 'DISCREPANCIES'}`);
        for (const d of check.discrepancies) {
          anyDiscrepancy = true;
          console.log(`    ! ${d}`);
        }
        continue;
      }

      if (!doSeal) {
        console.log('  anchor        : none (run with --seal to write one)');
        continue;
      }

      try {
        const payload = buildLegacyAnchorPayload(contractId, rows);
        const written = await ledger.append(
          contractId,
          LEGACY_ANCHOR_ACTION,
          payload as unknown as Record<string, unknown>,
        );
        totalSealed += payload.sealedLedgerIds.length;
        console.log(`  anchor        : WRITTEN as ledger_id ${written.ledgerId}`);
        console.log(`  sealed root   : ${payload.sealedMerkleRoot}`);
      } catch (err) {
        if (err instanceof NoLegacyRowsError) continue;
        throw err;
      }
    }

    console.log('\n── summary ──');
    console.log(`  contracts inspected : ${contracts.length}`);
    console.log(`  legacy rows found   : ${totalLegacy}`);
    console.log(`  legacy rows sealed  : ${totalSealed}`);

    if (totalLegacy > 0 && totalSealed < totalLegacy && !doSeal) {
      console.log('\n  These rows are NOT independently verifiable and cannot be made so.');
      console.log('  Run with --seal to make them immutable from this point forward.');
    }

    if (anyDiscrepancy) {
      // A sealed hash that no longer matches is the one outcome that must not
      // exit zero: it means a legacy row changed after being sealed.
      console.error('\n  FAILED: one or more sealed rows no longer match the anchor.');
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (doCheck && doSeal) {
  console.error('--check and --seal are mutually exclusive.');
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
