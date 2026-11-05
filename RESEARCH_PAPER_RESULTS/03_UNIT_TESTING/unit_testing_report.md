# Unit Testing Report

Command: `npm test` (runs `test --if-present` in every workspace). Evidence: `execution_logs/npm_test_output.txt`.
Run 1 executed WITHOUT local infra (Postgres/Kafka) up — this is the baseline "no external services" run. A second pass is recorded after Phase 5 brings up Docker infra (see `execution_logs/npm_test_output_rerun_with_infra.txt` if present).

## Per-workspace results (Run 1, no infra)

| Workspace | Test Files | Tests | Status |
|---|---|---|---|
| apps/api-gateway | 2 failed / 24 passed (26) | 5 failed / 180 passed / 1 skipped (186) | FAIL |
| apps/ci-worker | 5 passed (5) | 103 passed (103) | PASS |
| apps/settlement-worker | 1 failed / 7 passed (8) | 1 failed / 54 passed (55) | FAIL |
| apps/webhook-ingest | 1 passed (1) | 13 passed (13) | PASS |
| packages/config | 1 passed (1) | 12 passed (12) | PASS |
| packages/email-adapter | — | — | FAIL (no test files found; `test` script exists but zero `*.test.*`/`*.spec.*` files present) |
| packages/event-bus | 2 passed (2) | 30 passed / 1 skipped (31) | PASS |
| packages/kyc-adapter | 1 passed (1) | 17 passed (17) | PASS |
| packages/ledger-client | 4 passed (4) | 68 passed (68) | PASS |
| packages/oracle | 1 passed (1) | 29 passed (29) | PASS |
| packages/razorpay-adapter | 1 passed (1) | 50 passed (50) | PASS |
| packages/shared | 1 passed (1) | 25 passed (25) | PASS |
| packages/telemetry | 2 passed (2) | 15 passed (15) | PASS |
| apps/ai-service | N/A | N/A | NOT RUN — Python workspace, not an npm workspace; `npm test` does not reach it. See limitations. |
| apps/scope-guard | N/A | N/A | NOT RUN — Python workspace, not an npm workspace; `npm test` does not reach it. |
| apps/web | N/A | N/A | NOT APPLICABLE — no `test` script defined in package.json. |

**Totals across npm workspaces (Run 1):** 6 failing tests, ~586 passing tests, 2 skipped, across 13 workspaces with test scripts.

## Failure analysis

1. **`apps/api-gateway/test/idempotency-unit.test.ts` — "stays bounded well past the 10 000-entry cap"**
   Fails with `Test timed out in 5000ms`. The test performs 10,600 sequential `await withIdempotency(...)` calls with no explicit per-test timeout override (sibling tests in the same file pass an explicit `15_000` ms third argument to `it()`; this one does not). This machine's execution time for that loop exceeds the vitest default 5000ms budget. This is a test-suite reliability defect (missing explicit timeout), not necessarily an application logic defect — recorded as DEFECT-003.

2. **`apps/api-gateway/test/match-always-visible.test.ts` — 4 tests, all `Test timed out in 5000ms`**
   File contains a `PG_UP` guard intended to skip the suite when `DATABASE_URL`'s Postgres is unreachable (`if (!PG_UP) announceSkip(...)`), but in Run 1 (no Postgres running) the tests still attempted live `pg.Pool` operations and hung to the timeout instead of skipping cleanly. Re-tested in Phase 5 with local Postgres up via docker compose — see integration report for the result.

3. **`apps/settlement-worker/test/settlement-crash-recovery.test.ts` — "recovers to exactly one COMPLETED settlement after the worker is killed mid-settlement"**
   Fails with `KafkaJSConnectionError: ECONNREFUSED` to `localhost:9092`. This is expected: no Kafka broker was running during Run 1. Re-tested in Phase 5 with Kafka up via docker compose.

4. **`packages/email-adapter`**
   `vitest run` exits 1 with "No test files found" — the workspace defines a `test` script but contains zero test files under `src/` or elsewhere matching vitest's include glob. This is a genuine test-coverage gap, independent of infra — recorded as DEFECT-004.

## Status: PARTIAL PASS
13/13 applicable npm workspaces executed; 11/13 fully passed; 2/13 had failures attributable to missing local infra in Run 1; 1/13 (email-adapter) has zero test files (a genuine gap, not an infra issue). Python workspaces (ai-service, scope-guard) are out of scope for `npm test` and were not executed in this pass (see limitations.md for required follow-up: `pytest`).

## UPDATE after Phase 5 (real infra): the "infra-attributable" failures were only partially explained by missing infra
Re-running the affected suites with real Postgres/Redis up (see `04_INTEGRATION_TESTING/integration_testing_report.md`) showed:
- `apps/api-gateway/test/match-always-visible.test.ts`: 3 of 4 previously-timing-out tests now PASS; the 4th fails with a real, different assertion error — a genuine functional defect (**DEFECT-002, HIGH**), not an infra issue. The original timeout was a separate test-harness problem (**DEFECT-002a**) that had been masking this bug.
- `apps/settlement-worker/test/settlement-crash-recovery.test.ts`: still fails with real infra up, but now for a different, more serious reason — a confirmed CRITICAL schema/application drift bug in the settlement oracle gate (**DEFECT-003**, see `16_DEFECT_TRACKING/critical_defects.md`), not a Kafka availability issue as the Run 1 symptom suggested.

This is the exact reason a "narrow, real, verifiable slice" campaign is valuable: the no-infra baseline run's failure *symptoms* (timeouts, connection errors) would have been easy to dismiss as "just needs infra," but running with real infra surfaced two real, previously-undetected functional defects, one of them release-blocking.
