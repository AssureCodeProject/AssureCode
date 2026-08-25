# AssureCode — Pending Works, Phases & Workflow (Core Functional Scope)

*Generated 2026-08-25, trimmed to only what's necessary for the project to run completely and successfully end-to-end. Documentation/demo polish, release engineering, and academic packaging are intentionally out of scope for this document — this is the functional/technical core only.*

---

## CURRENT PROJECT STATUS

**Project:** AssureCode ("Trust-Code 2.0") — zero-trust, event-driven escrow platform for freelance software contracts

**Overall Completion (core functional scope):** **71%**

**Current Phase:** Phase 2 — Testing & CI/CD Hardening

**Current Phase Completion:** **75%**

**Completed Phases:** 1 / 3

**Remaining Phases:** 2 / 3

### Current Development Focus
Getting the CI/CD pipeline to go fully green so `container-build`/Trivy — which has **never once run successfully** in this project's history — can finally execute. Two specific, already-diagnosed bugs are blocking it.

### Current Project State
The core product (contract lifecycle, escrow, the four-signal audit/settlement pipeline, the Merkle ledger, matchmaking) works end-to-end, proven by a real golden-path test. The CI/CD pipeline was completely broken at the start of this session (a YAML error blocked every job) and has been rebuilt to the point where 2 of 4 blocking gates pass in live CI, with two remaining, well-understood failures. The one thing standing between "the project runs" and "the project is actually complete" is the payout leg — money currently reaches the platform and stops; the freelancer is never paid.

---

## PHASES (core functional scope only)

| Phase | Phase Name | Status | Completion |
|---|---|---|---:|
| 1 | Foundation & Core Architecture | 🟢 Complete | 100% |
| 2 | Testing & CI/CD Hardening | 🟡 In Progress | 75% |
| 3 | Functional Completeness — the Payout Leg & Crash Recovery | 🔴 Not Started | 5% |

---

## PHASE 1 — Foundation & Core Architecture

### Phase Objective
The core product itself: contract lifecycle, escrow, the hexagonal service architecture, matchmaking, the Merkle ledger, the settlement oracle.

### Phase Status
🟢 COMPLETE

### Phase Completion
**100%.** Evidence: a real golden-path e2e test exercises the full lifecycle (init → assign → lock → escrow → push → audit → score → settle → verify) end-to-end against real infrastructure, not mocks.

### WORK ITEMS
| # | Work Item | Status | Completion | Evidence |
|---|---|---|---:|---|
| 1 | Contract lifecycle (init/assign/lock) | 🟢 | 100% | Golden-path test passes reliably |
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
Met — every core service exists, is wired together over the event bus, and is exercised end-to-end by a real test.

---

## PHASE 2 — Testing & CI/CD Hardening

### Phase Objective
Make the pipeline that verifies the project actually work: real coverage, a real golden path in CI, a working security scan, and a settlement process proven to survive a crash.

### Phase Status
🟡 IN PROGRESS

### Phase Completion
**75%.** 13 of 17 work items fully done; 2 partially done; 2 blocked.

### WORK ITEMS
| # | Work Item | Status | Completion | Evidence |
|---|---|---:|---:|---|
| 1 | Golden-path E2E wired into CI | 🟢 | 100% | `test/golden-path.e2e.test.ts`, `scripts/e2e.mjs` |
| 2 | Hollow tests rewritten (settlement-concurrency, ledger-tamper) | 🟢 | 100% | Both confirmed executing against real Postgres |
| 3 | Chaos test: settlement crash recovery | 🟢 | 100% | Deterministic (Postgres row lock); correctly **fails**, proving Phase 3's defect is real |
| 4 | CI workflow able to run at all | 🟢 | 100% | Was 100% broken; fixed a parse-blocking `if:` expression |
| 5 | Lint gate | 🟢 | 100% | Confirmed green in live CI |
| 6 | Node version for sandbox `registerHooks` requirement | 🟢 | 100% | Verified empirically; pinned to a working patch |
| 7 | Secret scan (gitleaks) | 🟢 | 100% | Confirmed green in live CI |
| 8 | Sandbox image pinning + pre-pull + caching | 🟢 | 100% | Verified end-to-end |
| 9 | Golden-path nested-timeout budget fix | 🟢 | 100% | Confirmed in live CI — no longer times out |
| 10 | Sandbox failure diagnostics | 🟢 | 100% | `worker.ts` now logs `exitCode`/`rawOutput`; already surfaced new evidence |
| 11 | Trivy container-scan gate written | 🟢 | 100% | Step exists in workflow |
| 12 | Test & Verification Suite Redis-guard bug | 🟢 | 100% | Confirmed via live CI (223/224 tests pass) |
| 13 | Coverage measured across `apps/` (not just `packages/`) | 🟢 | 100% | Fixed in a prior session, confirmed |
| 14 | Coverage threshold actually met (≥70%) | 🔴 | 0% | **Live CI: 64.84%, below gate** — ⚠️ NEEDS VERIFICATION whether real regression or previously-wrong number |
| 15 | Integration Suite fully green | 🔴 | 0% | **Live CI: sandbox `exitCode: 1`, `rawOutput: ""`** for the real golden-path contract |
| 16 | `container-build`/Trivy confirmed green | 🔴 | 0% | Has **never once run successfully** — blocked on #14 and #15 |
| 17 | Hash chain verified after a full live run | 🟡 | 50% | Implementation sound, never executed against a fully live stack — ⚠️ NEEDS VERIFICATION |

### PENDING WORK
1. **Fix the coverage-threshold gap** (64.84% vs. 70%) — P0, no dependency.
2. **Diagnose the Docker sandbox's silent `exitCode: 1` / empty output** for the real golden-path contract — P0, no dependency (diagnostics already in place).
3. **Get `container-build`/Trivy to run** — P0, depends on #1 and #2.
4. **Verify the hash-chain-under-live-run claim** — P1, depends on the stack being fully up.

### BLOCKERS
Items #14 and #15 each independently block item #16.

### DEFINITION OF DONE
All CI jobs green; `container-build` executes; Trivy's result is known.

---

## PHASE 3 — Functional Completeness: the Payout Leg & Crash Recovery

### Phase Objective
Close the product's actual value loop — the freelancer is never paid today — and make settlement survive a worker crash.

### Phase Status
🔴 NOT STARTED

### Phase Completion
**5%.** Only diagnostic scaffolding exists (the chaos test proving the crash-recovery gap); zero payout code exists anywhere.

### WORK ITEMS
| # | Work Item | Status | Completion | Evidence |
|---|---|---:|---:|---|
| 1 | Payee identity persistence | 🔴 | 0% | `accountId` echoed in response, never stored |
| 2 | Schema migration for payout columns | 🔴 | 0% | `settlements.transfer_id` is vestigial |
| 3 | `PayoutPort` (transfer interface) | 🔴 | 0% | `PaymentPort` has 6 methods, 0 transfer money out |
| 4 | Post-capture payout state machine | 🔴 | 0% | Cannot live inside `commitSettlement`'s transaction |
| 5 | Payout webhook handling | 🔴 | 0% | Current handler understands only `payment.*` events |
| 6 | SIGTERM handler for settlement-worker | 🔴 | 0% | Confirmed: zero `SIGTERM` references |
| 7 | Reconciler for stale `PROCESSING` rows | 🔴 | 0% | `claimSettlement` only re-claims `FAILED` |
| 8 | ExternalSecret name mismatch (ML-DSA signing) | ⚠️ | NEEDS VERIFICATION | Flagged previously, not re-checked |

### PENDING WORK
1. **Build the payout leg end-to-end** (items 1–5) — P0, no dependency, the largest remaining engineering task in the project.
2. **Build the SIGTERM handler + reconciler** — P0, should land *after* the chaos test (already true), validated against it.
3. **Re-verify the ExternalSecret mismatch** — P1, quick check, high consequence if still present.

### BLOCKERS
None technical — unstarted, scoped work. Previously estimated at "days, not hours."

### DEFINITION OF DONE
A settlement moves real money to a freelancer's test-mode account, and the Phase 2 chaos test passes.

---

## PHASE COMPLETION BREAKDOWN

| Phase | Total Work Items | Completed | Partial | Pending | Completion % |
|---|---:|---:|---:|---:|---:|
| Phase 1 | 7 | 7 | 0 | 0 | 100% |
| Phase 2 | 17 | 13 | 2 | 2 | 75% |
| Phase 3 | 8 | 0 | 1 | 7 | 5% |

---

## OVERALL COMPLETION: **71%**

**Methodology.** Weighted by each phase's share of total remaining core-functional effort, not a simple phase-count or percentage average:

| Phase | Weight | Completion | Weighted Contribution |
|---|---:|---:|---:|
| 1 | 43% | 100% | 43.0 |
| 2 | 36% | 75% | 27.0 |
| 3 | 21% | 5% | 1.05 |
| **Total** | **100%** | | **71.05 ≈ 71%** |

Weights reflect relative effort: Phase 1 (foundation) is the largest completed body of work; Phase 2 (testing/CI) is substantial and mostly done; Phase 3 (payout leg) is smaller in item-count but was previously estimated at multi-day effort — weighted accordingly, not by item-count alone.

---

## PENDING WORK — MASTER LIST

| Priority | Phase | Pending Work | Dependency | Status |
|---|---|---|---|---|
| P0 | 2 | Fix coverage-threshold gap (64.84% vs 70%) | None | Pending |
| P0 | 2 | Diagnose Docker sandbox `exitCode:1`/empty output | None | Pending |
| P0 | 2 | Get `container-build`/Trivy to run | Above two | Pending |
| P0 | 3 | Build the payout leg | None | Pending |
| P0 | 3 | SIGTERM handler + reconciler | Phase 2 chaos test (done) | Pending |
| P1 | 2 | Verify hash-chain-under-live-run claim | Stack fully up | Pending |
| P1 | 3 | Re-verify ExternalSecret mismatch | None | Pending |

---

## DEPENDENCY ANALYSIS

```
Fix coverage gap ──┐
                    ├──> container-build runs ──> Trivy result known
Diagnose sandbox ───┘

Chaos test (done) ──> SIGTERM handler + reconciler ──> Payout leg complete ──> Phase 3 done
```

### Tasks that can run in parallel
- Fixing the coverage gap and diagnosing the sandbox bug are independent of each other.
- The entire payout leg (Phase 3) is independent of Phase 2's remaining CI fixes — both tracks can proceed simultaneously.

### Tasks that must happen sequentially
- Coverage fix + sandbox fix → `container-build` → Trivy result: each needs the prior step's outcome.
- Chaos test → SIGTERM handler/reconciler: the fix must be validated against the already-failing test, not written first.

---

## PENDING WORKFLOW

```
CURRENT STATE (Phase 2, 75%)
        ↓
Fix coverage-threshold gap
        ↓
Diagnose & fix Docker sandbox exit-1/empty-output
        ↓
container-build / Trivy runs for the first time
        ↓
Build payout leg (identity, schema, state machine, webhooks)
        ↓
SIGTERM handler + reconciler (validated against the chaos test)
        ↓
Chaos test passes; golden path proves single-transfer settlement
        ↓
PROJECT RUNS COMPLETELY AND SUCCESSFULLY
```

### Step 1 — Fix coverage-threshold gap
**Phase:** 2 · **Depends on:** Nothing · **Done when:** `Enforce Coverage Thresholds` passes in live CI.

### Step 2 — Diagnose & fix Docker sandbox exit-1/empty-output
**Phase:** 2 · **Depends on:** Nothing (diagnostics already in place) · **Done when:** `Integration Suite` passes in live CI.

### Step 3 — `container-build`/Trivy runs
**Phase:** 2 · **Depends on:** Steps 1–2 · **Done when:** the job completes and its result is known.

### Step 4 — Build the payout leg
**Phase:** 3 · **Depends on:** Nothing (parallel to Steps 1–3) · **Done when:** a settlement moves money to a freelancer's test-mode account.

### Step 5 — SIGTERM handler + reconciler
**Phase:** 3 · **Depends on:** The chaos test (done) · **Done when:** the chaos test passes.

---

## NEXT 5 ACTIONS

1. **Fix the coverage-threshold gap** — blocks `container-build`; a hard, verifiable fix; no dependency.
2. **Diagnose the Docker sandbox `exitCode: 1` / empty-output bug** — the second and last blocker to `container-build`.
3. **Push and confirm `container-build`/Trivy runs** — depends on 1 and 2; answers a question that's been open all session.
4. **Build the payout leg** — the single largest remaining engineering task; can start immediately, in parallel with 1–3.
5. **Build the SIGTERM handler + reconciler** — validated against the existing chaos test; needed for the project to be considered functionally complete.

---

## FINAL STATUS DASHBOARD

**Project:** AssureCode

**Overall Completion (core functional scope):** 71%

**Total Phases:** 3

**Completed Phases:** 1

**Current Phase:** Phase 2 — Testing & CI/CD Hardening (75%)

**Remaining Phases:** 2

| Phase | Completion | Status |
|---|---:|---|
| Phase 1 — Foundation & Core Architecture | 100% | 🟢 |
| Phase 2 — Testing & CI/CD Hardening | 75% | 🟡 |
| Phase 3 — Payout Leg & Crash Recovery | 5% | 🔴 |

**Current Blockers:**
- Coverage-threshold gap (64.84% vs. 70%)
- Docker sandbox `exitCode: 1` / empty-output bug

**Next Milestone:** First Green Pipeline — both CI blockers fixed, `container-build`/Trivy runs successfully for the first time.
