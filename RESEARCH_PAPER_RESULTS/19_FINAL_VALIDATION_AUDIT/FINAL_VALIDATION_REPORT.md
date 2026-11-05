# Final Validation Audit Report — AssureCode Testing Campaign

Audit date: 2026-11-05. Scope and limitations: see `00_AUDIT_INVENTORY/audit_scope.md`.

## 1. Executive Summary — the four core questions

**(a) Have all applicable tests actually been performed?**
No. Both the original campaign and this audit agree on this. The original campaign's own
`18_FINAL_AUDIT/testing_completion_matrix.csv` (independently spot-checked and found accurate
in this audit — see §2) marks 13 of 26 A–Z categories as **NOT RUN** or **NOT APPLICABLE**,
including all security testing, all performance/load testing, all GUI testing, cryptographic
validation, and research-grade experiments. This audit did not newly execute any of those —
it independently re-verified what *was* claimed as done, not expanded the tested surface.

**(b) Has any testing requirement, feature, module, edge case, or workflow been missed?**
One concrete new gap was found: running `npm test` cold (no Docker infra, full parallel
workspace run) is **not** unconditionally green — it surfaces a flaky timing test
(`idempotency-unit.test.ts`) and an infra-dependent chaos test failure
(`settlement-crash-recovery.test.ts`) that the original campaign's unit-testing report did not
foreground. See `03_INDEPENDENT_EXECUTION/execution_validation_report.md` and
`11_DISCREPANCIES_AND_DEFECTS/critical_findings.md`. No hidden/disabled tests (`.skip()`/
`.only()`) were found anywhere in the sampled source tree.

**(c) Are the test results accurate, genuine, and independently reproducible?**
Yes, for everything re-executed in this audit. Lint (0 errors/138 warnings), build (13
workspaces, exit 0), and coverage (80.64% statements/lines) all reproduced **exactly** on
independent rerun. The CRITICAL defect's root cause was independently re-derived from source,
25 migration files, and git history — not merely re-read from the prior report — and holds up
completely. The HIGH defect is corroborated by independent source reading but **was not
re-executed live** in this audit pass (no Docker infra raised); this is disclosed as a
limitation, not claimed as a full reproduction.

**(d) Does the actual implemented system function correctly under the tested conditions?**
**No, not fully.** A real, independently confirmed CRITICAL defect (DEFECT-003) means every
call to the settlement oracle's `evaluate()` throws against a database built from the current
migration set — **settlements are currently broken on any freshly migrated environment.** This
is not a hypothetical or a test artifact; it is reproducible purely from reading
`packages/oracle/src/index.ts:127` against `infra/migrations/postgres/*.sql`, with no database
required to confirm it. A second, HIGH-severity access-control defect (stale GitHub tokens not
excluded from freelancer matching) is also unresolved. Outside of these two defects, everything
independently rerun in this audit (build, lint, coverage, the bulk of the unit suites) behaves
as claimed.

## 2. A–Z Testing Completeness Matrix — validation of the original

The original `18_FINAL_AUDIT/testing_completion_matrix.csv` was read in full and spot-checked
against this audit's own independent findings (lint/build/coverage numbers, DEFECT-003 and
DEFECT-002 details, protected-file hashes). **No inaccuracies found.** The matrix is honest:
it marks Security, Performance, GUI, Configuration, Dependency, Key/Cryptographic, Logging,
Operational, and Research Experiments as NOT RUN with specific justifications, rather than
papering over them. This audit defers to that matrix as accurate and does not reproduce it in
full here.

One line item deserves a sharper caveat than it currently has: **"Functional Testing — PARTIAL
PASS... 586 unit tests baseline."** This audit found that a bare `npm test` (no infra) is not
cleanly green (see §4). The underlying unit suites are sound; the caveat is about environment
dependency, not about the count being wrong.

## 3. Bidirectional Test Traceability

Full bidirectional source-to-test / test-to-source traceability across all modules (as specified
in the master prompt's Phase 2) was **not performed** in this audit — it is explicitly out of
this audit's time-boxed scope (see `00_AUDIT_INVENTORY/audit_scope.md`). What was done instead:
targeted traceability on the two defects found by the original campaign (§5, §6 below), plus a
quality read of two representative test files. This is a partial, not exhaustive, traceability
check.

## 4. Test Script Quality Assessment

Reviewed in depth: `packages/oracle/test/oracle.test.ts` (29 tests) and
`apps/api-gateway/test/match-always-visible.test.ts`. Findings:

- Oracle's unit tests appropriately mock `pg.Pool` at the unit level and **self-disclose** this
  limitation in a header comment, correctly deferring real-SQL verification to integration
  suites — which is exactly where DEFECT-003 was actually caught. This is sound test-pyramid
  design, not evasive mocking.
- The matchmaker test uses real Postgres connectivity (`postgresAvailable()`), real seeded
  rows, and a concrete falsifiable assertion (`expect(ids).not.toContain(staleId)`) — a genuine
  integration test, not a mock-only check.
- Repo-wide grep found **zero** hard-disabled (`.skip()`/`.only()`) tests.
- One flaky test identified independently in this audit: `idempotency-unit.test.ts`'s
  10,000-entry cache-bound test, which passes reliably in isolation (~4.4–4.5s) but can exceed
  its 5000ms timeout under full-workspace parallel load. Recommend raising the timeout or
  isolating this test from concurrent contention.

Full detail: `02_EXISTING_TEST_AUDIT/existing_test_audit.md`.

## 5. Independent Test Execution Results

| Check | Original claim | Independent rerun | Result |
|---|---|---|---|
| Lint | 0 errors, 138 warnings | 0 errors, 138 warnings | MATCH |
| Build | 13 workspaces, exit 0 | 13 workspaces, exit 0 | MATCH |
| Coverage (stmt/line) | 80.64% | 80.64% | MATCH |
| `npm test` (cold, no infra) | not itemized as a standalone claim | 2 failures (1 flaky, 1 infra-dependent) | NEW FINDING, not a contradiction |
| DEFECT-003 root cause | Column missing from migrations, traced to commit 32c0913 | Independently re-derived identically from source + migration grep + git blame/show | MATCH, strengthened |
| DEFECT-002 root cause | Always-visible matcher fails to exclude stale-token freelancer | Corroborated by source reading; root cause refined (base ranking query lacks token_valid filter, not the always-visible helper itself) — **not re-executed live** | CORROBORATED, not independently re-executed |

Full detail and exact commands: `03_INDEPENDENT_EXECUTION/execution_validation_report.md`.

## 6. Newly Discovered Missing Tests

None newly authored in this audit pass (out of time-box — see scope doc). One gap identified
for future work: there is no test that exercises `OracleStore.evaluate()` against a *real*,
freshly-migrated Postgres schema in CI — if there were, DEFECT-003 would be caught automatically
on every PR rather than requiring a manual e2e campaign to surface it.

## 7. Functional Correctness Results

Confirmed broken: settlement oracle evaluation against a real schema (DEFECT-003, independently
re-derived, see §5). Confirmed likely broken (corroborated, not re-executed): stale-token
freelancer exclusion in matching (DEFECT-002). All other independently rerun functionality
(build, lint, the overwhelming majority of unit suites) behaves as claimed.

## 8. Independently Verified Coverage

80.64% statements/lines, 83.22% branches, 83.56% functions — exact match on the two figures the
original campaign reported, with branch/function figures newly surfaced in this audit. See
`05_COVERAGE_VERIFICATION/coverage_audit.md` for the important caveat that this percentage does
not certify DEFECT-003's affected code path as correct — coverage and correctness are distinct
measurements, and the oracle's own tests mock the database layer where the real defect lives.

## 9. Security Verification Results

Not applicable to this audit — security testing was NOT RUN in the original campaign and remains
out of scope here. No security claims to verify.

## 10. Performance Verification Results

Not applicable — performance testing was NOT RUN in the original campaign and remains out of
scope here.

## 11. Research Experiment Accuracy

Not applicable — no research experiments were conducted in the original campaign.

## 12. Reproducibility Results

Lint, build, and coverage commands reproduced their exact original figures on independent rerun
from the documented commands in `17_REPRODUCIBILITY/execution_commands.md`. The
integration/e2e figures (594/604) were **not** re-executed in this audit (infra not raised) and
so remain unverified-by-this-audit, though nothing found here contradicts them.

## 13. Incorrect Previous Claims

None found in the headline numbers (lint, build, coverage, protected-file integrity). See §4 for
one undisclosed caveat (cold `npm test` is not green) rather than an incorrect claim — the
original campaign's own 594/604 figure was always scoped to the live-infra e2e run, not to a bare
`npm test`, so there is no contradiction, only a clarity gap.

## 14. Missing Evidence

None found — every number re-checked in this audit had a corresponding saved log or was
independently reproducible from a fresh command.

## 15. Defect and Discrepancy Register

See `11_DISCREPANCIES_AND_DEFECTS/critical_findings.md` for the full table. Summary: 0
discrepancies in headline PASS claims; 1 refinement of a defect's root cause; 1 new finding
(cold `npm test` flakiness/infra-dependency not previously documented).

## 16. Protected File Integrity

All 6 protected files (`ARCHITECTURE.md`, `README.md`, `CHANGELOG.md`, `RUNBOOK.md`,
`DEMO.md`, `AssureCode-Novelty.docx`) independently re-hashed with SHA-256 and found
**byte-identical** to the original baseline. See
`00_AUDIT_INVENTORY/protected_file_integrity.csv`. No git history alteration, no source-code
modification by this audit.

## 17. Unresolved Issues

- DEFECT-003 (CRITICAL) — unresolved, independently confirmed, blocks settlements.
- DEFECT-002 (HIGH) — unresolved, corroborated by source but not re-executed live in this audit.
- Security, performance, GUI, cryptographic, and research-experiment testing remain entirely
  NOT RUN across both the original campaign and this audit.
- Full bidirectional traceability (Phase 2 of the master spec) was not performed.
- `idempotency-unit.test.ts` timing flakiness, newly identified, unresolved.

## 18. Acceptance Gate Results

| Gate | Status | Basis |
|---|---|---|
| A — Test Completeness | PARTIALLY VERIFIED | Original matrix is honest about large NOT RUN surface; this audit validated it, did not expand it |
| B — Test Quality | PARTIALLY VERIFIED | Sampled tests are high quality and honestly scoped; one flaky test found; full repo not sampled |
| C — Functional Correctness | **FAIL** | DEFECT-003 independently confirmed — a core workflow (settlements) is broken on a fresh DB |
| D — Coverage Accuracy | PASS | 80.64% figure reproduced exactly; caveat about coverage≠correctness documented |
| E — Security | NOT APPLICABLE | No security testing was in scope for either campaign |
| F — Performance | NOT APPLICABLE | No performance testing was in scope for either campaign |
| G — Research Results | NOT APPLICABLE | No research experiments were conducted |
| H — File Integrity | PASS | All 6 protected files byte-identical; no source/config/test-file modifications made by either campaign or this audit |
| I — Reproducibility | PARTIALLY VERIFIED | Lint/build/coverage fully reproducible; integration/e2e figures not re-executed in this audit |

## 19. Final Verdict: **NO-GO**

**Reason: a CRITICAL, independently reproducible defect (DEFECT-003) currently breaks the
settlement oracle on any database built from the project's own migrations — this is a
correctness failure in a core business workflow, not a test-environment artifact, and it alone
is sufficient to block a GO verdict per the master spec's own acceptance criteria ("no
unresolved critical or high-severity defects undermine the required functionality"). A HIGH
defect (DEFECT-002) compounds this. Testing-process quality is good where it was exercised
(lint/build/coverage all reproduce exactly; sampled tests are well-designed and honestly scoped;
protected files are untouched), but testing-process quality and software correctness are
separate acceptance conditions, and the second one fails here.**

This verdict would move to **CONDITIONAL GO** once DEFECT-003 is fixed and a regression test is
added that runs `OracleStore.evaluate()` against a real, freshly migrated schema (not the mocked
unit test), and once DEFECT-002 is either fixed or re-confirmed/closed with a live rerun. A full
**GO** additionally requires addressing the large remaining NOT RUN surface (security,
performance, GUI, crypto, research experiments) or an explicit, accepted risk sign-off on
leaving them untested.
