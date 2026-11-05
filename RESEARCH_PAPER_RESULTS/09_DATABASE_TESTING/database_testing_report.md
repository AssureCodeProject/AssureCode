# Database Testing Report

## Method
Database testing was performed as part of the Phase 5 integration run (`npm run test:e2e -- --no-python`), which brings up a real, disposable PostgreSQL 16 (pgvector) container and a real Neo4j 5.26 container via `infra/docker-compose.test.yml`, rather than a separate hand-written DB test. This is consistent with "use the project's own isolated test harness" and avoided touching any production or developer database (the harness uses its own Docker project name, disposable ports, and a dedicated `assurecode_test` database/credentials — see `17_REPRODUCIBILITY/execution_commands.md`).

## Schema validation
- **Migration application**: all 25 migrations under `infra/migrations/postgres/` (V001 through V025) applied successfully to a fresh database — confirmed from the migrate step's own log: `[migrate] Complete. 25 applied, 0 skipped.` (evidence: `04_INTEGRATION_TESTING/execution_logs/e2e_output.txt`, line ~112).
- **Schema/application drift detected**: `packages/oracle/src/index.ts` queries a `scope_checks.dismissed` column that does not exist in any of the 25 applied migrations. This is a genuine, confirmed schema-vs-application-code mismatch — see `16_DEFECT_TRACKING/critical_defects.md` (DEFECT-003). This was discovered BY this database testing, not assumed — the Postgres error `column "dismissed" does not exist` is a real error returned by the live database, captured verbatim in the integration test log.
- No other schema mismatches were observed in the 594 passing tests that touch the database (CRUD, constraints, foreign keys, and indexes implied by those migrations all exercised successfully across the api-gateway, ci-worker, webhook-ingest, and most of the settlement-worker suites).

## CRUD / transaction / concurrency testing
Not independently hand-tested beyond what the existing JS/TS test suites already exercise against the real database in Phase 5. The 594 passing tests include substantial real-database CRUD coverage (contract creation, user records, payment events, KYC records, etc., per the migration set: V010 payment_events_and_users, V011 kyc_compliance, V014 razorpay_escrow, V022 repo_provisioning). A dedicated, independent transaction/rollback/concurrency stress test beyond what these suites already assert was NOT separately authored in this pass — see limitations.

## Neo4j
Seeded successfully (`▸ Seeding Neo4j` step completed without error in the integration log) but not independently queried or validated beyond what the existing test suites exercise, since no test failures were observed that implicated the Neo4j/graph-backend path in this run.

## Connection failure / recovery behavior
Not independently tested (would require deliberately killing the Postgres/Redis containers mid-test and observing recovery — out of scope for this pass; see limitations).

## Status: PARTIAL PASS — schema successfully migrates and the large majority of database-touching tests pass against real infrastructure; one CRITICAL schema/application drift defect found and documented (DEFECT-003). Dedicated destructive/recovery/concurrency database testing was not separately performed.
