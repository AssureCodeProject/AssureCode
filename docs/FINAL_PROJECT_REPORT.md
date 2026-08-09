# AssureCode — Final Project Report

> **Repository**: `AssureCode` — Zero-Trust, Event-Driven Multi-Agent Freelance Ecosystem
> **Status**: all four architectural objectives implemented and verified by named
> commands. Measured results include weak ones, reported as such. §6 lists what
> is not done.

---

## Executive Summary

AssureCode automates and cryptographically anchors the software freelancing
lifecycle:

$$\text{Requirements} \xrightarrow{\text{NLP match}} \text{Contract lock} \xrightarrow{\text{Stripe escrow}} \text{CI sandbox audit} \xrightarrow{\text{Trust score}} \text{Oracle settlement}$$

Each stage is backed by running code and a verification harness. Where a
measurement came out poorly — the scope guard's held-out accuracy, the
matchmaker's behaviour on non-technical phrasing — the number is published
rather than replaced.

**A note on this report's history.** Earlier revisions claimed 100% scope
accuracy, sub-3ms matchmaking, a Topological Braid-Ledger, and a QR-NGC
consensus paradigm. Those numbers came from a benchmark harness that assigned
its predictions from the ground-truth labels and generated latencies with
`setTimeout`, and those mechanisms have been deleted. §5 records the correction.

---

## 1. System Architecture

```
                          ASSURECODE MONOREPO ARCHITECTURE

┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. Frontend (apps/web)                                                                      │
│    - React 18 SPA (Vite). 4 phases: Init -> Verification -> Trust Score -> Escrow           │
│    - Live endpoints only. No mock data modules; failures render as failures                 │
└──────────────────────────────┬──────────────────────────────────────────────────────────────┘
                               │ HTTP REST & WebSocket (/api/*)
                               v
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ 2. API Gateway (apps/api-gateway)                                                           │
│    - Fastify + Zod. Idempotency (10k TTL LRU + Postgres table)                              │
│    - CORS allow-list, Stripe webhook HMAC, real Redis TCP check on /readyz                  │
└────────┬──────────────────────┬───────────────────────┬──────────────────────┬──────────────┘
         v                      v                       v                      v
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│ 3. CI Worker       │ │ 4. AI Service      │ │ 5. Scope Guard     │ │ 6. Settlement      │
│  (apps/ci-worker)  │ │ (apps/ai-service)  │ │ (apps/scope-guard) │ │ (settlement-worker)│
│ - Docker sandbox   │ │ - Sentence-BERT    │ │ - RAG retrieval    │ │ - Oracle gate      │
│ - Babel AST parser │ │ - NLP matchmaker   │ │ - H0 anchoring     │ │ - Advisory lock    │
│ - OWASP dual-layer │ │ - Trust score      │ │ - Drift detector   │ │ - Stripe capture   │
└────────┬───────────┘ └────────┬───────────┘ └────────┬───────────┘ └────────┬───────────┘
         v                      v                      v                      v
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ 7. Shared Infrastructure (infra/ & packages/)                                               │
│    - PostgreSQL 17.6 + pgvector (RFC 8785 canonical hash chain, RFC 6962 Merkle tree,       │
│      HNSW RAG embeddings), TLS pinned to a bundled root CA                                  │
│    - Neo4j skill graph · EventBus (in-memory / Redis Streams) + transactional outbox        │
│    - FIPS 204 ML-DSA-87 signing of Merkle roots (packages/ledger-client/src/ml_dsa.py)      │
│    - packages/oracle — the single definition of the settlement gate                         │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Bug Remediation (historical — 22 / 22)

*Retained as a record of the original remediation pass. Several of these files
have since been substantially rewritten.*

| Bug ID | Severity | File / Subsystem | Root Cause & Applied Fix |
|--------|----------|------------------|---------------------------|
| **BUG-001** | CRITICAL | `api-gateway/server.ts` | Fastify reply bypass; confirmed `withIdempotency` handles `reply.send()` in all branches. |
| **BUG-002** | CRITICAL | `api-gateway/server.ts` | Stripe webhook published wrong event topic; corrected to `ESCROW_LOCKED`. |
| **BUG-003** | CRITICAL | `ci-worker/sandbox-runner.ts` | Hardcoded 5/5 pass replaced with real `npm test --json` execution and output parsing. |
| **BUG-004** | CRITICAL | `settlement-worker/worker.ts` | Oracle read a nested object path; fixed to flat `payload.x` with nested fallback. |
| **BUG-005** | CRITICAL | `ledger-client/index.ts` | `verifyChain` held a pool client during fallback `getChain()`; added `finally` release. |
| **BUG-006** | HIGH | `api-gateway/idempotency.ts` | Unbounded `Map` leaked memory; rewritten as a bounded 10,000-entry TTL LRU. |
| **BUG-007** | HIGH | `api-gateway/idempotency.ts` | 5s busy-wait blocked the event loop; replaced with `Promise.race([inflight, timeout])`. |
| **BUG-008** | HIGH | `api-gateway/server.ts` | Wildcard CORS on financial routes; replaced with an `ALLOWED_ORIGINS` allow-list. |
| **BUG-009** | HIGH | `api-gateway/server.ts` | `/readyz` returned 200 without checking Redis; added a real TCP `pingRedis()`. |
| **BUG-010** | HIGH | `api-gateway/server.ts` | WebSocket chat leaked bus listeners; `unsubscribe()` now called on `socket.close`. |
| **BUG-011** | HIGH | `web/EscrowSettlementView.jsx` | "Release Funds" was cosmetic; wired to `POST /api/contracts/:id/settle`. |
| **BUG-012** | HIGH | `web/XaiTrustScoreView.jsx` | Displayed static mock data; fetches the live score. |
| **BUG-013** | HIGH | `api-gateway/server.ts` | Missing Stripe key only warned in production; added a `process.exit(1)` guard. |
| **BUG-014** | HIGH | `api-gateway/server.ts` | Settlement idempotency window; protected by a single-fire `settlements` guard table. |
| **BUG-015** | MEDIUM | `web/VerificationDashboard.jsx` | WebSocket `onclose` read stale state; added a `useRef`. |
| **BUG-016** | MEDIUM | `web/VerificationDashboard.jsx` | `useCallback` deps recreated the callback mid-run; stabilized. |
| **BUG-017** | MEDIUM | `web/ContractInitialization.jsx` | Locked form ignored prop updates; added `useEffect` sync. |
| **BUG-018** | MEDIUM | `web/EscrowSettlementView.jsx` | Release amount hardcoded to `$2,500.00`; now from `contractData.budgetCents`. |
| **BUG-019** | MEDIUM | `ledger-client/index.ts` | `appendWithOutbox` swallowed stored-proc errors; added span exception logging. |
| **BUG-020** | MEDIUM | `ci-worker/worker.ts` | Mislabelled pipeline step; added a `totalTests > 0` guard. |
| **BUG-021** | LOW | `web/App.jsx` | Stale `localStorage` key on reset; added `localStorage.removeItem()`. |
| **BUG-022** | LOW | `web/ContractInitialization.jsx` | `generate-tests` called with an empty body; now passes title, requirements, framework. |

---

## 3. System Benchmark — `node tools/benchmark.js`

Real HTTP against running services. **The harness exits non-zero when the
gateway is unreachable**; it does not fall through to simulation.

| | |
|---|---|
| Contracts | 50 (concurrency 2) |
| Completed / with errors | 50 / 0 |
| Throughput | 1.03 contracts/sec |
| Initialization latency (mean / p99) | 729 ms / 860 ms |
| Contract lock | 227 ms / 1283 ms |
| Escrow funding | 462 ms / 1072 ms |
| RAG scope check | 494 ms / 556 ms |

**Scope-guard accuracy: 36%** — precision 100%, recall 20%, F1 33.33%
(TP 8, TN 10, FP 0, FN 32).

Perfect precision with collapsed recall means the guard almost never allows an
out-of-scope request and also blocks most in-scope ones. The threshold (0.2731)
was selected on a 16-message hand-labelled set, where it scores 14/16 — a
fitting figure, not a generalisation estimate. **It does not generalize.** The
classes genuinely overlap in the similarity range [0.324, 0.341], so no single
threshold separates them.

The failure direction is the safer one for a payment system — a false block
costs a scope amendment, a false allow releases uncontracted work — but it
remains a failure.

*Caveat: Redis was unavailable for this run, so the gateway used the in-process
event bus and these latencies understate a deployed configuration.*

Full report: `docs/benchmarks/BENCHMARK_REPORT.md`.

---

## 4. NLP Matchmaking — `tools/eval/matchmaking_eval.py`

$$\text{Score} = 0.50 \cdot \text{skill cosine} + 0.35 \cdot \text{trust} + 0.15 \cdot \text{history}$$

Evaluated with the real `all-MiniLM-L6-v2` embedder over 24 authored queries
across 8 domains. Queries are split by phrasing, because the split is the point:

| N = 1000 | P@1 | P@5 | MRR | nDCG@10 |
|---|---|---|---|---|
| client names the technologies | 0.750 | 0.837 | 0.854 | 0.829 |
| client describes the outcome only | 0.375 | 0.325 | 0.484 | 0.275 |

A keyword matcher can serve the first row. Only an embedding can serve the
second. **The gap between them is large, so the system is closer to a robust
keyword matcher than to a semantic one.**

Latency: 84.7 ms warm mean, 108.4 ms p95 at N = 1000. The first query of a
process additionally pays N sequential profile embeds, because `Matchmaker`
caches lazily.

**Weight ablation** over all 231 settings of the simplex: the shipped
(0.50, 0.35, 0.15) ranks **66 of 231**; the retrieval optimum is near
$w_1 = 0.95$. Trust and delivery count are properties of the freelancer, not the
query, so they can only reorder a domain match, never sharpen it. That is an
argument about retrieval — trust is in the score deliberately, because the
product ranks who should be hired. What the ablation shows is that the split has
never been measured against either goal.

**Qualitative smoke test** (`python tools/test-matchmaking.py`) passes 4 of 5
and exits non-zero. Scenario 3 ranks Priya Sharma above Sarah Jenkins even
though Sarah has the higher skill score (0.4021 vs 0.3728), because
$w_2 + w_3 = 0.50$ outweighs the gap. That failure is left in place: it is the
ablation's finding visible in a single readable case.

Full report: `docs/benchmarks/MATCHMAKING_REPORT.md`.

---

## 5. Correction: the withdrawn QR-NGC paradigm

Earlier revisions of this report described a **Quantum-Resilient
Neural-Geometric Consensus** protocol as "formulated, implemented, and
benchmarked". It has been withdrawn. See
[`NEXTGEN_RESEARCH_PARADIGM.md`](./NEXTGEN_RESEARCH_PARADIGM.md) for the full
retraction.

| Previously claimed | Now |
|---|---|
| Topological Braid-Ledger, Alexander-Conway invariants in $O(1)$, `704.20 µs` | **Deleted.** A knot invariant does not detect a modified database row. |
| Poincaré hyperbolic scope manifold, 0.02% distortion | **Demoted to a baseline.** It saturates on L2-normalized embeddings: a near-duplicate pair (cosine 0.94) sits at $d_H = 11.68$ while both published thresholds are below that, so every pair would classify as scope creep. |
| ML-DSA "zero-knowledge proofs" in `340.80 µs` via `quantum_lattice.py` | **Replaced with real signing.** The old code used no key material and accepted any self-consistent signature. Now `dilithium-py` ML-DSA-87 signs the Merkle root under a domain-separated context, and `verify_root` requires the caller to supply the expected public key. |
| Playwright video proof, `video.verified` oracle signal | **Deleted.** It returned `verified: true` and hashed a string, not a recording. |

What replaced them is described in
[`ASSURECODE_COMPLETE_TECHNICAL_SPECIFICATION.md`](./ASSURECODE_COMPLETE_TECHNICAL_SPECIFICATION.md)
§4.4–4.6 and §8.

---

## 6. Verification & what is not done

### Passing

| Command | Result |
|---|---|
| `npm test` | 120 passing, 2 skipped, 0 failing |
| `apps/ai-service` pytest | 63 passing |
| `apps/scope-guard` pytest | 29 passing |
| `pytest packages/ledger-client/test/test_ml_dsa.py` | 18 passing |
| `python tools/verify_phase4_live.py` | 18 / 18 |
| `node tools/verify_phase5_live.mjs` | 33 / 33 |
| `node tools/verify_phase8_live.mjs` | 29 / 29 |

```bash
node scripts/verify-web.js                    # web build
python tools/eval/matchmaking_eval.py         # N=100/1000 + ablation
node tools/benchmark.js                       # live contract flow
python tools/analyze_benchmark.py             # regenerates BENCHMARK_REPORT.md
python tools/verify_owasp_2025_cloudflare.py  # OWASP detection incl. clean negatives
python tools/verify_scope_guard_live.py
```

### Not done

1. **The drift detector is not calibrated.** The conformal guarantee needs a
   labelled in-scope residual set that this repository does not have. The
   endpoint returns 503 rather than substituting a default; test calibrations
   are flagged `calibration_is_synthetic` all the way into the ledger record.
   **No false-alarm rate is claimed.**
2. **The scope threshold does not generalize** (§3). Fixing it needs a larger
   labelled set, not a tuned constant.
3. **The dispute drawer is not implemented** and is labelled as such in the UI.
4. **17 legacy ledger rows** predate the canonicalization migration and are
   reported `unverifiable`, distinct from verified or failed.
5. **No comparison against a deployed system**, and no human study of whether
   flagged messages match user judgement.
6. **The matchmaking pool and queries are authored in-repo**, so §4 measures
   domain retrieval by the pipeline, not real hiring outcomes.

---

## Conclusion

All four architectural objectives are satisfied by running code, and every
number in this report is reproducible by a command listed above. The system's
two weakest measurements — scope-guard recall and matchmaking on non-technical
phrasing — are published here with the reasons they came out that way, because
a limitation that is stated can be argued about, and one that is discovered
cannot.
