# AssureCode — Pending Works, Phases & Workflow (Core Functional Scope)

*Generated 2026-08-25, updated same day after CI/CD hardening work landed. Trimmed to only what's necessary for the project to run completely and successfully end-to-end. Documentation/demo polish, release engineering, and academic packaging are intentionally out of scope for this document — this is the functional/technical core only.*

---

## CURRENT PROJECT STATUS

**Project:** AssureCode ("Trust-Code 2.0") — zero-trust, event-driven escrow platform for freelance software contracts

**Overall Completion (core functional scope):** **84%**

**Current Phase:** Phase 3 — Functional Completeness: the Payout Leg & Crash Recovery

**Current Phase Completion:** **23%**

**Completed Phases:** 2 / 3

**Remaining Phases:** 1 / 3

### Current Development Focus
The payout leg (Phase 3) is now the single largest remaining piece of work, and the only thing left in the entire core functional scope besides it. Phase 2's CI/CD hardening is **fully done**: `container-build`/Trivy — which had **never once run successfully** in this project's history — now runs on every push and all 8 service images pass its security gate cleanly, confirmed in live CI.

### Current Project State
The core product (contract lifecycle, escrow, the four-signal audit/settlement pipeline, the Merkle ledger, matchmaking) works end-to-end, proven repeatedly by the real golden-path test running live in CI. The CI/CD pipeline was completely broken at the start of this work (a YAML error blocked every job); it is now fully green end-to-end — lint, tests, the integration suite, dependency audit, and `container-build` with real Trivy scanning all execute successfully, across all 8 images. A real crash-recovery reconciler now exists and is proven against a genuine kill-mid-settlement chaos test. The one thing standing between "the CI/CD pipeline works" and "the project is actually complete" is now the payout leg alone — money currently reaches the platform and stops; the freelancer is never paid.

---

## PHASES (core functional scope only)

| Phase | Phase Name | Status | Completion |
|---|---|---|---:|
| 1 | Foundation & Core Architecture | 🟢 Complete | 100% |
| 2 | Testing & CI/CD Hardening | 🟢 Complete | 100% |
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
🟢 COMPLETE

### Phase Completion
**100%.** All 17 work items fully done — `container-build`/Trivy is now confirmed green in live CI across all 8 images.

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
| 16 | `container-build`/Trivy confirmed green | 🟢 | 100% | **All 8 images pass clean in live CI**, confirmed via GitHub Actions run — first time ever. `api-gateway`'s `fast-jwt` CVE and `migrate`'s `esbuild`/Go-stdlib CVE + OWASP-fixture secret false positive are both resolved; see evidence in Pending Work below |
| 17 | Hash chain verified after a full live run | 🟢 | 100% | Golden path has now run and settled successfully multiple times against real live infrastructure in CI |

### PENDING WORK
None. All items below are done, confirmed green in live CI (GitHub Actions run on `main`, all 8 `container-build` jobs `success`).

1. ~~Fix `api-gateway`'s `fast-jwt` CVEs~~ — **Done.** Root cause: `fast-jwt` is a transitive dependency of `@fastify/jwt@8.0.1`, not used directly; the official fix (upgrading `@fastify/jwt`) requires Fastify v5, a real framework migration, so a scoped `npm overrides` pin (`@fastify/jwt` → `fast-jwt@^6.2.4`) was used instead. The TypeScript conflict flagged in an earlier pass of this review didn't reproduce (`@fastify/jwt`'s own exported types don't leak `fast-jwt`'s internals). The real obstacle turned out to be npm itself: a full `node_modules` reinstall in this workspace nondeterministically dropped unrelated packages (`proxy-addr`, `ws`, `@fastify/websocket`) across several attempts. Resolved by hand-constructing the lockfile entries from real npm registry metadata and installing the packages directly, bypassing npm's flaky full-resolve path. All 6 `fast-jwt` advisories gone from `npm audit`; critical count 3→0.
2. ~~Fix `migrate`'s `vitest`/esbuild CVE~~ — **Done**, after two false starts worth recording. `vitest` was bumped `2.1.9` → `3.2.7`, but that alone didn't fix it: the CVE (CVE-2025-68121) lives in the *Go toolchain esbuild's binary was compiled with*, not in esbuild's npm version, so bumping vitest's own vite/esbuild chain wasn't sufficient. A first attempt at a blanket `npm overrides` pin on `esbuild` fixed `migrate` but **broke `apps/web`'s real production Vite build** (esbuild 0.28 changed how it down-levels destructuring for the app's configured legacy browser targets) — caught only via live CI, reverted. The actual fix stays scoped to the `migrate` image alone, since nothing in that image ever executes vite/esbuild (it only runs `tsx tools/migrate.ts`): `Dockerfile.migrate` now deletes the vulnerable `esbuild` copy (JS wrapper + its `@esbuild/<platform>` binary package) that `vite` pulls in as an unused devDependency, letting Node's resolution fall through to `tsx`'s own already-patched copy.
3. ~~Fix `migrate`'s OWASP-fixture secret false positive~~ — **Done.** `Dockerfile.migrate` copied the whole `tools/` directory, which also holds `verify_owasp_2025_cloudflare.py` — a scanner-accuracy test harness that deliberately embeds a realistic fake Stripe key as a detection fixture. Trivy's secret scanner correctly flagged it once it landed in a shipped image. Fixed by narrowing the `COPY` to exactly what `migrate.ts` imports (`tools/migrate.ts`, `tools/test-support/`, `tools/package.json`), and scoping `npm ci` to only the 3 workspaces `migrate.ts` actually needs (`packages/shared`, `packages/telemetry`, `packages/config`) — a smaller, more honest image, not just a scan-suppression.

### BLOCKERS
None. Phase 2 is fully closed out.

### DEFINITION OF DONE
Met in full. All CI jobs green; `container-build` executes and Trivy is clean across all 8 images, confirmed in a live GitHub Actions run.

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
| Phase 2 | 17 | 17 | 0 | 0 | 100% |
| Phase 3 | 9 | 2 | 1 | 6 | 23% |

---

## OVERALL COMPLETION: **84%**

**Methodology.** Weighted by each phase's share of total remaining core-functional effort, not a simple phase-count or percentage average:

| Phase | Weight | Completion | Weighted Contribution |
|---|---:|---:|---:|
| 1 | 43% | 100% | 43.0 |
| 2 | 36% | 100% | 36.0 |
| 3 | 21% | 23% | 4.8 |
| **Total** | **100%** | | **83.8 ≈ 84%** |

Weights reflect relative effort: Phase 1 (foundation) is the largest completed body of work; Phase 2 (testing/CI) is substantial and now fully done; Phase 3 (payout leg) is smaller in item-count but was previously estimated at multi-day effort — weighted accordingly, not by item-count alone.

---

## PENDING WORK — MASTER LIST

| Priority | Phase | Pending Work | Dependency | Status |
|---|---|---|---|---|
| P0 | 3 | Build the payout leg | None | Pending |
| P1 | 3 | Build the SIGTERM handler | None (reconciler, the part that mattered, is done) | Pending |
| P1 | 3 | Re-verify ExternalSecret mismatch | None | Pending |

---

## DEPENDENCY ANALYSIS

```
Phase 2 (CI/CD hardening) — DONE

Reconciler (done) ──> Payout leg ──> Phase 3 done
                  └──> SIGTERM handler (independent, lower priority now)
```

### Tasks that can run in parallel
- The payout leg and the SIGTERM handler are independent of each other.

### Tasks that must happen sequentially
- None — the hard sequential dependency (chaos test → reconciler, validated against it) is already satisfied.

---

## PENDING WORKFLOW

```
CURRENT STATE (Phase 2, 100% — CI/CD pipeline fully green end-to-end, confirmed in live CI)
        ↓
Build payout leg (identity, schema, state machine, webhooks)
        ↓
SIGTERM handler (graceful shutdown, lower priority — reconciler already covers crash recovery)
        ↓
Payout leg complete; golden path proves single-transfer settlement to a real payee
        ↓
PROJECT RUNS COMPLETELY AND SUCCESSFULLY
```

### Step 1 — Build the payout leg
**Phase:** 3 · **Depends on:** Nothing · **Done when:** a settlement moves money to a freelancer's test-mode account.

### Step 2 — SIGTERM handler
**Phase:** 3 · **Depends on:** Nothing (the reconciler already handles crash recovery) · **Done when:** the worker shuts down gracefully on `SIGTERM` without abandoning an in-flight settlement.

---

## NEXT 5 ACTIONS

1. **Build the payout leg** — the single largest remaining engineering task, and now the only thing standing between "CI/CD works" and "the project is complete."
2. **Build the SIGTERM handler** — good practice for real deploys; lower priority now that the reconciler already covers crash recovery.
3. **Re-verify the ExternalSecret mismatch** — quick check, high consequence if still present.

---

## FINAL STATUS DASHBOARD

**Project:** AssureCode

**Overall Completion (core functional scope):** 84%

**Total Phases:** 3

**Completed Phases:** 2

**Current Phase:** Phase 3 — Functional Completeness: the Payout Leg & Crash Recovery (23%)

**Remaining Phases:** 1

| Phase | Completion | Status |
|---|---:|---|
| Phase 1 — Foundation & Core Architecture | 100% | 🟢 |
| Phase 2 — Testing & CI/CD Hardening | 100% | 🟢 |
| Phase 3 — Payout Leg & Crash Recovery | 23% | 🔴 |

**Current Blockers:**
- None technical. Phase 2 (CI/CD hardening) is fully closed out, confirmed green in live CI.
- Payout leg (Phase 3) is unstarted — the largest, and now only, remaining task.

**Next Milestone:** Payout leg — a settlement moves real money to a freelancer's test-mode account.
