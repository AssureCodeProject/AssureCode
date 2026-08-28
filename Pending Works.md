# AssureCode — Pending Works, Phases & Workflow (Core Functional Scope)

*Generated 2026-08-25, updated same day after CI/CD hardening work landed. Trimmed to only what's necessary for the project to run completely and successfully end-to-end. Documentation/demo polish, release engineering, and academic packaging are intentionally out of scope for this document — this is the functional/technical core only.*

---

## CURRENT PROJECT STATUS

**Project:** AssureCode ("Trust-Code 2.0") — zero-trust, event-driven escrow platform for freelance software contracts

**Overall Completion (core functional scope):** **100%**

**Current Phase:** None — Phases 1, 2, and 3 are all code-complete

**Current Phase Completion:** **100%**

**Completed Phases:** 3 / 3

**Remaining Phases:** 0 / 3 (real-credential verification only — see Phase 3's Pending Work)

### Current Development Focus
The payout leg (Phase 3) is now built: identity persistence, schema, a `PayoutPort` (fake + real RazorpayX adapters), a post-capture payout state machine with idempotent crash recovery, payout webhook handling, and a SIGTERM handler for settlement-worker — all tested against real Postgres and the project's established fake-adapter pattern, all green in the full test suite. What remains is not engineering: a real RazorpayX account needs to be activated (a separate approval from plain Razorpay Payments, requiring the project owner's business/KYC on Razorpay's side) so the already-written real adapter can be proven against it.

### Current Project State
The core product (contract lifecycle, escrow, the four-signal audit/settlement pipeline, the Merkle ledger, matchmaking) works end-to-end, proven repeatedly by the real golden-path test running live in CI. The CI/CD pipeline is fully green end-to-end — lint, tests, the integration suite, dependency audit, and `container-build` with real Trivy scanning all execute successfully across all 8 images. A real crash-recovery reconciler exists and is proven against a genuine kill-mid-settlement chaos test. The payout leg now closes the product's value loop end-to-end against the fake adapter: a settlement release automatically attempts to pay the freelancer, retries safely on failure or crash via a deterministic idempotency key, and confirms via webhook. The only thing left before this moves real money is the project owner activating a live RazorpayX account.

---

## PHASES (core functional scope only)

| Phase | Phase Name | Status | Completion |
|---|---|---|---:|
| 1 | Foundation & Core Architecture | 🟢 Complete | 100% |
| 2 | Testing & CI/CD Hardening | 🟢 Complete | 100% |
| 3 | Functional Completeness — the Payout Leg & Crash Recovery | 🟢 Complete (code) | 100% |

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
🟢 COMPLETE (code) — real-credential verification remains, see Pending Work

### Phase Completion
**100%.** All ten work items are built, wired, and verified — the payout leg (items 1–6) closes the loop the reconciler and GitHub OAuth work (items 7, 9) had already started, and item 10 closes the retry-policy gap that was the last open product decision. Every path is proven against real Postgres and the project's established fake-adapter pattern; what remains is exercising the *real* RazorpayX adapter against live credentials, which is a deploy-time verification step, not unwritten code — the same shape of caveat item 9 already carries for `ENABLE_GITHUB_SOURCE_FETCH`.

### WORK ITEMS
| # | Work Item | Status | Completion | Evidence |
|---|---|---:|---:|---|
| 1 | Payee identity persistence | 🟢 | 100% | `POST /api/kyc/connect-onboarding` (`apps/api-gateway/src/server.ts`) now persists the KYC adapter's `accountId` to `users.payout_account_id` instead of only echoing it in the response |
| 2 | Schema migration for payout columns | 🟢 | 100% | `infra/migrations/postgres/V018__payout_leg.sql` — `users.payout_account_id`, `settlements.payout_status`/`payout_id`/`payout_failure_reason`/`payout_updated_at`, deliberately separate from the existing `status`/`transfer_id` so the capture-leg reconciler's `WHERE status='PROCESSING'` query is untouched. Applied and verified locally |
| 3 | `PayoutPort` (transfer interface) | 🟢 | 100% | New port + `FakePayoutAdapter` + `RazorpayXPayoutAdapter` + `createPayoutAdapter` factory in `packages/razorpay-adapter/src/index.ts`, mirroring `PaymentPort`'s existing fake/real selection pattern exactly. Idempotency-keyed (`payout_${contractId}`) by design — the hard requirement for safely retrying a payout without risking a double payment |
| 4 | Post-capture payout state machine | 🟢 | 100% | `attemptPayout()` in `apps/settlement-worker/src/worker.ts` — runs after `commitSettlement` returns and after `sealAndSignMerkleRoot`, deliberately outside `commitSettlement`'s transaction. `reconcilePendingPayouts()` sweeps `PENDING`/`FAILED`/`PROCESSING` payouts at startup and on a 5-minute interval, retrying with the same idempotency key so a lost-response crash resolves to RazorpayX's original record rather than a second transfer |
| 5 | Payout webhook handling | 🟢 | 100% | `POST /webhooks/razorpay` now branches on a payout entity *before* the existing escrow lookup (a payout webhook has neither `orderId` nor `paymentId` and would otherwise hit the route's existing early-return silently) — resolves via `settlements.payout_id`, updates `payout_status` on `payout.processed`/`payout.failed`/`payout.reversed` |
| 6 | SIGTERM handler for settlement-worker | 🟢 | 100% | `apps/settlement-worker/src/worker.ts` now has `process.on('SIGTERM'/'SIGINT', ...)`, matching the pattern already used by `api-gateway` and `ci-worker` — closes `dbPool`/`ledgerClient`, clears the new payout-reconcile interval. Settlement-worker was the one process in this money-moving path with no graceful shutdown at all before this |
| 7 | Reconciler for stale `PROCESSING` rows | 🟢 | 100% | **Built and verified.** `reconcileAbandonedSettlements()` in `apps/settlement-worker/src/worker.ts`, run at startup: finds settlements abandoned mid-release by a crash, re-validates the oracle still approves, safely re-runs capture (idempotent on both the fake and real adapter), and completes the same commit path the normal flow uses. Proven against a real `SIGKILL` mid-settlement in the actual chaos test, both locally (real Postgres + Redis) and in live CI — the chaos test now passes as a plain `it()`, not `it.fails()` |
| 8 | ExternalSecret name mismatch (ML-DSA signing) | 🟢 | 100% | **Re-verified and fixed.** The original framing was imprecise — Secret name, key name (`ML_DSA_SEED_HEX`), Deployment env injection, and the app's `os.environ` read were all already consistent. The real bug: the ledger-signing `ExternalSecret`'s `secretStoreRef.name` referenced `assurecode-secret-store`, a `SecretStore` that doesn't exist — the real one is named `assurecode-store`. Fixed in `infra/k8s/overlays/external-secrets/assurecode-external-secret.yaml:129` |
| 9 | Freelancer GitHub OAuth login + repo connection | 🟢 | 100% | Replaces seeded demo identity with real GitHub login: `GET /auth/github` + `/auth/github/callback` (OAuth round trip, token encrypted at rest via `pgp_sym_encrypt`, migration `V017` applied), `POST /auth/github/exchange`, `GET /api/github/repos`, auto-registered webhook on `PATCH /api/contracts/:id/github-repo`, "Continue with GitHub" on the login screen. 8 new tests passing against real Postgres (`apps/api-gateway/test/github-oauth.test.ts`). The already-real commit-pinned source-fetch pipeline (`ci-worker`) needs no code changes — just `ENABLE_GITHUB_SOURCE_FETCH=true` and `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`/`GITHUB_TOKEN_ENCRYPTION_KEY` set in the target environment, a deploy-time step, not remaining code |
| 10 | Payout failure/retry policy | 🟢 | 100% | **Done.** `reconcilePendingPayouts()` now caps retries at `PAYOUT_MAX_ATTEMPTS` (5, ~25 minutes at the 5-minute sweep interval) and transitions an exhausted row to a new terminal `FAILED_TERMINAL` payout_status distinct from plain `FAILED`, so it stops being picked up by the sweep. Migration `V019__payout_retry_cap.sql` adds `settlements.payout_attempts` and widens the status CHECK constraint. Verified with 2 new tests in `apps/settlement-worker/test/payout-leg.test.ts` (cap trips at the threshold; a row below the cap still retries normally) against real Postgres |

### PENDING WORK
1. ~~A real RazorpayX account with Payouts enabled~~ — **Done.** Activated in test mode (no KYC needed for sandbox): live `rzp_test_...` key, `RAZORPAYX_ACCOUNT_NUMBER` set, a real Fund Account (`fa_TUrp3JnX0Kvfw0`) created and funded with test balance.
2. ~~Confirm the exact real API contract~~ — **Done, empirically.** Beyond the earlier doc-verified fixes (`X-Payout-Idempotency` header, `payout.rejected`/`reversed` webhook mapping), this has now been confirmed against Razorpay's real sandbox API directly: `RazorpayXPayoutAdapter.initiatePayout`/`fetchPayout` called for real (`pout_TVFDux9uN3FxNp`, ₹1 test payout), a real webhook delivered to a live `ngrok` tunnel, signature verification passed, and `"type":"payout.processed"` logged as `"Razorpay webhook verified"` in `api-gateway`. `toPayoutResult()` and the `PayoutStatus` union both match the real response/webhook shape — no code changes were needed.
3. ~~A product decision on payout failure policy~~ — **Done.** See work item 10 above.

### BLOCKERS
None. All code is built, wired, and passing the full test suite (467+ tests across the monorepo, including 6 payout-leg tests and 4 payout-webhook tests), and the real RazorpayX payout + webhook path is now empirically verified end-to-end in test mode — not just against the fake adapter.

### DEFINITION OF DONE
Code-complete and now empirically verified: a real test-mode payout runs through `RazorpayXPayoutAdapter` against Razorpay's live sandbox API, and a real signed webhook is received, verified, and parsed correctly by `apps/api-gateway`. The fake-adapter path (PENDING → PROCESSING → COMPLETED, idempotent retries, webhook confirmation) and the Phase 2 chaos test still pass unchanged. Remaining before a real production launch: live (non-test) credentials, which need the project owner's real KYC/business activation on Razorpay's side — a deploy-time step, not unwritten engineering.

---

## PHASE COMPLETION BREAKDOWN

| Phase | Total Work Items | Completed | Partial | Pending | Completion % |
|---|---:|---:|---:|---:|---:|
| Phase 1 | 7 | 7 | 0 | 0 | 100% |
| Phase 2 | 17 | 17 | 0 | 0 | 100% |
| Phase 3 | 10 | 10 | 0 | 0 | 100% |

---

## OVERALL COMPLETION: **100%**

**Methodology.** Weighted by each phase's share of total remaining core-functional effort, not a simple phase-count or percentage average:

| Phase | Weight | Completion | Weighted Contribution |
|---|---:|---:|---:|
| 1 | 43% | 100% | 43.0 |
| 2 | 36% | 100% | 36.0 |
| 3 | 21% | 100% | 21.0 |
| **Total** | **100%** | | **100.0 ≈ 100%** |

All core-functional work is code-complete and verified against the project's established fake-adapter pattern. What remains is exercising the real RazorpayX adapter against live credentials — a deploy-time verification step, not unwritten engineering — see Phase 3's Pending Work.

---

## PENDING WORK — MASTER LIST

| Priority | Phase | Pending Work | Dependency | Status |
|---|---|---|---|---|
| ~~P1~~ | 3 | ~~Verify the real `RazorpayXPayoutAdapter` against a live RazorpayX account~~ | — | **Done** — verified against RazorpayX test-mode sandbox (`pout_TVFDux9uN3FxNp`) |
| ~~P2~~ | 3 | ~~Trigger one real payout to confirm the API contract empirically~~ | — | **Done** — real payout + real signed webhook (`payout.processed`) verified end-to-end through `api-gateway` |
| ~~P2~~ | 3 | ~~Decide payout failure/retry policy (cap, alert, manual retry)~~ | — | **Done** — see work item 10 above |

---

## DEPENDENCY ANALYSIS

```
Phase 1 (foundation) — DONE
Phase 2 (CI/CD hardening) — DONE
Phase 3 (payout leg, code) — DONE
Real RazorpayX test-mode verification — DONE

Live (non-test) RazorpayX credentials, real KYC (needs the project owner) ──> production launch
```

### Tasks that can run in parallel
- N/A — the payout-leg engineering and its real-API verification are both complete. What remains (live credentials) is a single deploy-time dependency on the project owner, not further engineering.

### Tasks that must happen sequentially
- None — every hard sequential dependency this project had (chaos test → reconciler, capture → payout) is already satisfied and verified.

---

## PENDING WORKFLOW

```
CURRENT STATE (Phases 1-3 code-complete, 100% — full test suite green, CI/CD fully green end-to-end)
        ↓
Real RazorpayX test-mode Payouts activated, verified end-to-end (payout + signed webhook) — DONE
        ↓
Payout failure/retry policy decided and implemented — DONE
        ↓
Project owner activates live (non-test) RazorpayX credentials + real business KYC
        ↓
PROJECT RUNS COMPLETELY AND SUCCESSFULLY, WITH REAL MONEY
```

### Step 1 — Activate and verify real RazorpayX Payouts
**Phase:** 3 · **Status:** Done. A real test-mode payout (`pout_TVFDux9uN3FxNp`) was created through `RazorpayXPayoutAdapter` against RazorpayX's sandbox API, marked `Processed` on the dashboard, and the resulting signed webhook was delivered to a live `ngrok` tunnel and verified end-to-end by `apps/api-gateway` (`"Razorpay webhook verified"`, `type: payout.processed`). Only live (non-test) credentials remain, gated on the project owner's real KYC.

---

## NEXT 5 ACTIONS

1. ~~Activate RazorpayX Payouts~~ — **Done**, test-mode sandbox.
2. ~~Verify the real API contract~~ — **Done**, empirically, real payout + real webhook.
3. ~~Decide the payout failure/retry policy~~ — **Done**.
4. Obtain live (non-test) RazorpayX credentials — needs the project owner's real business KYC before any real production payout can run.

---

## FINAL STATUS DASHBOARD

**Project:** AssureCode

**Overall Completion (core functional scope):** 100%

**Total Phases:** 3

**Completed Phases:** 3

**Current Phase:** None — all three phases are code-complete

**Remaining Phases:** 0 (live production credentials only, see Pending Work)

| Phase | Completion | Status |
|---|---:|---|
| Phase 1 — Foundation & Core Architecture | 100% | 🟢 |
| Phase 2 — Testing & CI/CD Hardening | 100% | 🟢 |
| Phase 3 — Payout Leg & Crash Recovery | 100% | 🟢 (real RazorpayX test-mode payout + webhook verified end-to-end) |

**Current Blockers:**
- None technical. All code is built, tested, passing in live CI, and empirically verified against RazorpayX's real sandbox API.
- Real-*production* money movement needs the project owner's live (non-test) Razorpay credentials and business KYC — not further engineering.

**Next Milestone:** Live (non-test) RazorpayX credentials activated for production launch.
