# Reproduction Guide

Run these from the repository root, in order. All commands are read-only with respect to source code — none of them modify `apps/`, `packages/`, or any protected documentation file.

```bash
# Phase 0/1 — inventory (informational, produces files under RESEARCH_PAPER_RESULTS/00_PROJECT_INVENTORY/)
sha256sum ARCHITECTURE.md README.md CHANGELOG.md RUNBOOK.md DEMO.md AssureCode-Novelty.docx

# Phase 2 — build
npm run build        # builds the 13 npm-workspace packages via scripts/build-workspaces.mjs
npm run build:web    # builds the Vite frontend (apps/web)

# Phase 3 — static analysis
npm run lint          # ESLint, flat config (eslint.config.mjs)
(cd apps/api-gateway && npm run typecheck)   # tsc -p tsconfig.json --noEmit
# ...repeated per workspace with a `typecheck` script: apps/ci-worker, apps/settlement-worker,
# apps/webhook-ingest, packages/config, packages/email-adapter, packages/event-bus,
# packages/kyc-adapter, packages/ledger-client, packages/oracle, packages/razorpay-adapter,
# packages/shared, packages/telemetry

# Phase 4 — unit tests + coverage
npm test                # runs `test --if-present` in every workspace, no infra required
npm run test:coverage   # vitest run --coverage --config vitest.coverage.config.ts (packages/* scope)

# Phase 5 — integration/DB testing (brings up an isolated Docker stack, migrates, seeds, tests, tears down)
npm run test:e2e -- --no-python
# Equivalent manual steps performed by that script (infra/docker-compose.test.yml, project
# name "assurecode-e2e", disposable ports 55432/56379/57687/54566):
#   docker compose -p assurecode-e2e -f infra/docker-compose.test.yml up -d
#   (migrate + seed steps as implemented in scripts/e2e.mjs)
#   npx vitest run <integration test files>
#   docker compose -p assurecode-e2e -f infra/docker-compose.test.yml down -v
```

## Notes on reproducibility
- `npm run test:e2e -- --no-python` was used instead of the full `npm run test:e2e` because the Python app services (apps/ai-service, apps/scope-guard) require their own `.venv`, whose presence/state was not verified in this pass. The script itself detects a missing `.venv` and skips with a warning rather than failing hard — see `scripts/e2e.mjs`. Running the full suite with Python services and pytest would additionally require `apps/ai-service/.venv` and `apps/scope-guard/.venv` to exist with their dependencies installed.
- All commands are deterministic given the same `package-lock.json` and Docker image tags (pinned versions throughout `infra/docker-compose*.yml`, e.g. `neo4j:5.26-community`, `localstack/localstack:3.8`).
- No random seeds were needed in this pass — no stochastic experiments (e.g. ML evaluation, load generation) were executed. `tools/eval/matchmaking_eval.py` (referenced by `npm run verify`) was NOT run in this pass — see limitations.
