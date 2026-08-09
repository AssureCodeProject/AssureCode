#!/usr/bin/env python3
"""Build a real C1 calibration set from human-authored contract chat data.

Reads data/t2_authored/{contracts,messages}.csv, computes each message's
residual through the SAME pipeline production uses - real
SentenceTransformerEmbedder, the same chunker (target_chars=512,
overlap_chars=64, matching the gateway's /rag/ingest call), and the same
InMemoryRagStore.search() top-k cosine ranking apps/scope-guard/app/main.py
calls in check_scope() - then splits messages by annotator consensus.

Only messages BOTH annotators independently labelled `in_scope` become
calibration residuals. That is deliberately conservative: a message either
annotator flagged as ambiguous is excluded rather than included on a
coin-flip, because the whole point of two annotators is to keep one person's
labelling quirk out of the evidence a false-alarm rate is quoted against.

Also computes Cohen's kappa across ALL dual-labelled messages and enforces
the frozen pilot gate from configs/c1_rules.json: a full run refuses to write
the calibration file if kappa is below the pre-registered minimum, unless
--force is passed. See data/t2_authored/README.md for the intended workflow.

Usage:
    # Pilot: just check annotator agreement, write nothing.
    python tools/eval/build_t2_calibration.py --pilot

    # Full build, once kappa has cleared the gate.
    python tools/eval/build_t2_calibration.py
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

_ROOT = Path(__file__).resolve().parents[2]
_AI_SERVICE = _ROOT / "apps" / "ai-service"
if str(_AI_SERVICE) not in sys.path:
    sys.path.insert(0, str(_AI_SERVICE))

from app.ports.embedder import SentenceTransformerEmbedder  # noqa: E402
from app.ports.rag_store import InMemoryRagStore, StoredChunk  # noqa: E402
from app.services.chunker import chunk_text  # noqa: E402

RETRIEVAL_K_DEFAULT = 5  # matches SCOPE_RETRIEVAL_K's default in scope-guard/app/deps.py
CHUNK_TARGET_CHARS = 512  # matches the gateway's /rag/ingest call (server.ts)
CHUNK_OVERLAP_CHARS = 64

# Unfrozen fallbacks, used only when configs/c1_rules.json is missing.
DEFAULT_MIN_PILOT_KAPPA = 0.6
DEFAULT_PILOT_SIZE = 50

DATASET_FIELDNAMES = [
    "contract_id",
    "sequence_id",
    "sequence_type",
    "message_index",
    "drift_onset_index",
    "sender",
    "message_text",
    "annotator_a_label",
    "annotator_b_label",
    "consensus_label",
    "residual",
]


# ── Cohen's kappa ────────────────────────────────────────────────────────

def cohens_kappa(labels_a: list[str], labels_b: list[str]) -> float:
    """Standard unweighted Cohen's kappa over two raters' categorical labels."""
    if len(labels_a) != len(labels_b):
        raise ValueError("annotator label lists must be the same length")
    n = len(labels_a)
    if n == 0:
        raise ValueError("cannot compute kappa over zero dual-labelled messages")

    categories = sorted(set(labels_a) | set(labels_b))
    idx = {c: i for i, c in enumerate(categories)}
    k = len(categories)
    confusion = [[0] * k for _ in range(k)]
    for a, b in zip(labels_a, labels_b):
        confusion[idx[a]][idx[b]] += 1

    po = sum(confusion[i][i] for i in range(k)) / n
    row_marg = [sum(confusion[i]) / n for i in range(k)]
    col_marg = [sum(confusion[i][j] for i in range(k)) / n for j in range(k)]
    pe = sum(row_marg[i] * col_marg[i] for i in range(k))

    if pe >= 1.0:
        return 1.0  # every rating identical and in one category - trivial agreement
    return (po - pe) / (1 - pe)


# ── Data loading ─────────────────────────────────────────────────────────

def load_contracts(path: Path) -> dict[str, dict]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    contracts = {r["contract_id"]: r for r in rows if r.get("contract_id")}
    if not contracts:
        raise SystemExit(f"No contracts found in {path}")
    return contracts


def load_messages(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    rows = [r for r in rows if r.get("contract_id") and r.get("message_text")]
    if not rows:
        raise SystemExit(f"No messages found in {path}")
    return rows


# ── Pipeline ─────────────────────────────────────────────────────────────

def build_rag_store(
    contracts: dict[str, dict], embedder: SentenceTransformerEmbedder
) -> InMemoryRagStore:
    store = InMemoryRagStore()
    for contract_id, row in contracts.items():
        chunks = chunk_text(
            row["requirements"],
            target_chars=CHUNK_TARGET_CHARS,
            overlap_chars=CHUNK_OVERLAP_CHARS,
        )
        if not chunks:
            print(f"  [warn] {contract_id}: empty requirements text, "
                  "no chunks to check messages against")
            continue
        stored = [
            StoredChunk(
                contract_id=contract_id,
                chunk_idx=c.idx,
                content=c.content,
                embedding=tuple(embedder.embed(c.content).tolist()),
            )
            for c in chunks
        ]
        store.store(contract_id, stored)
    return store


def compute_residual(
    store: InMemoryRagStore,
    embedder: SentenceTransformerEmbedder,
    contract_id: str,
    text: str,
    k: int,
) -> float | None:
    if store.count(contract_id) == 0:
        return None
    query_vec = embedder.embed(text)
    retrieved = store.search(contract_id, query_vec.tolist(), k=k)
    if not retrieved:
        return None
    best = max(r.similarity for r in retrieved)
    return 1.0 - best


# ── Gate ─────────────────────────────────────────────────────────────────

def load_gate_thresholds(rules_path: Path) -> tuple[float, int]:
    """The frozen pilot gate from configs/c1_rules.json, or unfrozen defaults.

    Read from the config rather than hardcoded so the gate is pre-registered
    and cannot be quietly loosened by editing this script after seeing kappa.
    """
    if not rules_path.exists():
        print(f"  [warn] {rules_path} not found - using unfrozen defaults "
              f"(kappa >= {DEFAULT_MIN_PILOT_KAPPA})")
        return DEFAULT_MIN_PILOT_KAPPA, DEFAULT_PILOT_SIZE

    annotation = json.loads(rules_path.read_text(encoding="utf-8")).get("annotation", {})
    return (
        annotation.get("min_pilot_kappa", DEFAULT_MIN_PILOT_KAPPA),
        annotation.get("pilot_size_messages", DEFAULT_PILOT_SIZE),
    )


def compute_dataset_rows(
    store: InMemoryRagStore,
    embedder: SentenceTransformerEmbedder,
    contracts: dict[str, dict],
    messages: list[dict],
    k: int,
) -> tuple[list[dict], list[float], int]:
    """Residual per message, plus the consensus in-scope subset used for calibration.

    Returns (dataset_rows, calibration_residuals, skipped_no_chunks). Only
    messages BOTH annotators labelled `in_scope` reach calibration_residuals —
    see the module docstring for why disagreements are dropped rather than
    resolved.
    """
    dataset_rows: list[dict] = []
    calibration_residuals: list[float] = []
    skipped_no_chunks = 0

    for m in messages:
        contract_id = m["contract_id"]
        if contract_id not in contracts:
            print(f"  [warn] message references unknown contract_id {contract_id}, skipping")
            continue

        residual = compute_residual(store, embedder, contract_id, m["message_text"], k=k)
        if residual is None:
            skipped_no_chunks += 1
            continue

        a = m.get("annotator_a_label", "").strip()
        b = m.get("annotator_b_label", "").strip()
        consensus = a if a and a == b else ""

        dataset_rows.append({
            "contract_id": contract_id,
            "sequence_id": m.get("sequence_id", ""),
            "sequence_type": m.get("sequence_type", ""),
            "message_index": m.get("message_index", ""),
            "drift_onset_index": m.get("drift_onset_index", ""),
            "sender": m.get("sender", ""),
            "message_text": m["message_text"],
            "annotator_a_label": a,
            "annotator_b_label": b,
            "consensus_label": consensus,
            "residual": round(residual, 6),
        })

        if consensus == "in_scope":
            calibration_residuals.append(round(residual, 6))

    return dataset_rows, calibration_residuals, skipped_no_chunks


def write_outputs(
    out_calibration: Path,
    out_dataset: Path,
    calibration_residuals: list[float],
    dataset_rows: list[dict],
) -> None:
    out_calibration.parent.mkdir(parents=True, exist_ok=True)
    out_calibration.write_text(json.dumps(calibration_residuals), encoding="utf-8")

    out_dataset.parent.mkdir(parents=True, exist_ok=True)
    with out_dataset.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=DATASET_FIELDNAMES)
        writer.writeheader()
        writer.writerows(dataset_rows)


# ── Main ─────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--data-dir", default=str(_ROOT / "data" / "t2_authored"))
    parser.add_argument(
        "--out-calibration",
        default=str(_ROOT / "infra" / "calibration" / "scope_drift_t2_real.json"),
    )
    parser.add_argument(
        "--out-dataset",
        default=None,
        help="default: <data-dir>/t2_dataset_with_residuals.csv",
    )
    parser.add_argument("--rules", default=str(_ROOT / "configs" / "c1_rules.json"))
    parser.add_argument("--k", type=int, default=RETRIEVAL_K_DEFAULT)
    parser.add_argument(
        "--pilot", action="store_true", help="check annotator agreement only; write nothing"
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="write the calibration file even if kappa is below the frozen gate",
    )
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    out_dataset = (
        Path(args.out_dataset) if args.out_dataset
        else data_dir / "t2_dataset_with_residuals.csv"
    )

    rules_path = Path(args.rules)
    min_pilot_kappa, pilot_size = load_gate_thresholds(rules_path)

    contracts = load_contracts(data_dir / "contracts.csv")
    messages = load_messages(data_dir / "messages.csv")

    print("=" * 72)
    print(" T2 calibration build - real embedder, real retrieval, no shortcuts")
    print("=" * 72)
    print(f"  contracts : {len(contracts)}")
    print(f"  messages  : {len(messages)}")

    # ── Kappa over every dual-labelled message ────────────────────────────
    dual = [m for m in messages if m.get("annotator_a_label") and m.get("annotator_b_label")]
    single = len(messages) - len(dual)
    if single:
        print(f"  [note] {single} message(s) have only one annotator label and are "
              "excluded from kappa and from calibration")

    if not dual:
        raise SystemExit("No dual-annotated messages found - nothing to compute kappa or calibration from.")

    labels_a = [m["annotator_a_label"].strip() for m in dual]
    labels_b = [m["annotator_b_label"].strip() for m in dual]
    kappa = cohens_kappa(labels_a, labels_b)

    agree_count = sum(1 for a, b in zip(labels_a, labels_b) if a == b)
    print(f"\n  Annotator agreement: {agree_count}/{len(dual)} messages ({agree_count / len(dual):.1%})")
    print(f"  Cohen's kappa       : {kappa:.4f}  (gate: >= {min_pilot_kappa})")

    gate_passed = kappa >= min_pilot_kappa
    print(f"  Pilot gate          : {'PASS' if gate_passed else 'FAIL'}")

    if args.pilot:
        if len(dual) < pilot_size:
            print(f"\n  [note] {len(dual)} dual-labelled messages so far, pilot target is {pilot_size}.")
        if not gate_passed:
            print(
                "\n  Do not scale up yet. Revise the annotation schema (the disagreements above show\n"
                "  where 'in scope' is ambiguous), re-annotate, and re-run --pilot before writing more data."
            )
            sys.exit(1)
        print("\n  Kappa clears the gate. Safe to scale up past the pilot.")
        sys.exit(0)

    if not gate_passed and not args.force:
        print(
            f"\n  Refusing to write a calibration file: kappa {kappa:.4f} is below the frozen gate\n"
            f"  ({min_pilot_kappa}) in {rules_path.name}. This is the same rule the pilot step exists to\n"
            "  enforce - a calibration set built on a schema the annotators don't agree on describes\n"
            "  a false-alarm rate for a distribution that isn't well-defined. Re-annotate, or pass\n"
            "  --force if you understand and accept that and are labelling this run accordingly."
        )
        sys.exit(1)

    # ── Real embedding + retrieval ────────────────────────────────────────
    print("\n  Loading the real embedder (this is the same model production uses)...")
    embedder = SentenceTransformerEmbedder(model_name="all-MiniLM-L6-v2", dim=384)

    print("  Chunking and embedding contract requirements...")
    store = build_rag_store(contracts, embedder)

    print("  Embedding messages and computing residuals...")
    dataset_rows, calibration_residuals, skipped_no_chunks = compute_dataset_rows(
        store, embedder, contracts, messages, k=args.k
    )

    if skipped_no_chunks:
        print(f"  [warn] {skipped_no_chunks} message(s) skipped - "
              "their contract had no chunked requirements text")

    out_calibration = Path(args.out_calibration)
    write_outputs(out_calibration, out_dataset, calibration_residuals, dataset_rows)

    print("\n" + "=" * 72)
    print(f"  Calibration residuals : {len(calibration_residuals)} -> {out_calibration}")
    if calibration_residuals:
        arr = np.asarray(calibration_residuals)
        print(f"    mean={arr.mean():.4f}  std={arr.std():.4f}  min={arr.min():.4f}  max={arr.max():.4f}")
    print(f"  Full labelled dataset : {len(dataset_rows)} -> {out_dataset}")
    print("=" * 72)

    if len(calibration_residuals) < 100:
        print(
            f"\n  [note] only {len(calibration_residuals)} consensus in-scope residuals. The plan's own\n"
            "  Beta-interval arithmetic argues n~300 pooled keeps the realized false-alarm rate from\n"
            "  being too noisy to quote (n~40 per domain realizes anywhere in ~1-12% at nominal 5%).\n"
            "  This file is usable, but note its size honestly wherever you report a delta from it."
        )

    try:
        calibration_path_display = out_calibration.resolve().relative_to(_ROOT).as_posix()
    except ValueError:
        # --out-calibration pointed outside the repo (e.g. a scratch/test path) -
        # fall back to the absolute path rather than crashing on the last line.
        calibration_path_display = str(out_calibration.resolve())

    print(
        "\n  Next step (manual, deliberate): update .env -\n"
        f"    SCOPE_DRIFT_CALIBRATION_PATH={calibration_path_display}\n"
        "    SCOPE_DRIFT_CALIBRATION_SYNTHETIC=0\n"
        "  Only flip SYNTHETIC to 0 once you're satisfied this data is real enough to describe\n"
        "  what it claims - that flag is what keeps every drift response honest about it."
    )


if __name__ == "__main__":
    main()
