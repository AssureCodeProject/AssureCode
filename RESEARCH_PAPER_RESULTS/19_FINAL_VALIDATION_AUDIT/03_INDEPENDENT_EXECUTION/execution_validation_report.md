# Independent Execution Validation

All commands below were re-run live during this audit from the repo root
(`C:\Users\sowmi\PROJECTS\AssureCode`) on 2026-11-05, no Docker infra running unless noted.

## 1. Lint — `npm run lint`

| Metric | Original claim | Independently rerun | Match |
|---|---|---|---|
| Errors | 0 | 0 | YES |
| Warnings | 138 | 138 | YES |
| Exit code | 0 (implied) | 0 | YES |

Exact match, down to the warning count. Command: `npm run lint`. Final line of output:
`✖ 138 problems (0 errors, 138 warnings)`.

## 2. Build — `npm run build`

| Metric | Original claim | Independently rerun | Match |
|---|---|---|---|
| Workspaces built | 13 + web | 13 (root build output; web build not re-invoked separately in this pass) | YES for the 13 |
| Exit code | 0 | 0 | YES |

Output: `Built 13 workspaces.` All packages/apps reported `... ok`. No TypeScript compiler
errors surfaced during build.

## 3. Unit tests — `npm test` (full workspace run, no Docker infra up)

This audit's rerun surfaced **2 failures that were NOT part of the original campaign's stated
unit-test results**:

| Test | Result | Root cause (independently diagnosed) |
|---|---|---|
| `apps/api-gateway` → `test/idempotency-unit.test.ts` → "stays bounded well past the 10 000-entry cap" | FAILED (timeout at 5000ms) when run as part of the full concurrent `npm test --workspaces` run | **Flaky, not a regression.** Re-run in isolation (`npx vitest run test/idempotency-unit.test.ts`) twice, it passed both times in ~4.4–4.5s — close to, but under, its 5000ms timeout. Under the CPU contention of the full parallel workspace test run, it occasionally crosses 5000ms. This is a genuine test-quality issue (a timing-sensitive test with a tight margin against system load) that the original campaign's reports did not call out. |
| `apps/settlement-worker` → `test/settlement-crash-recovery.test.ts` → "recovers to exactly one COMPLETED settlement after the worker is killed mid-settlement" | FAILED: `KafkaJSConnectionError: Connection error` | **Environment-dependent, not a regression.** This is a chaos test that spawns a real child-process worker and requires live Kafka/Postgres. No Docker infra was brought up for this particular rerun (see `00_AUDIT_INVENTORY/audit_scope.md` — infra was deliberately not re-raised in this audit pass to stay time-boxed and avoid repeating the `coverage-e2e/` git side-effect risk from the first campaign). This test is expected to fail without live infra; it is not evidence of a new defect. |

Neither failure contradicts the original campaign's findings — the original campaign's own
coverage run (see below) uses a **narrower Vitest config that excludes this chaos test**, which
is why both the original and this audit's coverage rerun are clean. But the original campaign's
`MASTER_TESTING_SUMMARY.md` and `03_UNIT_TESTING/unit_testing_report.md` should be read with
this caveat: `npm test` run cold, with no infra and under parallel load, is not 100% green. This
is logged as a discrepancy in `11_DISCREPANCIES_AND_DEFECTS/critical_findings.md`.

All other workspaces' unit suites passed identically to what would be expected (razorpay-adapter
50/50, ledger-client 68/68, oracle 29/29, shared 25/25, telemetry 15/15, config 17/17, etc.).

## 4. Coverage — `npm run test:coverage`

| Metric | Original claim | Independently rerun | Match |
|---|---|---|---|
| Statements | 80.64% (1837/2278 implied) | 80.64% (1837/2278) | YES |
| Branches | not separately stated in original summary | 83.22% (382/459) | n/a |
| Functions | not separately stated in original summary | 83.56% (122/146) | n/a |
| Lines | 80.64% | 80.64% (1837/2278) | YES |
| Test files / tests | not itemized in original summary | 13 files, 246 passed, 1 skipped | n/a |

Exact match on the headline statement/line coverage figure. This confirms the coverage config
(`vitest.coverage.config.ts`) runs a bounded, deterministic subset of suites that does not
include the live-infra chaos test, which is why this number is reproducible run-to-run while
the broader `npm test` is not.

## 5. CRITICAL defect (DEFECT-003) — independent source verification

Re-derived from scratch, not trusted from the original report:

1. `packages/oracle/src/index.ts:127` — `SELECT count(*) FILTER (WHERE NOT allowed AND NOT
   dismissed) AS rejected, count(*) AS total FROM scope_checks WHERE contract_id = $1`.
   Confirmed by direct `grep`/`Read`.
2. `grep -rn "dismissed" infra/migrations/postgres/` across all 25 migration files
   (`V001__init.sql` through `V025__password_reset_and_verification.sql`) returned **zero
   matches**. The `scope_checks` table itself is created in `V008__oracle_state.sql`, which also
   returns no `dismissed` match. **Independently confirmed: no migration creates this column.**
3. `git blame -L 120,130 -- packages/oracle/src/index.ts` attributes the `AND NOT dismissed`
   clause to commit `32c0913e` ("Fix scope rejection dismissal logic", Sowmith Shetty,
   2026-09-07). This matches the original campaign's attribution exactly.
4. `git show 6c571aa` (the revert immediately prior) shows the removed diff included
   `ALTER TABLE scope_checks ADD COLUMN IF NOT EXISTS dismissed BOOLEAN NOT NULL DEFAULT FALSE`
   plus a `CHECK` constraint — i.e., the migration that *would have* created this column was
   deleted by the revert, and the later "fix" commit re-added the SQL reference without
   restoring the migration.

**Verdict: DEFECT-003 is independently confirmed, root cause fully reproducible from source and
git history alone, no live database needed to establish this.** This is a genuine, currently
unresolved CRITICAL defect: every call to `OracleStore.evaluate()` will throw a Postgres
"column does not exist" error against a database built from the current migration set, blocking
every settlement.

## 6. HIGH defect (DEFECT-002) — independent source verification (refined)

Not re-executed live in this audit (no infra up — see scope). Verified at the source level:

- `apps/api-gateway/src/routes/contracts-lifecycle.ts:92-120`
  (`withAlwaysVisibleFreelancers`) **does** correctly filter on `ap.token_valid = TRUE` (line 98)
  — but only for freelancers it *adds* as extras (line 103-104: `rows.filter((row) =>
  !present.has(row.freelancer_id))`). It never removes a freelancer who is already present in
  the base ranked `results`.
- The degraded-path base ranking query (lines 360-366, `SELECT ... FROM freelancer_profiles f
  JOIN users u ... ORDER BY f.trust_score DESC`) has **no `token_valid` or `auth_providers`
  filter at all**. A freelancer with a stale GitHub token but a high `trust_score` will appear
  directly in `rankedResults` before `withAlwaysVisibleFreelancers` ever runs.
- **Refined root cause:** the bug is not in the always-visible helper's own filter (which is
  correct for the rows it adds) — it is that the base ranking path(s) that feed into it have no
  staleness filter, so a stale-token freelancer who ranks well on trust score is never excluded.
  This is consistent with, and sharper than, the original campaign's description ("the
  always-visible matching code path does not correctly filter").
- This refinement is a source-reading conclusion only. The original campaign's live
  AssertionError evidence (`expected [...(3)] to not include 'freelancer-stale-...'`) was not
  re-produced in this audit pass since infra was not brought back up. The defect is corroborated
  but not re-executed.
