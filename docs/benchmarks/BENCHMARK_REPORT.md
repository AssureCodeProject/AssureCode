# AssureCode Benchmark Report

> Generated from `docs/benchmarks/benchmark_results.json` by `tools/analyze_benchmark.py`.
> Run at **2026-08-04T15:31:46.154Z** against **http://localhost:4000**.
> Sample: **50 contracts** at concurrency **2**.

Every number here comes from a real HTTP round trip against a running gateway.
`tools/benchmark.js` exits non-zero if the gateway is unreachable rather than
falling back to simulation, so an absent report means the run did not happen.

> **Redis was not configured for this run** (`readiness.redis = "not_configured"`), so the gateway used the in-process event bus. Every latency below therefore excludes network hops to a broker and understates a deployed configuration.

---

## 1. Run summary

| | |
|---|---|
| Contracts attempted | 50 |
| Contracts completed | 50 |
| Contracts with at least one error | 0 |
| Wall-clock duration | 48.41 s |
| Throughput | 1.03 contracts/sec |
| Gateway readiness at start | `status=ready` `db=ok` `redis=not_configured` |

Terminal status distribution:

- `DELIVERED` — 8 (16%)
- `SCOPE_BLOCKED` — 42 (84%)

---

## 2. Latency by phase

Four phases are timed: contract initialization, locking (which anchors the
ledger entry), escrow funding, and the RAG scope check. Test generation and
settlement are not driven by this harness and are reported as such rather than
filled in.

| Phase | Mean (ms) | p50 | p90 | p99 | Min | Max |
|---|---|---|---|---|---|---|
| **1. Initialization** | 729.16 | 742.89 | 790.69 | 859.79 | 165.79 | 859.79 |
| **2. Contract lock** | 227.29 | 164.7 | 178.57 | 1282.53 | 140.19 | 1282.53 |
| **3. Escrow funding** | 461.77 | 450 | 470.99 | 1072.39 | 421.65 | 1072.39 |
| **4. RAG scope check** | 494.14 | 490.16 | 516.34 | 555.59 | 458.45 | 555.59 |
| **5. Test generation** | not driven by this benchmark | | | | | |
| **6. Oracle settlement** | not driven by this benchmark | | | | | |

Sum of the four measured phases per contract: **1912.36 ms mean over 50 contracts**.

RAG ingest is fire-and-forget from the lock endpoint, so the benchmark waits for
the contract's chunks to become queryable before the scope check. 0
contract(s) needed a retry; that wait is tracked separately and excluded from the
scope-check figure.

---

## 3. Scope-guard accuracy

The benchmark sends one in-scope or one out-of-scope prompt per contract. The
label decides **which prompt is sent** and scores the answer — it never reaches
the service and never determines the verdict.

```
                       Actual in-scope      Actual out-of-scope
Allowed by guard          TP = 8               FP = 0   
Blocked by guard          FN = 32              TN = 10  
```

| Metric | Value |
|---|---|
| Contracts scored | 50 |
| Excluded (no verdict returned) | 0 |
| Accuracy | 36.00% |
| Precision | 100.00% |
| Recall | 20.00% |
| F1 | 33.33% |

### Reading this honestly

Precision of 100.00% with recall of 20.00%
is not a good result. It means the guard almost never allows an out-of-scope
request — and also blocks most in-scope ones. The similarity threshold
(`SCOPE_SIMILARITY_THRESHOLD`, calibrated at 0.2731) was selected on a 16-message
hand-labelled set and scored 14/16 **on that same set**, which is a fitting
figure. These numbers are what it does on messages it was not selected against,
and the gap between the two is the finding.

The failure direction is the safer one for a payment system — a false block
costs a scope amendment, a false allow releases work that was never contracted —
but it is still a failure, and the threshold does not generalize as selected.

---

## 4. What this benchmark does not establish

- **Ledger integrity.** Verified separately by `tools/verify_phase8_live.mjs`
  and the tamper tests in `apps/api-gateway/test/ledger-tamper.test.ts`, not here.
- **Settlement correctness.** Verified by `tools/verify_phase5_live.mjs`.
- **Freedom from races or deadlocks.** The earlier report asserted a count of
  zero; nothing in this harness detects either. Concurrency behaviour is covered
  by `apps/api-gateway/test/idempotency-concurrency.test.ts`.
- **Production latency.** Single machine, single uvicorn worker, and the event
  bus noted above.

---

*Regenerate with `node tools/benchmark.js && python tools/analyze_benchmark.py`.*
