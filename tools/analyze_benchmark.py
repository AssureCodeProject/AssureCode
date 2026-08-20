#!/usr/bin/env python3
"""Turn docs/benchmarks/benchmark_results.json into BENCHMARK_REPORT.md.

Rewritten against the schema `tools/benchmark.js` actually emits. The previous
version read a schema no longer produced (`totalE2eLatencyMs`, `testGenLatencyMs`,
`settleLatencyMs`, `throughputRps`, `successfulContracts`) and would now die on a
KeyError — which meant the committed report still carried the numbers from the
simulated benchmark: 100% accuracy, 100% precision, 100% recall, 364 ms p50.
Those came from a harness that assigned the prediction from the ground-truth
label and produced every latency with setTimeout.

This version reports only what the run measured, and says so where it did not
measure something. In particular the old report asserted "Ledger Integrity:
100% compliant" and "Deadlock / Race Condition Count: 0"; the benchmark tests
neither, so neither appears here.
"""

import json
import sys
from pathlib import Path

REQUIRED_KEYS = ("latencyMs", "scopeAccuracy", "results", "readiness")


def pct(x: float) -> str:
    return f"{x:.2f}%"


def phase_row(label: str, s: dict | None) -> str:
    if not s or not s.get("n"):
        return f"| **{label}** | not measured | | | | | |"
    return (
        f"| **{label}** | {s['mean']} | {s['p50']} | {s['p90']} | {s['p99']} | "
        f"{s['min']} | {s['max']} |"
    )


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    results_file = root / "docs" / "benchmarks" / "benchmark_results.json"
    report_file = root / "docs" / "benchmarks" / "BENCHMARK_REPORT.md"

    if not results_file.exists():
        print(f"Error: {results_file} not found. Run `node tools/benchmark.js` first.")
        return 1

    data = json.loads(results_file.read_text(encoding="utf-8"))

    missing = [k for k in REQUIRED_KEYS if k not in data]
    if missing:
        print(
            f"Error: {results_file} is missing {missing}. This analyzer expects the "
            "schema emitted by the current tools/benchmark.js. Re-run the benchmark "
            "rather than editing this file to match an older result set."
        )
        return 1

    lat = data["latencyMs"]
    acc = data["scopeAccuracy"]
    ready = data["readiness"]
    results = data["results"]
    total = data.get("totalContracts", len(results))

    tp = acc.get("truePositives", 0)
    tn = acc.get("trueNegatives", 0)
    fp = acc.get("falsePositives", 0)
    fn = acc.get("falseNegatives", 0)
    scored = acc.get("scoredContracts", 0)
    excluded = acc.get("excludedNoVerdict", 0)

    with_errors = data.get("withErrors", 0)
    completed = data.get("completed", 0)
    status_counts = data.get("statusCounts", {})
    status_lines = "\n".join(
        f"- `{k}` — {v} ({v / total * 100:.0f}%)" for k, v in sorted(status_counts.items())
    ) or "- none recorded"

    # Per-contract wall time across the phases this benchmark actually times.
    e2e = []
    for r in results:
        ph = r.get("phases", {})
        vals = [ph.get(k) for k in ("initialize", "lock", "escrow", "scopeCheck")]
        if all(isinstance(v, (int, float)) for v in vals):
            e2e.append(sum(vals))
    e2e_line = (
        f"{sum(e2e) / len(e2e):.2f} ms mean over {len(e2e)} contracts"
        if e2e else "not computable — some contracts did not reach every phase"
    )

    redis_note = (
        "\n> **Redis was not configured for this run** (`readiness.redis = "
        f"\"{ready.get('redis')}\"`), so the gateway used the in-process event bus. "
        "Every latency below therefore excludes network hops to a broker and "
        "understates a deployed configuration.\n"
        if ready.get("redis") != "ok" else ""
    )

    ingest = data.get("ingest", {})
    _ = ingest.get("note", "")  # already stated in section 2 prose
    retry_count = ingest.get("contractsNeedingRetry", 0)

    report = f"""# AssureCode Benchmark Report

> Generated from `docs/benchmarks/benchmark_results.json` by `tools/analyze_benchmark.py`.
> Run at **{data.get('timestamp')}** against **{data.get('gatewayUrl')}**.
> Sample: **{total} contracts** at concurrency **{data.get('concurrency')}**.

Every number here comes from a real HTTP round trip against a running gateway.
`tools/benchmark.js` exits non-zero if the gateway is unreachable rather than
falling back to simulation, so an absent report means the run did not happen.
{redis_note}
---

## 1. Run summary

| | |
|---|---|
| Contracts attempted | {total} |
| Contracts completed | {completed} |
| Contracts with at least one error | {with_errors} |
| Wall-clock duration | {data.get('durationSeconds')} s |
| Throughput | {data.get('throughputContractsPerSec')} contracts/sec |
| Gateway readiness at start | `status={ready.get('status')}` `db={ready.get('db')}` `redis={ready.get('redis')}` |

Terminal status distribution:

{status_lines}

---

## 2. Latency by phase

Four phases are timed: contract initialization, locking (which anchors the
ledger entry), escrow funding, and the RAG scope check. Test generation and
settlement are not driven by this harness and are reported as such rather than
filled in.

| Phase | Mean (ms) | p50 | p90 | p99 | Min | Max |
|---|---|---|---|---|---|---|
{phase_row("1. Initialization", lat.get("initialize"))}
{phase_row("2. Contract lock", lat.get("lock"))}
{phase_row("3. Escrow funding", lat.get("escrow"))}
{phase_row("4. RAG scope check", lat.get("scopeCheck"))}
| **5. Test generation** | not driven by this benchmark | | | | | |
| **6. Oracle settlement** | not driven by this benchmark | | | | | |

Sum of the four measured phases per contract: **{e2e_line}**.

RAG ingest is fire-and-forget from the lock endpoint, so the benchmark waits for
the contract's chunks to become queryable before the scope check. {retry_count}
contract(s) needed a retry; that wait is tracked separately and excluded from the
scope-check figure.

---

## 3. Scope-guard accuracy

The benchmark sends one in-scope or one out-of-scope prompt per contract. The
label decides **which prompt is sent** and scores the answer — it never reaches
the service and never determines the verdict.

```
                       Actual in-scope      Actual out-of-scope
Allowed by guard          TP = {tp:<4}            FP = {fp:<4}
Blocked by guard          FN = {fn:<4}            TN = {tn:<4}
```

| Metric | Value |
|---|---|
| Contracts scored | {scored} |
| Excluded (no verdict returned) | {excluded} |
| Accuracy | {pct(acc.get('accuracy', 0.0))} |
| Precision | {pct(acc.get('precision', 0.0))} |
| Recall | {pct(acc.get('recall', 0.0))} |
| F1 | {pct(acc.get('f1', 0.0))} |

### Reading this honestly

Precision of {pct(acc.get('precision', 0.0))} with recall of {pct(acc.get('recall', 0.0))}
is not a good result. It means the guard almost never allows an out-of-scope
request — and also blocks most in-scope ones. The similarity threshold
(`SCOPE_SIMILARITY_THRESHOLD`, calibrated at 0.3056) was selected on the
calibration split of `infra/calibration/scope_threshold_corpus.json` and scores
0.792 accuracy / 0.917 recall on the held-out split. These numbers are what it
does against this benchmark's own fixture, and the gap between the two is the
finding.

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
"""

    report_file.parent.mkdir(parents=True, exist_ok=True)
    report_file.write_text(report, encoding="utf-8")
    print(f"Wrote {report_file}")
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
