#!/usr/bin/env python3
"""Calibrate the scope-guard similarity threshold against the real embedder.

Why this exists
---------------
The scope guard flags a message when its best retrieved similarity falls below
a threshold. That number decides whether a payment is held, so it cannot be
chosen by feel -- and it cannot be inherited from a different embedder either.
Similarity scales are model-specific: the deterministic FakeEmbedder used in
unit tests is hash-bucket bag-of-words, and its in-scope and out-of-scope
ranges overlap completely. No threshold separates them, which is exactly why
the unit tests assert mechanism rather than accuracy.

What changed
------------
Two defects in the previous version of this script, both of which inflated the
number it reported:

1. It scored messages against each requirement string embedded separately,
   which is not what production does. Production ingests the requirements
   through chunk_text() and ranks chunks with RagStore.search(). Calibrating on
   a path the product does not use produces a threshold for a distribution the
   product never sees. This now runs the real chunker and the real retrieval.

2. It fitted the threshold on 16 messages from one contract and reported the
   accuracy on those same 16 messages. That is a fitting score, not a
   generalisation estimate, and the two differed by a lot: the fitted figure was
   14/16 while the held-out benchmark measured 36% accuracy at 20% recall.
   The corpus is now split by contract, the sweep sees only the calibration
   contracts, and the reported metrics come from contracts it never saw.

The corpus lives in infra/calibration/scope_threshold_corpus.json rather than in
this file, so the data can grow without editing code -- and so its provenance is
recorded next to it. Read that file's $comment before quoting any number from
here: the labels are authored in-repo, not dual-annotated, so the held-out
figures are an optimistic estimate rather than a measurement of real traffic.

Usage
-----
    python tools/calibrate_scope_threshold.py
    python tools/calibrate_scope_threshold.py --set   # write to .env
"""
from __future__ import annotations

import argparse
import itertools
import json
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps" / "ai-service"))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

DEFAULT_CORPUS = REPO_ROOT / "infra" / "calibration" / "scope_threshold_corpus.json"

# These must match what the gateway sends to /rag/ingest and what scope-guard
# uses to retrieve, or the calibration describes a different pipeline.
CHUNK_TARGET_CHARS = 512
CHUNK_OVERLAP_CHARS = 64
RETRIEVAL_K = 5


@dataclass
class Scored:
    contract: str
    message: str
    label: str  # "in" | "out"
    best: float


def metrics(scored: list[Scored], threshold: float) -> dict[str, float]:
    """Treats 'in scope' as the positive class, matching tools/benchmark.js."""
    tp = sum(1 for s in scored if s.label == "in" and s.best >= threshold)
    fn = sum(1 for s in scored if s.label == "in" and s.best < threshold)
    fp = sum(1 for s in scored if s.label == "out" and s.best >= threshold)
    tn = sum(1 for s in scored if s.label == "out" and s.best < threshold)
    total = tp + fn + fp + tn
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {
        "tp": tp, "fn": fn, "fp": fp, "tn": tn,
        "accuracy": (tp + tn) / total if total else 0.0,
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }


def score_corpus(contracts: list[dict], embedder, store_cls, chunk_text) -> list[Scored]:
    """Embed and retrieve exactly the way apps/scope-guard does."""
    from app.ports.rag_store import StoredChunk

    scored: list[Scored] = []
    for contract in contracts:
        cid = contract["id"]
        requirements = "\n".join(contract["requirements"])
        chunks = chunk_text(
            requirements,
            target_chars=CHUNK_TARGET_CHARS,
            overlap_chars=CHUNK_OVERLAP_CHARS,
        )
        store = store_cls()
        store.store(cid, [
            StoredChunk(
                contract_id=cid,
                chunk_idx=c.idx,
                content=c.content,
                embedding=tuple(embedder.embed(c.content).tolist()),
            )
            for c in chunks
        ])
        print(f"  {cid:<16} {len(contract['requirements']):>2} requirements -> "
              f"{len(chunks):>2} chunks")

        for label, key in (("in", "in_scope"), ("out", "out_of_scope")):
            for message in contract[key]:
                retrieved = store.search(cid, embedder.embed(message).tolist(), k=RETRIEVAL_K)
                best = max(r.similarity for r in retrieved)
                scored.append(Scored(cid, message, label, best))
    return scored


# How much worse a false negative is than a false positive.
#
# Not a free parameter, and not tuned: a false negative blocks legitimate work
# and holds a payment, while a false positive costs a scope amendment. The
# product has always documented that ordering (spec section 4.4) -- what it did
# not do was give the sweep an objective that respected it, so the sweep
# maximised plain accuracy and chose a threshold that, on the held-out
# contracts, blocked 8 legitimate requests to avoid 3 scope amendments.
#
# The exact value barely matters, which is the point: every weight from 1.5 to
# 5.0 selects the same threshold on this corpus. Only the ordering is being
# asserted, not a measured exchange rate.
FALSE_NEGATIVE_WEIGHT = 3.0


def sweep(scored: list[Scored]) -> tuple[float, float]:
    """Lowest policy-weighted cost over every midpoint between adjacent scores.

    Ties break toward the larger margin to the nearest sample, so the chosen
    value sits in the middle of a gap rather than flush against an observation
    that a slightly different message would have moved.
    """
    candidates = sorted({s.best for s in scored})
    best_threshold, best_cost, best_margin = 0.0, float("inf"), 0.0
    for t in ((a + b) / 2 for a, b in itertools.pairwise(candidates)):
        m = metrics(scored, t)
        cost = FALSE_NEGATIVE_WEIGHT * m["fn"] + m["fp"]
        margin = min(abs(s.best - t) for s in scored)
        if cost < best_cost or (cost == best_cost and margin > best_margin):
            best_threshold, best_cost, best_margin = t, cost, margin
    return best_threshold, best_cost


def report(title: str, scored: list[Scored], threshold: float) -> dict[str, float]:
    m = metrics(scored, threshold)
    print(f"\n  {title}")
    print(f"    messages  : {len(scored)}  "
          f"({sum(1 for s in scored if s.label == 'in')} in / "
          f"{sum(1 for s in scored if s.label == 'out')} out)")
    print(f"    accuracy  : {m['accuracy']:.3f}")
    print(f"    precision : {m['precision']:.3f}")
    print(f"    recall    : {m['recall']:.3f}")
    print(f"    F1        : {m['f1']:.3f}")
    print(f"    confusion : tp={m['tp']} fn={m['fn']} fp={m['fp']} tn={m['tn']}")
    return m


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--set", action="store_true", help="write the chosen threshold to .env")
    parser.add_argument("--model", default="all-MiniLM-L6-v2")
    parser.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    args = parser.parse_args()

    corpus = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    contracts = corpus["contracts"]
    calibration = [c for c in contracts if c["split"] == "calibration"]
    held_out = [c for c in contracts if c["split"] == "held_out"]

    if not calibration or not held_out:
        print("Corpus needs at least one calibration and one held_out contract.")
        return 1

    try:
        from app.ports.embedder import SentenceTransformerEmbedder
        from app.ports.rag_store import InMemoryRagStore
        from app.services.chunker import chunk_text
    except ImportError as err:
        print(f"cannot import the scope-guard pipeline: {err}")
        return 1

    print("=" * 76)
    print(" Scope-guard threshold calibration")
    print(f" model      : {args.model}")
    print(f" corpus     : {Path(args.corpus).name}  ({corpus.get('provenance', 'unknown')})")
    print(f" split      : {len(calibration)} calibration / {len(held_out)} held-out contracts")
    print(f" pipeline   : chunk_text -> InMemoryRagStore.search(k={RETRIEVAL_K}) "
          "(the production path)")
    print("=" * 76)

    try:
        embedder = SentenceTransformerEmbedder(model_name=args.model, dim=384)
    except Exception as err:
        print(f"\nFAILED to load {args.model}: {err}")
        print("Install it with: pip install sentence-transformers")
        print("This is a SKIP, not a pass -- no threshold has been calibrated.")
        return 1

    print("\nCALIBRATION CONTRACTS")
    cal_scored = score_corpus(calibration, embedder, InMemoryRagStore, chunk_text)
    print("\nHELD-OUT CONTRACTS")
    held_scored = score_corpus(held_out, embedder, InMemoryRagStore, chunk_text)

    ins = sorted(s.best for s in cal_scored if s.label == "in")
    outs = sorted(s.best for s in cal_scored if s.label == "out")
    print("\n" + "-" * 76)
    print(f"  calibration in-scope  min={ins[0]:.4f}  median={ins[len(ins) // 2]:.4f}  max={ins[-1]:.4f}")
    print(f"  calibration out-scope min={outs[0]:.4f}  median={outs[len(outs) // 2]:.4f}  max={outs[-1]:.4f}")
    print(f"  cleanly separable: {ins[0] > outs[-1]}")

    threshold, fitted_cost = sweep(cal_scored)

    print("\n" + "=" * 76)
    print(f"  chosen threshold : {threshold:.4f}")
    print("=" * 76)

    print(f"  objective        : minimise {FALSE_NEGATIVE_WEIGHT:g} x false_negatives "
          f"+ false_positives  (cost {fitted_cost:g})")

    report("FITTED (calibration contracts -- the sweep saw these)", cal_scored, threshold)
    held = report("HELD OUT (contracts the sweep never saw -- this is the estimate)",
                  held_scored, threshold)

    print("\n  Worst held-out misses:")
    misses = [s for s in held_scored
              if (s.label == "in" and s.best < threshold)
              or (s.label == "out" and s.best >= threshold)]
    for s in sorted(misses, key=lambda s: abs(s.best - threshold), reverse=True)[:6]:
        kind = "in-scope BLOCKED " if s.label == "in" else "out-scope ALLOWED"
        print(f"    {kind}  {s.best:.4f}  [{s.contract}] {s.message[:52]}")
    if not misses:
        print("    none")

    print(
        "\n  Read this before quoting it. The corpus is authored in-repo and is not\n"
        "  dual-annotated, so the held-out row above is an optimistic estimate and\n"
        "  not a measurement of production traffic. What it does establish is a\n"
        "  generalisation gap, which the previous single-contract fitting score\n"
        "  could not show at all."
    )

    if args.set:
        env_path = REPO_ROOT / ".env"
        lines = env_path.read_text(encoding="utf-8").split("\n") if env_path.exists() else []
        key = "SCOPE_SIMILARITY_THRESHOLD"
        out, replaced = [], False
        for line in lines:
            if line.startswith(f"{key}="):
                out.append(f"{key}={threshold:.4f}")
                replaced = True
            else:
                out.append(line)
        if not replaced:
            out.append(f"{key}={threshold:.4f}")
        env_path.write_text("\n".join(out), encoding="utf-8")
        print(f"\n  wrote {key}={threshold:.4f} to .env")

    return 0 if held["accuracy"] > 0.5 else 1


if __name__ == "__main__":
    raise SystemExit(main())
