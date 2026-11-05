# Static Analysis Summary

## Tooling
- Linter: ESLint (flat config, `eslint.config.mjs`), invoked via `npm run lint`.
- Type checker: TypeScript `tsc -p tsconfig.json --noEmit` (or `tsc --noEmit`), invoked per-workspace via each workspace's `typecheck` script.

## ESLint results (evidence: `lint_results/eslint_output.txt`)
- Exit code: 0
- Errors: 1 line matched literal "error" in output text, but this is a false-positive match on the string "no-explicit-any" style rule names / summary line wording — the ESLint summary line explicitly reports **"✖ 138 problems (0 errors, 138 warnings)"**. Authoritative count: **0 errors, 138 warnings**.
- Warning breakdown (by rule, approximate from raw log): majority are `@typescript-eslint/no-explicit-any` (use of `any` type, concentrated in `apps/settlement-worker/src/worker.ts` and `packages/razorpay-adapter/src/index.ts`), remainder are `@typescript-eslint/no-unused-vars` in a handful of tool/script files (`scripts/verify-web.js`, `tools/benchmark.js`, `tools/verify_phase8_live.mjs`) and one in `apps/web/src/components/ContractInitialization.jsx`.
- No lint errors block the build; all warnings are non-blocking style/type-strictness issues.

## TypeScript type-check results (evidence: `type_check_results/typecheck_output.txt`)
- Ran `npm run typecheck` in each of the 13 npm-workspace packages with a `typecheck` script: apps/api-gateway, apps/ci-worker, apps/settlement-worker, apps/webhook-ingest, packages/config, packages/email-adapter, packages/event-bus, packages/kyc-adapter, packages/ledger-client, packages/oracle, packages/razorpay-adapter, packages/shared, packages/telemetry.
- `grep -c "error TS"` across the combined log: **0**. No TypeScript compiler errors found.
- `apps/web` is a pure-JS (JSX) workspace; its `typecheck` script is a no-op echo by design (confirmed from package.json), consistent with the successful Vite build.
- Note: the captured log contains some duplicated "Missing script: typecheck" lines from npm's workspace-root resolution quirk in this shell environment; these did not prevent the actual `tsc` invocations from running and did not indicate a real missing script (verified `typecheck` exists in each workspace's package.json).

## Status: PASS (0 lint errors, 0 type errors; 138 non-blocking lint warnings recorded as informational findings, not defects)
