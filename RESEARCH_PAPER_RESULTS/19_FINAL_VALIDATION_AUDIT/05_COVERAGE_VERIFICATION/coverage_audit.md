# Independent Coverage Verification

Rerun command: `npm run test:coverage` (invokes `vitest run --coverage --config
vitest.coverage.config.ts`), executed fresh during this audit, no reuse of stale `coverage/`
artifacts.

| Metric | Previously reported (original campaign) | Independently measured (this audit) | Difference | Verified |
|---|---|---|---|---|
| Statements | 80.64% | 80.64% (1837/2278) | 0 | YES |
| Lines | 80.64% | 80.64% (1837/2278) | 0 | YES |
| Branches | not stated in original top-line summary | 83.22% (382/459) | n/a | newly measured |
| Functions | not stated in original top-line summary | 83.56% (122/146) | n/a | newly measured |
| Test files executed | not itemized | 13 | n/a | newly measured |
| Tests passed | not itemized | 246 passed, 1 skipped | n/a | newly measured |

## Tooling and scope

- Tool: Vitest v3.2.7 with `@vitest/coverage-v8` (V8-native instrumentation), per
  `vitest.coverage.config.ts`.
- Scope: this config runs a bounded subset of suites — it excludes the live-infra chaos test
  (`settlement-crash-recovery.test.ts`) that requires Kafka, which is why this number is
  reproducible without Docker infra while the broader `npm test` is not (see
  `03_INDEPENDENT_EXECUTION/execution_validation_report.md`).

## Caveat on interpretation (per audit spec's own warning)

An 80.64% statement-coverage figure does **not** mean 80.64% of behavior is validated. The
oracle package's 29/29 passing unit tests run entirely against a fake `pg.Pool` (see
`02_EXISTING_TEST_AUDIT/existing_test_audit.md`) and would report their covered lines as
"covered" by this tool regardless of whether the real SQL is schema-valid — which it is not
(DEFECT-003). Coverage percentage and functional correctness are measured independently here
and must not be conflated, consistent with the master spec's own instruction in Phase 8.

## Conclusion

The headline coverage figure is accurate and reproducible. No discrepancy found.
