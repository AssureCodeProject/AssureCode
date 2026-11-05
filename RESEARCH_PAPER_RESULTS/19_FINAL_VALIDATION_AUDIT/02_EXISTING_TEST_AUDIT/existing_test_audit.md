# Existing Test Audit — Quality Review

## Sample reviewed

### `packages/oracle/test/oracle.test.ts` (393 lines, 29 tests)

- Uses a hand-rolled fake `pg.Pool` (`fakePool()`, lines 41-66) instead of a real Postgres
  connection. This is **disclosed in the file's own header comment** (lines 10-15): "These run
  against a stub `pg.Pool` rather than a live Postgres ... The SQL itself is covered by the
  gateway and settlement-worker integration suites."
- This is appropriate, not evasive, mocking: `OracleStore.evaluate()` is pure decision logic
  over three query result shapes, and the fake pool records every call (`calls` array) so tests
  can assert on what was actually queried (e.g. line 241: `expect(pool.calls.some((c) =>
  c.sql.includes('FROM scope_checks'))).toBe(true)`), not just on canned return values.
- Consequence for the CRITICAL defect: **this test suite could never have caught DEFECT-003**
  (the missing `scope_checks.dismissed` column) because the fake pool answers any query
  matching `FROM scope_checks` with a synthetic row — it doesn't know the real schema lacks the
  column. The suite's own comment correctly attributes real-SQL verification to the integration
  suites, and that is exactly where the original campaign found the defect (via the live e2e
  harness, not via this unit suite). No quality defect here — the limitation is self-aware and
  the real-schema check lives at the right test level.
- Assertions are specific and behavior-based (e.g. checking `TRUST_SCORE_THRESHOLD` boundary
  conditions, null trust-score handling, missing `oracle_state` row handling), not placeholder
  "does not throw" checks.

### `apps/api-gateway/test/match-always-visible.test.ts`

- Line 19: `const PG_UP = await postgresAvailable();` — a real connectivity probe, not a mock.
- Line 23: `describe.skipIf(!PG_UP)(...)` — correctly structured conditional skip (this is the
  one "1 skipped" seen in some reruns when infra isn't up; it is a legitimate, visible skip
  guard, not a hidden `.skip()`).
  it-level `.skip()` or `.only()` calls anywhere under `apps/*/test/` or `packages/*/test/`.
  No evidence of hidden/disabled tests found.
- Line 135: `expect(ids).not.toContain(staleId)` — a concrete, falsifiable assertion against a
  freelancer ID seeded earlier in the same test with `token_valid = FALSE` (lines 62-69). Not a
  tautological or mock-only assertion.
- This test exercises the real route against a real seeded Postgres row when infra is up — it
  is a genuine integration test, not a unit test dressed up as one.

## Repo-wide disabled-test check

`grep -rn "\.skip\(\|it\.skip\|describe\.skip\b"` across `apps/*/test/*.ts` and
`packages/*/test/*.ts` (excluding the legitimate `skipIf` pattern) returned **zero matches**.
No hard-disabled tests were found anywhere in the sampled tree.

## Assessment

The sampled tests are well-targeted: unit-level tests mock at the right boundary and disclose
it in comments; integration-level tests use real Postgres and real seeded data. This is a sound
test-pyramid pattern, not mocking used to hide a broken implementation. The one quality concern
found in this audit is procedural, not about these two files — see
`03_INDEPENDENT_EXECUTION/execution_validation_report.md` for a timing-sensitive test
(`idempotency-unit.test.ts`) discovered during the independent rerun.
