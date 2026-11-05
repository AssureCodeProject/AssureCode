# Critical Defects

## DEFECT-003 — `scope_checks.dismissed` column does not exist; breaks the settlement oracle gate for every contract

**Severity: CRITICAL.** Confirmed with real infrastructure (Phase 5 integration run against a freshly-migrated Postgres, 25/25 migrations applied).

`packages/oracle/src/index.ts` (line 127) executes:
```sql
SELECT count(*) FILTER (WHERE NOT allowed AND NOT dismissed) AS rejected, count(*) AS total
  FROM scope_checks WHERE contract_id = $1
```
No migration under `infra/migrations/postgres/` (V001 through V025, the full set applied in this test run) creates a `dismissed` column on `scope_checks`. Every call to `OracleStore.evaluate()` throws `error: column "dismissed" does not exist`.

**Blast radius:** `OracleStore.evaluate()` is the settlement gate — the function that decides whether escrowed funds are released. `apps/settlement-worker/src/worker.ts` (around line 1079) catches this exact exception and publishes `SETTLEMENT_REJECTED` with reason `"Oracle state unavailable: column \"dismissed\" does not exist"` instead of letting a legitimately-qualifying contract proceed. This means **no settlement can ever be approved** on an environment migrated from the current `infra/migrations/` set — every contract is rejected regardless of trust score or vulnerability status.

**Root cause (traced via git history):**
1. `cf63b51` "Add scope-check dismissal and security LLM" added both the `dismissed` column (migration `V026__scope_check_dismissal.sql`) and the `NOT dismissed` SQL clause.
2. `6c571aa` "Revert \"Add scope-check dismissal and security LLM\"" correctly reverted both the migration and the SQL clause together.
3. `32c0913` "Fix scope rejection dismissal logic" (second-to-last commit on `main` at the time of this campaign) **re-added the `NOT dismissed` SQL clause without restoring the migration** that creates the column. Confirmed by `grep -rl dismissed --include=*.sql infra/migrations/postgres/` returning zero matches against all 25 migrations.

**Evidence:** `RESEARCH_PAPER_RESULTS/04_INTEGRATION_TESTING/execution_logs/e2e_output.txt`, lines ~741-821 (6 direct failures in `apps/settlement-worker/test/settlement.test.ts`'s "settlement oracle gate" suite, all with the identical Postgres error) and lines ~728-738 (the `settlement-crash-recovery.test.ts` timeout, consistent with this same rejection path).

**Recommended fix (not applied — read-only testing policy):** restore a migration adding `scope_checks.dismissed BOOLEAN NOT NULL DEFAULT false` (or equivalent), or revert the `NOT dismissed` clause introduced by `32c0913` until that column exists.

See `defect_register.csv` (DEFECT-003) for the full structured record.
