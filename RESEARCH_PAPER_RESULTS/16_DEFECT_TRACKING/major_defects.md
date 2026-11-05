# Major (HIGH) Defects

## DEFECT-002 — Stale GitHub-connected freelancer not excluded from always-visible matcher results

**Severity: HIGH.** Confirmed with real infrastructure (Phase 5 integration run).

`apps/api-gateway/test/match-always-visible.test.ts`'s "excludes a freelancer whose GitHub connection has gone stale (token_valid=false)" test fails with a genuine assertion error once real Postgres is available:

```
AssertionError: expected [ …(3) ] to not include 'freelancer-stale-1793876503207'
```

The always-visible matcher is supposed to exclude freelancers whose GitHub token is no longer valid (`token_valid=false`), per the test's own stated intent and consistent with the other 3 tests in the same describe block (which pass — e.g. correctly including a freelancer with no profile row, correctly marking unmeasured skill matches honestly). The stale-token freelancer is incorrectly included in the always-visible result set.

This is a real access-control / data-freshness defect, not a test or infra issue: with Postgres reachable, the suite's `PG_UP` guard correctly lets the tests run, and 3 of the 4 tests in the block pass — only the stale-token exclusion is wrong.

**Evidence:** `RESEARCH_PAPER_RESULTS/04_INTEGRATION_TESTING/execution_logs/e2e_output.txt`, lines ~716-725.

**Note:** In the baseline run without infra (Run 1), this defect was masked by DEFECT-002a — a separate test-harness issue where the whole describe block hung to timeout instead of skipping cleanly when Postgres was unreachable. Fixing only DEFECT-002a would not fix this underlying functional bug; both are recorded.

See `defect_register.csv` (DEFECT-002, DEFECT-002a) for full structured records.
