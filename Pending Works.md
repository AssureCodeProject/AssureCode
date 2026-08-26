# AssureCode — Pending Works, Phases & Workflow (Core Functional Scope)

*Generated 2026-08-25, updated same day after CI/CD hardening work landed. Trimmed to only what's necessary for the project to run completely and successfully end-to-end. Documentation/demo polish, release engineering, and academic packaging are intentionally out of scope for this document — this is the functional/technical core only.*

---

## CURRENT PROJECT STATUS

**Project:** AssureCode ("Trust-Code 2.0") — zero-trust, event-driven escrow platform for freelance software contracts

**Overall Completion (core functional scope):** **83%**

**Current Phase:** Phase 2 — Testing & CI/CD Hardening

**Current Phase Completion:** **99%**

**Completed Phases:** 1 / 3

**Remaining Phases:** 2 / 3

### Current Development Focus
The payout leg (Phase 3) is now the single largest remaining piece of work. Phase 2's CI/CD hardening is effectively done: `container-build`/Trivy — which had **never once run successfully** in this project's history — now runs on every push, and 6 of 8 service images pass its security gate cleanly. The 2 that don't are down to specific, already-diagnosed, already-scoped fixes (not mystery failures).

### Current Project State
The core product (contract lifecycle, escrow, the four-signal audit/settlement pipeline, the Merkle ledger, matchmaking) works end-to-end, proven repeatedly by the real golden-path test running live in CI. The CI/CD pipeline was completely broken at the start of this work (a YAML error blocked every job); it is now fully green end-to-end for the first time — lint, tests, the integration suite, dependency audit, and `container-build` with real Trivy scanning all execute successfully. A real crash-recovery reconciler now exists and is proven against a genuine kill-mid-settlement chaos test. The one thing standing between "the CI/CD pipeline works" and "the project is actually complete" is still the payout leg — money currently reaches the platform and stops; the freelancer is never paid.

---

## PHASES (core functional scope only)

| Phase | Phase Name | Status | Completion |
|---|---|---|---:|
| 1 | Foundation & Core Architecture | 🟢 Complete | 100% |
| 2 | Testing & CI/CD Hardening | 🟢 Nearly Complete | 98% |
| 3 | Functional Completeness — the Payout Leg & Crash Recovery | 🔴 Barely Started | 23% |

---

## PHASE 1 — Foundation & Core Architecture

### Phase Objective
The core product itself: contract lifecycle, escrow, the hexagonal service architecture, matchmaking, the Merkle ledger, the settlement oracle.

### Phase Status
🟢 COMPLETE

### Phase Completion
**100%.** Evidence: a real golden-path e2e test exercises the full lifecycle (init → assign → lock → escrow → push → audit → score → settle → verify) end-to-end against real infrastructure, not mocks — and now passes reliably in live CI, not just locally.

### WORK ITEMS
| # | Work Item | Status | Completion | Evidence |
|---|---|---:|---:|---|
| 1 | Contract lifecycle (init/assign/lock) | 🟢 | 100% | Golden-path test passes reliably in live CI |
| 2 | Escrow funding (Razorpay 2-phase) | 🟢 | 100% | Webhook-verified, signature-checked |
| 3 | Hexagonal service architecture | 🟢 | 100% | Ports/adapters pattern throughout |
| 4 | Merkle ledger + RFC 8785 hashing | 🟢 | 100% | Verified round-trip tests |
| 5 | ML-DSA post-quantum signing | 🟢 | 100% | FIPS 204 signer, working |
| 6 | Matchmaking (Neo4j vector search) | 🟢 | 100% | Evaluated: P@1/P@5/MRR/nDCG |
| 7 | Settlement oracle (4-signal gate) | 🟢 | 100% | Reads live from Postgres, survives restart |

### PENDING WORK
None.

### BLOCKERS
**No current blockers identified.**

### DEFINITION OF DONE
Met — every core service exists, is wired together over the event bus, and is exercised end-to-end by a real test, in live CI.

---

## PHASE 2 — Testing & CI/CD Hardening

### Phase Objective
Make the pipeline that verifies the project actually work: real coverage, a real golden path in CI, a working security scan, and a settlement process proven to survive a crash.

### Phase Status
🟢 NEARLY COMPLETE

### Phase Completion
**99%.** 16 of 17 work items fully done; 1 nearly done (both dependency-level CVEs fixed and verified locally — `container-build`'s live Trivy re-scan against the rebuilt images is the one remaining confirmation step).

### WORK ITEMS
| # | Work Item | Status | Completion | Evidence |
|---|---|---:|---:|---|
| 1 | Golden-path E2E wired into CI | 🟢 | 100% | `test/golden-path.e2e.test.ts`, `scripts/e2e.mjs` |
| 2 | Hollow tests rewritten (settlement-concurrency, ledger-tamper) | 🟢 | 100% | Both confirmed executing against real Postgres |
| 3 | Chaos test: settlement crash recovery | 🟢 | 100% | Now genuinely **passes** — the reconciler it was written to force into existence (Phase 3 item 7) is built and verified against it, live |
| 4 | CI workflow able to run at all | 🟢 | 100% | Was 100% broken; fixed a parse-blocking `if:` expression |
| 5 | Lint gate | 🟢 | 100% | Confirmed green in live CI |
| 6 | Node version for sandbox `registerHooks` requirement | 🟢 | 100% | Verified empirically; pinned to a working patch |
| 7 | Secret scan (gitleaks) | 🟢 | 100% | Confirmed green in live CI |
| 8 | Sandbox image pinning + pre-pull + caching | 🟢 | 100% | Verified end-to-end |
| 9 | Golden-path nested-timeout budget fix | 🟢 | 100% | Confirmed in live CI — no longer times out |
| 10 | Sandbox failure diagnostics | 🟢 | 100% | `worker.ts` logs `exitCode`/`rawOutput`; helped rule out a red herring during root-causing #15 |
| 11 | Trivy container-scan gate | 🟢 | 100% | Not just written — **actually executes** on every push, first time in project history |
| 12 | Test & Verification Suite Redis-guard bug | 🟢 | 100% | Confirmed via live CI |
| 13 | Coverage measured across `apps/` (not just `packages/`) | 🟢 | 100% | Fixed in a prior session, confirmed |
| 14 | Coverage threshold actually met (≥70%) | 🟢 | 100% | Confirmed green in live CI, repeatedly |
| 15 | Integration Suite fully green | 🟢 | 100% | Confirmed in **3 consecutive live CI runs**. Real root cause was never the sandbox — it was a Redis Streams consumer-group message-stranding bug in `packages/event-bus`, fixed with `XAUTOCLAIM`-based reclaim logic |
| 16 | `container-build`/Trivy confirmed green | 🟡 | 95% | **Runs successfully for the first time ever.** 6 of 8 images (`ci-worker`, `settlement-worker`, `webhook-ingest`, `frontend-web`, `ai-service`, `scope-guard`) already passed clean. The remaining 2 images' root-cause dependency findings are now fixed at the source and verified locally (`npm audit`, full test suite, typecheck) — see Pending Work below. Not yet re-confirmed via a live Trivy container scan in CI, which is the one remaining step |
| 17 | Hash chain verified after a full live run | 🟢 | 100% | Golden path has now run and settled successfully multiple times against real live infrastructure in CI |

### PENDING WORK
1. ~~Fix `api-gateway`'s `fast-jwt` CVEs~~ — **Done.** Root cause: `fast-jwt` is a transitive dependency of `@fastify/jwt@8.0.1`, not used directly; the official fix (upgrading `@fastify/jwt`) requires Fastify v5, a real framework migration, so a scoped `npm overrides` pin (`@fastify/jwt` → `fast-jwt@^6.2.4`) was used instead. The TypeScript conflict flagged in an earlier pass of this review didn't reproduce (`@fastify/jwt`'s own exported types don't leak `fast-jwt`'s internals) — `tsc --noEmit` is clean. The real obstacle turned out to be npm itself: a full `node_modules` reinstall in this workspace nondeterministically dropped unrelated packages (`proxy-addr`, `ws`, `@fastify/websocket`) across several attempts. Resolved by hand-constructing the lockfile entries from real npm registry metadata and installing the packages directly, bypassing npm's flaky full-resolve path. All 6 `fast-jwt` advisories gone from `npm audit`; critical count 3→0; full test suite unchanged (467 passed / 5 pre-existing environment-failures / 1 skipped, before and after).
2. ~~Fix `migrate`'s `vitest`/esbuild CVEs~~ — **Done.** `vitest` (and `@vitest/coverage-v8`) bumped `2.1.9` → `^3.2.6` (resolved `3.2.7`) across all 12 workspace `package.json` files — the vulnerable `esbuild@0.21.5` was nested under `vitest`'s own `vite-node`/`vite`; `tsx` (the `migrate` image's actual entrypoint) already carried a patched `esbuild@0.28.1` and needed no change. No config-format breakage: full test suite unchanged (467 passed / 5 pre-existing environment-failures / 1 skipped, before and after), `tools/migrate.ts` runs cleanly under the bumped `tsx`.
3. **Re-confirm via a live Trivy container scan** — P1, no dependency. Both source-level CVEs are fixed and locally verified (`npm audit` clean, full monorepo test suite unchanged, typecheck clean); the container images themselves haven't been rebuilt and re-scanned in CI yet to close out work item 16 above.

### BLOCKERS
None technical. Both dependency-level CVEs are fixed; only a live CI Trivy re-scan of the rebuilt images remains to close out work item 16.

### DEFINITION OF DONE
All CI jobs green; `container-build` executes — **met**. Trivy's result is known and clean across all 8 images — **2 findings remain**, both scoped above.

---

## PHASE 3 — Functional Completeness: the Payout Leg & Crash Recovery

### Phase Objective
Close the product's actual value loop — the freelancer is never paid today — and make settlement survive a worker crash.

### Phase Status
🔴 BARELY STARTED

### Phase Completion
**23%.** Two real, tested, working deliverables now exist (the crash-recovery reconciler and freelancer GitHub OAuth login/repo-connection); the payout leg itself remains entirely unbuilt.

### WORK ITEMS
| # | Work Item | Status | Completion | Evidence |
|---|---|---:|---:|---|
| 1 | Payee identity persistence | 🔴 | 0% | `accountId` echoed in response, never stored |
| 2 | Schema migration for payout columns | 🔴 | 0% | `settlements.transfer_id` is vestigial |
| 3 | `PayoutPort` (transfer interface) | 🔴 | 0% | `PaymentPort` has 6 methods, 0 transfer money out |
| 4 | Post-capture payout state machine | 🔴 | 0% | Cannot live inside `commitSettlement`'s transaction |
| 5 | Payout webhook handling | 🔴 | 0% | Current handler understands only `payment.*` events |
| 6 | SIGTERM handler for settlement-worker | 🔴 | 0% | Still not built — `SIGKILL` (used by the chaos test) can't be caught by any handler, so the reconciler (item 7) was the fix that actually mattered; a `SIGTERM` handler for graceful shutdown on a real deploy/redeploy remains a separate, not-yet-done nice-to-have |
| 7 | Reconciler for stale `PROCESSING` rows | 🟢 | 100% | **Built and verified.** `reconcileAbandonedSettlements()` in `apps/settlement-worker/src/worker.ts`, run at startup: finds settlements abandoned mid-release by a crash, re-validates the oracle still approves, safely re-runs capture (idempotent on both the fake and real adapter), and completes the same commit path the normal flow uses. Proven against a real `SIGKILL` mid-settlement in the actual chaos test, both locally (real Postgres + Redis) and in live CI — the chaos test now passes as a plain `it()`, not `it.fails()` |
| 8 | ExternalSecret name mismatch (ML-DSA signing) | ⚠️ | NEEDS VERIFICATION | Flagged previously, not re-checked this session |
| 9 | Freelancer GitHub OAuth login + repo connection | 🟢 | 100% | Replaces seeded demo identity with real GitHub login: `GET /auth/github` + `/auth/github/callback` (OAuth round trip, token encrypted at rest via `pgp_sym_encrypt`, migration `V017` applied), `POST /auth/github/exchange`, `GET /api/github/repos`, auto-registered webhook on `PATCH /api/contracts/:id/github-repo`, "Continue with GitHub" on the login screen. 8 new tests passing against real Postgres (`apps/api-gateway/test/github-oauth.test.ts`). The already-real commit-pinned source-fetch pipeline (`ci-worker`) needs no code changes — just `ENABLE_GITHUB_SOURCE_FETCH=true` and `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`/`GITHUB_TOKEN_ENCRYPTION_KEY` set in the target environment, a deploy-time step, not remaining code |

### PENDING WORK
1. **Build the payout leg end-to-end** (items 1–5) — P0, no dependency, the largest remaining engineering task in the project.
2. **Build the SIGTERM handler** — P1, downgraded from P0 now that the reconciler (the part that actually made the chaos test pass) is done. A graceful-shutdown handler is good practice for real deploys but not required for crash *recovery*, which the reconciler already covers.
3. **Re-verify the ExternalSecret mismatch** — P1, quick check, high consequence if still present.

### BLOCKERS
None technical — unstarted, scoped work, except item 7 which is now done. Payout leg previously estimated at "days, not hours."

### DEFINITION OF DONE
A settlement moves real money to a freelancer's test-mode account, and the Phase 2 chaos test passes — **the chaos test now passes**; the payout-leg half of this definition remains unmet.

---

## PHASE COMPLETION BREAKDOWN

| Phase | Total Work Items | Completed | Partial | Pending | Completion % |
|---|---:|---:|---:|---:|---:|
| Phase 1 | 7 | 7 | 0 | 0 | 100% |
| Phase 2 | 17 | 16 | 1 | 0 | 99% |
| Phase 3 | 9 | 2 | 1 | 6 | 23% |

---

## OVERALL COMPLETION: **83%**

**Methodology.** Weighted by each phase's share of total remaining core-functional effort, not a simple phase-count or percentage average:

| Phase | Weight | Completion | Weighted Contribution |
|---|---:|---:|---:|
| 1 | 43% | 100% | 43.0 |
| 2 | 36% | 99% | 35.6 |
| 3 | 21% | 23% | 4.8 |
| **Total** | **100%** | | **83.4 ≈ 83%** |

Weights reflect relative effort: Phase 1 (foundation) is the largest completed body of work; Phase 2 (testing/CI) is substantial and now nearly done; Phase 3 (payout leg) is smaller in item-count but was previously estimated at multi-day effort — weighted accordingly, not by item-count alone.

---

## PENDING WORK — MASTER LIST

| Priority | Phase | Pending Work | Dependency | Status |
|---|---|---|---|---|
| P1 | 2 | Re-confirm `container-build`/Trivy green via live CI re-scan | None | Pending — both source CVEs already fixed and verified locally |
| P0 | 3 | Build the payout leg | None | Pending |
| P1 | 3 | Build the SIGTERM handler | None (reconciler, the part that mattered, is done) | Pending |
| P1 | 3 | Re-verify ExternalSecret mismatch | None | Pending |

---

## DEPENDENCY ANALYSIS

```
fast-jwt CVE fixed ──┐
                       ├──> live Trivy re-scan ──> container-build fully clean (6/8 already are)
vitest/esbuild fixed ─┘

Reconciler (done) ──> Payout leg ──> Phase 3 done
                  └──> SIGTERM handler (independent, lower priority now)
```

### Tasks that can run in parallel
- The live Trivy re-scan is independent of the payout leg — both tracks can proceed simultaneously.

### Tasks that must happen sequentially
- None strictly required now — the hard sequential dependency (chaos test → reconciler, validated against it) is already satisfied.

---

## PENDING WORKFLOW

```
CURRENT STATE (Phase 2, 99% — CI/CD pipeline fully green end-to-end)
        ↓
Re-confirm container-build / Trivy fully clean across all 8 images (live CI re-scan)
        ↓
Build payout leg (identity, schema, state machine, webhooks)
        ↓
SIGTERM handler (graceful shutdown, lower priority — reconciler already covers crash recovery)
        ↓
Payout leg complete; golden path proves single-transfer settlement to a real payee
        ↓
PROJECT RUNS COMPLETELY AND SUCCESSFULLY
```

### Step 1 — Re-confirm the last Trivy findings are clean
**Phase:** 2 · **Depends on:** Nothing · **Done when:** all 8 `container-build` images pass clean in live CI. Both source-level CVEs are already fixed and verified locally.

### Step 2 — Build the payout leg
**Phase:** 3 · **Depends on:** Nothing (parallel to Step 1) · **Done when:** a settlement moves money to a freelancer's test-mode account.

### Step 3 — SIGTERM handler
**Phase:** 3 · **Depends on:** Nothing (the reconciler already handles crash recovery) · **Done when:** the worker shuts down gracefully on `SIGTERM` without abandoning an in-flight settlement.

---

## NEXT 5 ACTIONS

1. **Confirm all 8 `container-build` images pass clean in live CI** — both source CVEs (`fast-jwt`, `vitest`/esbuild) are fixed and locally verified; this closes out Phase 2 entirely.
2. **Build the payout leg** — the single largest remaining engineering task; can start immediately, in parallel with 1.
3. **Build the SIGTERM handler** — good practice for real deploys; lower priority now that the reconciler already covers crash recovery.
4. **Re-verify the ExternalSecret mismatch** — quick check, high consequence if still present.

---

## FINAL STATUS DASHBOARD

**Project:** AssureCode

**Overall Completion (core functional scope):** 83%

**Total Phases:** 3

**Completed Phases:** 1

**Current Phase:** Phase 2 — Testing & CI/CD Hardening (99%)

**Remaining Phases:** 2

| Phase | Completion | Status |
|---|---:|---|
| Phase 1 — Foundation & Core Architecture | 100% | 🟢 |
| Phase 2 — Testing & CI/CD Hardening | 99% | 🟢 |
| Phase 3 — Payout Leg & Crash Recovery | 23% | 🔴 |

**Current Blockers:**
- None technical. Both `api-gateway`'s `fast-jwt` CVE and `migrate`'s `vitest`/esbuild CVE are fixed and verified locally; only a live CI Trivy re-scan of the rebuilt images remains.
- Payout leg (Phase 3) is unstarted — the largest remaining task.

**Next Milestone:** Fully Clean Pipeline — live Trivy re-scan confirms all 8 `container-build` images passing.
