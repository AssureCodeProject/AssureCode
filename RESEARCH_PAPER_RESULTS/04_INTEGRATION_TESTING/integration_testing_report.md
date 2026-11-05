# Integration Testing Report

## Method
Used the project's own dedicated integration-test harness (`scripts/e2e.mjs`, invoked via `npm run test:e2e -- --no-python`) rather than hand-rolling a separate integration setup. This script:
- Brings up an isolated Docker Compose stack (`infra/docker-compose.test.yml`), project name `assurecode-e2e`, on disposable non-default ports (Postgres 55432, Redis 56379, Neo4j bolt 57687, LocalStack 54566) — confirmed not to collide with or affect the user's separate, pre-existing long-running dev stack (`assurecode-postgres`, `assurecode-api-gateway`, etc., already up independently of this campaign; left untouched).
- Creates the test S3 bucket, builds all 13 npm workspaces, applies all Postgres migrations, seeds Neo4j.
- Runs the full JS/TS test suite (unit + integration) against this real, disposable infrastructure, with coverage instrumentation.
- Tears the stack down cleanly afterward (confirmed via Docker container/network removal messages in the log).
- `--no-python` was passed to skip the two Python app services (`apps/ai-service`, `apps/scope-guard`) and the golden-path E2E test that depends on them, since their `.venv` setup was not verified in this pass (see limitations).

Evidence: `execution_logs/e2e_output.txt` (full run, start to teardown).

## Result
- **Test Files: 50 passed / 3 failed (53)**
- **Tests: 594 passed / 8 failed / 2 skipped (604)**
- Duration: 199.54s for the test execution phase (plus stack startup/build/migrate/seed time).
- Exit code: 1 (the script correctly reports failure because real test failures occurred).

## Failures (8 tests across 3 files) — all investigated, root-caused, and filed as defects
1. **`apps/api-gateway/test/match-always-visible.test.ts`** — 1 failure: a genuine functional defect (stale GitHub-token freelancer not excluded from matcher results). Filed as **DEFECT-002 (HIGH)**. The other 3 tests in this file's describe block, which failed as timeouts in the no-infra baseline run, now pass with real Postgres — confirming the earlier timeouts were a test-harness skip-guard issue (**DEFECT-002a**), separate from this real bug.
2. **`apps/settlement-worker/test/settlement.test.ts`** — 6 failures, all `error: column "dismissed" does not exist` inside `OracleStore.evaluate()`. This is a confirmed schema/application drift bug — filed as **DEFECT-003 (CRITICAL)**, traced to a specific commit (`32c0913`) via git history. See `16_DEFECT_TRACKING/critical_defects.md` for the full root-cause analysis.
3. **`apps/settlement-worker/test/settlement-crash-recovery.test.ts`** — 1 failure: "timed out after 30s waiting for settlement PROCESSING". Very likely a downstream symptom of DEFECT-003: the settlement worker's own error handling (`apps/settlement-worker/src/worker.ts` ~line 1079) catches the oracle's thrown error and publishes `SETTLEMENT_REJECTED` instead of letting the flow reach `PROCESSING`, which is consistent with this test's specific wait condition timing out. Filed jointly under DEFECT-003.

## What this run validates (positive evidence)
- 594 passing tests confirm correct behavior across a large surface with real Postgres, Redis, Neo4j, and LocalStack S3 running simultaneously — including migration application (25/25 applied cleanly), Neo4j seeding, and the majority of the api-gateway/ci-worker/settlement-worker/webhook-ingest/package-level suites.
- Frontend-backend, backend-database, and backend-cache integration paths that worked in Run 1 (no infra) continued to work correctly once given the real infra they were built against.

## Golden-path end-to-end test: NOT RUN
`test/golden-path.e2e.test.ts` (the only test that drives a full contract lifecycle — initialize, lock, push, audit, score, settle) requires the Python `ai-service` for trust scoring and was skipped in this pass via `--no-python`. Given DEFECT-003 above, it would very likely fail at the settlement step even with Python services running, since the settlement oracle gate is broken for all contracts. This is recorded as a gap, not papered over — see `18_FINAL_AUDIT/limitations.md`.

## Status: PARTIAL PASS — real infrastructure integration confirmed working for the large majority of the system; 2 real, actionable defects found and root-caused (1 CRITICAL, 1 HIGH), plus 1 test-harness-only issue (DEFECT-002a).
