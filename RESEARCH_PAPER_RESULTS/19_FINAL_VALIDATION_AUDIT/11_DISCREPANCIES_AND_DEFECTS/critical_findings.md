# Discrepancies Between Original Campaign and This Independent Audit

| Claim / Artifact | Original value | Independently verified value | Discrepancy | Required action |
|---|---|---|---|---|
| Lint (errors/warnings) | 0 errors / 138 warnings | 0 errors / 138 warnings | None | None |
| Build exit code / workspace count | 0 / 13 workspaces | 0 / 13 workspaces | None | None |
| Coverage (statements/lines) | 80.64% | 80.64% (1837/2278) | None | None |
| CRITICAL defect DEFECT-003 (oracle `dismissed` column) | Confirmed by original campaign via live e2e run | Independently re-confirmed via static source + migration grep + git blame/show, with no live DB needed | None — strengthened, not just repeated | Still unresolved; see verdict |
| HIGH defect DEFECT-002 (matchmaker stale-token leak) | Confirmed by original campaign via live e2e AssertionError | Corroborated via source reading only; **not re-executed live** in this audit (no infra up) | Partial — root cause refined to be more specific (base ranking query lacks token_valid filter; the always-visible helper's own filter is actually correct) | Treat as confirmed-by-source but not re-executed; a future audit pass should re-run live to be fully independent |
| `npm test` (full workspace unit run) | Not itemized with a pass/fail count in the original top-line summary (original campaign's unit-testing claims focus on the 594/604 live e2e integration number, run with Docker infra up) | 2 failures found when rerun cold without Docker infra: a timing-flaky test (`idempotency-unit.test.ts`) and an infra-dependent chaos test (`settlement-crash-recovery.test.ts`) | **New finding, not previously documented**: `npm test` is not green when run without live infra, and one test (`idempotency-unit.test.ts`) is independently flaky under parallel-run CPU contention regardless of infra state | Recommend: (1) raise `idempotency-unit.test.ts`'s timeout or isolate it from parallel contention; (2) document in the original campaign's reports that `npm test` alone (without `infra:up`) is expected to show the crash-recovery test as failing, not passing — this was not stated plainly in the original `03_UNIT_TESTING/unit_testing_report.md` |
| Protected file integrity (6 files) | Unchanged (SHA-256 match) | Unchanged (SHA-256 match, independently recomputed) | None | None |
| Hidden/disabled tests | Not explicitly checked in original campaign | Repo-wide grep for hard `.skip()`/`.only()` found zero matches | None (new check, negative result) | None |

## Summary

No fabricated or inaccurate PASS claims were found in the original campaign's headline numbers
(lint, build, coverage) — all three reproduced exactly. The CRITICAL defect's root cause was
independently re-derived and holds up fully from first principles (source + migrations + git
history), strengthening confidence in that finding. The HIGH defect is corroborated by source
reading but was not re-executed live in this audit, which is disclosed as a limitation rather
than claimed as a full independent reproduction.

The one genuinely new finding from this audit is that `npm test` run cold (no Docker infra, full
parallel workspace run) surfaces 2 failures that the original campaign's reports did not
foreground — one is a flaky timing test, one is the expected consequence of not having infra up
for a chaos test. Neither is a new regression, but the original campaign's unit-testing report
should have stated more plainly that a bare `npm test` is not unconditionally green.
