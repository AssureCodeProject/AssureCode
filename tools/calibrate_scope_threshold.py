#!/usr/bin/env python3
"""Calibrate the scope-guard similarity threshold against the real embedder.

Why this exists
---------------
The scope guard flags a message when its best retrieved similarity falls below
a threshold. That number decides whether a payment is held, so it cannot be
chosen by feel — and it cannot be inherited from a different embedder either.
Similarity scales are model-specific: the deterministic FakeEmbedder used in
unit tests is hash-bucket bag-of-words, and measured on the fixture below its
in-scope and out-of-scope ranges overlap completely. No threshold separates
them, which is exactly why the unit tests assert mechanism rather than accuracy.

This script measures the real distribution under all-MiniLM-L6-v2 and reports
the threshold that maximises separation, together with the numbers behind it.

What it reports
---------------
  * best-match similarity for every labelled message
  * the achievable separation, if in-scope and out-of-scope are separable
  * the chosen threshold, its accuracy, and the margin either side

Usage
-----
    python tools/calibrate_scope_threshold.py
    python tools/calibrate_scope_threshold.py --set   # write to .env
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps" / "ai-service"))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


# A single contract's requirements, and messages labelled against them.
# Deliberately small and hand-labelled: this calibrates one number, and a
# larger set belongs in the evaluation corpus rather than here.

REQUIREMENTS = [
    "Build a REST API for user login and session management using Fastify.",
    "Persist user accounts and sessions in PostgreSQL with schema migrations.",
    "Return JSON error responses with appropriate HTTP status codes.",
    "Write Jest integration tests covering the authentication endpoints.",
    "Deploy the service behind HTTPS with environment-based configuration.",
]

IN_SCOPE = [
    "Can we clarify the JSON error response format for the user login endpoint?",
    "Add PostgreSQL migrations for the sessions table.",
    "Write Jest tests for the authentication endpoints.",
    "What HTTP status codes should the login API return on a bad password?",
    "Please add session expiry handling to the login flow.",
    "Could you document the environment variables needed for deployment?",
    "The integration tests for signup are failing, can you look?",
    "Should the API return 401 or 403 for an expired session?",
]

OUT_OF_SCOPE = [
    "Also build a native iOS and Android mobile app with push notifications.",
    "Rewrite the entire product as a blockchain game.",
    "Design a new company logo and brand guidelines.",
    "Migrate all infrastructure to Kubernetes with a service mesh.",
    "Can you also run our social media marketing campaign?",
    "Add a real-time video conferencing feature to the dashboard.",
    "Build an admin analytics dashboard with custom report builder.",
    "Please translate the whole product into eight languages.",
]


@dataclass
class Scored:
    message: str
    label: str
    best: float


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--set", action="store_true", help="write the chosen threshold to .env")
    parser.add_argument("--model", default="all-MiniLM-L6-v2")
    args = parser.parse_args()

    try:
        from app.ports.embedder import SentenceTransformerEmbedder
    except ImportError as err:
        print(f"cannot import the embedder port: {err}")
        return 1

    print("=" * 76)
    print(" Scope-guard threshold calibration")
    print(f" model: {args.model}")
    print(f" corpus: {len(REQUIREMENTS)} requirement chunks")
    print(f" labelled: {len(IN_SCOPE)} in-scope, {len(OUT_OF_SCOPE)} out-of-scope")
    print("=" * 76)

    try:
        embedder = SentenceTransformerEmbedder(model_name=args.model, dim=384)
        chunk_vectors = [embedder.embed(text) for text in REQUIREMENTS]
    except Exception as err:
        print(f"\nFAILED to load {args.model}: {err}")
        print("Install it with: pip install sentence-transformers")
        print("This is a SKIP, not a pass — no threshold has been calibrated.")
        return 1

    from app.ports.rag_store import cosine

    def best_match(message: str) -> float:
        q = embedder.embed(message)
        return max(cosine(q, c) for c in chunk_vectors)

    scored: list[Scored] = []
    print("\nIN SCOPE")
    for m in IN_SCOPE:
        b = best_match(m)
        scored.append(Scored(m, "in", b))
        print(f"  {b:.4f}  {m[:66]}")

    print("\nOUT OF SCOPE")
    for m in OUT_OF_SCOPE:
        b = best_match(m)
        scored.append(Scored(m, "out", b))
        print(f"  {b:.4f}  {m[:66]}")

    ins = sorted(s.best for s in scored if s.label == "in")
    outs = sorted(s.best for s in scored if s.label == "out")

    print("\n" + "-" * 76)
    print(f"  in-scope  min={ins[0]:.4f}  median={ins[len(ins)//2]:.4f}  max={ins[-1]:.4f}")
    print(f"  out-scope min={outs[0]:.4f}  median={outs[len(outs)//2]:.4f}  max={outs[-1]:.4f}")

    separable = ins[0] > outs[-1]
    print(f"  cleanly separable: {separable}")

    # Sweep every midpoint between adjacent observed scores and keep the
    # threshold with the best accuracy, breaking ties toward the largest margin.
    candidates = sorted({s.best for s in scored})
    midpoints = [(a + b) / 2 for a, b in zip(candidates, candidates[1:])]
    best_threshold, best_acc, best_margin = 0.0, -1.0, 0.0

    for t in midpoints:
        tp = sum(1 for s in scored if s.label == "in" and s.best >= t)
        tn = sum(1 for s in scored if s.label == "out" and s.best < t)
        acc = (tp + tn) / len(scored)
        margin = min(abs(s.best - t) for s in scored)
        if acc > best_acc or (acc == best_acc and margin > best_margin):
            best_threshold, best_acc, best_margin = t, acc, margin

    fp = [s for s in scored if s.label == "out" and s.best >= best_threshold]
    fn = [s for s in scored if s.label == "in" and s.best < best_threshold]

    print("\n" + "=" * 76)
    print(f"  chosen threshold : {best_threshold:.4f}")
    print(f"  accuracy         : {best_acc:.3f} ({len(scored) - len(fp) - len(fn)}/{len(scored)})")
    print(f"  nearest sample   : {best_margin:.4f} away")
    print(f"  false positives  : {len(fp)}  (out-of-scope wrongly allowed)")
    for s in fp:
        print(f"      {s.best:.4f}  {s.message[:60]}")
    print(f"  false negatives  : {len(fn)}  (in-scope wrongly flagged)")
    for s in fn:
        print(f"      {s.best:.4f}  {s.message[:60]}")
    print("=" * 76)

    print(
        "\n  This threshold is calibrated on a single hand-labelled contract and is\n"
        "  specific to this embedding model. It is a starting value, not a result:\n"
        "  a defensible number needs the labelled corpus, and any reported accuracy\n"
        "  must come from data the threshold was NOT selected on."
    )

    if args.set:
        env_path = REPO_ROOT / ".env"
        lines = env_path.read_text(encoding="utf-8").split("\n") if env_path.exists() else []
        key = "SCOPE_SIMILARITY_THRESHOLD"
        out, replaced = [], False
        for line in lines:
            if line.startswith(f"{key}="):
                out.append(f"{key}={best_threshold:.4f}")
                replaced = True
            else:
                out.append(line)
        if not replaced:
            out.append(f"{key}={best_threshold:.4f}")
        env_path.write_text("\n".join(out), encoding="utf-8")
        print(f"\n  wrote {key}={best_threshold:.4f} to .env")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
