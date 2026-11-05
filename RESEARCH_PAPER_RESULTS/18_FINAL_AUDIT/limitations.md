# Testing Limitations

This campaign was explicitly scoped (by user decision) to a **narrow, real, verifiable slice** rather than the full 18-category, research-paper-grade A-Z testing framework originally requested. Everything below was deliberately out of scope for this pass, not silently skipped.

## Categories NOT covered in this pass
- **Security testing** (penetration testing, injection, auth/authz bypass, dependency vulnerability scanning, secret exposure audit). This is the largest gap — AssureCode handles payments (Razorpay), KYC data, and GitHub tokens, all of which warrant dedicated security review beyond what this pass covered.
- **Performance / load / stress / endurance / scalability testing.** `tools/benchmark.js` exists in the repo but was not executed.
- **UI / browser / accessibility testing.** No browser automation or screenshots were produced.
- **Research-grade experimentation** (Phase 6 of the original spec: baseline/ablation/comparative studies, statistical analysis of the matchmaking ML component). `tools/eval/matchmaking_eval.py` was not run; no precision/recall/F1/accuracy numbers were computed.
- **Python service testing.** `apps/ai-service` and `apps/scope-guard` are Python/FastAPI services with their own pytest suites (17 and 3 test files respectively, per `00_PROJECT_INVENTORY/test_coverage_inventory.csv`). Neither was executed — this requires verifying/activating their `.venv`s first, which was not done in this pass. The integration run used `--no-python`, which also skipped the one golden-path end-to-end test that exercises the full contract lifecycle.
- **Cryptographic validation.** The ledger's ML-DSA-87 signing path and Merkle/canonical-hash logic in `packages/ledger-client` were exercised only by their own existing unit tests, not independently validated against standard test vectors.
- **Dependency vulnerability scanning.** `npm audit` / `scripts/audit-check.mjs` was not run.
- **Destructive database/recovery testing.** No deliberate connection-failure, mid-transaction-crash (beyond the one existing settlement-crash-recovery test), or backup/restore testing was performed.
- **Observability validation.** otel-collector/Jaeger/Prometheus/Grafana were observed running in the user's pre-existing separate dev stack but were not independently validated (e.g. confirming traces/metrics actually populate dashboards).

## What WAS genuinely validated with real evidence
- Build (all 13 workspaces + web frontend) — PASS
- Static analysis (ESLint + TypeScript across all workspaces) — PASS, 0 errors
- Unit tests (13 workspaces, 2 runs: baseline and post-infra) — real pass/fail counts, 2 real defects found
- Integration tests against real Postgres/Redis/Neo4j/LocalStack (project's own `test:e2e` harness) — 594/604 tests passed, 2 real defects found and root-caused via git history, one CRITICAL
- Coverage (within the project's own defined `packages/*` scope) — 80.64% statements, thresholds met
- Protected-file integrity — confirmed unchanged byte-for-byte

## Honest assessment of risk this gap leaves unaddressed
The CRITICAL defect found (DEFECT-003, settlement oracle gate broken) demonstrates that even a narrow, infra-backed slice can surface release-blocking bugs that a no-infra or purely-static review would miss. Given that, the categories NOT covered here — especially security testing on a payments/KYC system, and the untested Python services — should be treated as open risk, not as "probably fine because the covered slice looked healthy."

## Side effect encountered and corrected during this campaign
Running `npm run test:e2e` regenerated the git-tracked `coverage-e2e/` directory and, because `--no-python` was used (skipping the one test that exercises some of those code paths), left several previously-committed `coverage-e2e/` report files deleted in the working tree. This was detected via `git status` before finishing and corrected with `git checkout -- coverage-e2e/` to restore the tracked files to their last-committed state — a reversible action that undid this run's own side effect, not a change to any source file. No commit was made.
