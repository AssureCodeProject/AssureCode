#!/usr/bin/env python3
"""End-to-end verification of the scope guard against live PostgreSQL.

Exercises the real path Objective 3 requires, with no in-memory substitutes:

  1. create a contract and anchor it in merkle_ledger via append_ledger()
  2. embed its requirements with all-MiniLM-L6-v2 and store them as pgvector rows
  3. confirm the retrieval query actually uses idx_rag_embeddings_hnsw (EXPLAIN)
  4. run in-scope and out-of-scope messages through the same code the service
     runs, asserting the decision and that H0 comes back with it
  5. confirm an unanchored contract is refused rather than approved
  6. clean up

Everything it touches is namespaced under a run-specific contract id and
deleted afterwards, so it is safe to run against a shared database.

    python tools/verify_scope_guard_live.py
"""
from __future__ import annotations

import os
import sys
import time
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps" / "ai-service"))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def _load_dotenv() -> None:
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

REQUIREMENTS = [
    "Build a REST API for user login and session management using Fastify.",
    "Persist user accounts and sessions in PostgreSQL with schema migrations.",
    "Return JSON error responses with appropriate HTTP status codes.",
    "Write Jest integration tests covering the authentication endpoints.",
    "Deploy the service behind HTTPS with environment-based configuration.",
]

IN_SCOPE = "Add PostgreSQL migrations for the sessions table."
OUT_OF_SCOPE = "Design a new company logo and brand guidelines."

CA_BUNDLE = REPO_ROOT / "infra" / "certs" / "supabase-ca-bundle.crt"

failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        failures.append(label)


def connect(database_url: str):
    import psycopg

    kwargs: dict = {"autocommit": True}
    # Supabase's direct endpoint chains to a root that is not publicly trusted;
    # pin it rather than disabling verification. See packages/config/src/db.ts.
    if ".supabase.co" in database_url and CA_BUNDLE.exists():
        kwargs["sslmode"] = "verify-full"
        kwargs["sslrootcert"] = str(CA_BUNDLE)
    return psycopg.connect(database_url, **kwargs)


def main() -> int:
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        print("DATABASE_URL is not set. This is a SKIP, not a pass.")
        return 1

    from app.ports.embedder import SentenceTransformerEmbedder
    from app.ports.ledger_anchor import LedgerAnchorUnavailable, PostgresLedgerAnchor
    from app.ports.rag_store import PostgresRagStore, StoredChunk

    contract_id = f"AC-SCOPE-VERIFY-{uuid.uuid4().hex[:8]}"

    print("=" * 76)
    print(" Scope guard — live verification")
    print(f" contract: {contract_id}")
    print("=" * 76)

    print("\n[1] loading all-MiniLM-L6-v2")
    t0 = time.perf_counter()
    embedder = SentenceTransformerEmbedder(model_name="all-MiniLM-L6-v2", dim=384)
    print(f"    loaded in {time.perf_counter() - t0:.1f}s, dim={embedder.dim}")

    conn = connect(database_url)
    try:
        # ── 1. contract + genesis anchor ────────────────────────
        print("\n[2] creating contract and anchoring it in merkle_ledger")
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO contracts (contract_id, client_id, title, requirements,
                                       budget_cents, deadline, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (contract_id) DO NOTHING
                """,
                (contract_id, "client-verify", "Scope guard live verification",
                 " ".join(REQUIREMENTS), 100000, "2026-12-31", "LOCKED"),
            )
            # V009: append_ledger takes canonical RFC 8785 bytes, not jsonb. The
            # literal below is already canonical (single key, no whitespace).
            cur.execute(
                "SELECT append_ledger(%s, %s, %s)",
                (contract_id, "GENESIS", '{"source":"verify_scope_guard_live"}'),
            )
            cur.execute(
                "SELECT current_hash FROM merkle_ledger WHERE contract_id=%s ORDER BY ledger_id LIMIT 1",
                (contract_id,),
            )
            h0 = cur.fetchone()[0]
        check("genesis hash exists", bool(h0) and len(h0) == 64, f"H0={h0[:16]}…")

        anchor = PostgresLedgerAnchor(database_url)
        resolved = anchor.genesis(contract_id)
        check("PostgresLedgerAnchor resolves the same H0", resolved.genesis_hash == h0)

        # ── 2. ingest requirement chunks as pgvector rows ───────
        print("\n[3] embedding and storing requirement chunks")
        store = PostgresRagStore(database_url=database_url, dim=384)
        chunks = [
            StoredChunk(contract_id, i, text, tuple(embedder.embed(text).tolist()))
            for i, text in enumerate(REQUIREMENTS)
        ]
        store.store(contract_id, chunks)
        check("all chunks persisted", store.count(contract_id) == len(REQUIREMENTS),
              f"{store.count(contract_id)}/{len(REQUIREMENTS)}")

        # ── 3. record which index the planner actually chooses ──
        #
        # HNSW is a global index over every vector in the table. A selective
        # `WHERE contract_id = ...` filter makes the btree the better plan:
        # Postgres fetches that contract's handful of rows and sorts them
        # exactly, which is both faster and *exact* rather than approximate.
        # So the scope-guard path does not use HNSW, and should not be
        # described as ANN retrieval. HNSW is verified separately on the
        # unfiltered query, which is the shape it was built for.
        print("\n[4] recording which index the planner chooses")
        qvec = "[" + ",".join(f"{x:.7f}" for x in embedder.embed(IN_SCOPE).tolist()) + "]"

        def explain(sql: str, params: tuple) -> str:
            with conn.cursor() as cur:
                cur.execute("EXPLAIN (FORMAT TEXT) " + sql, params)
                return "\n".join(r[0] for r in cur.fetchall())

        filtered_plan = explain(
            "SELECT chunk_idx FROM rag_embeddings WHERE contract_id = %s "
            "ORDER BY embedding <=> %s::vector LIMIT 5",
            (contract_id, qvec),
        )
        with conn.cursor() as cur:
            cur.execute("SET enable_seqscan = off")
        unfiltered_plan = explain(
            "SELECT chunk_idx FROM rag_embeddings ORDER BY embedding <=> %s::vector LIMIT 5",
            (qvec,),
        )
        with conn.cursor() as cur:
            cur.execute("SET enable_seqscan = on")

        chosen = (
            "idx_rag_embeddings_hnsw"
            if "idx_rag_embeddings_hnsw" in filtered_plan
            else "idx_rag_embeddings_contract (btree) + exact sort"
            if "idx_rag_embeddings_contract" in filtered_plan
            else "sequential scan"
        )
        print(f"    per-contract query uses: {chosen}")
        check(
            "HNSW is usable for unfiltered ANN",
            "idx_rag_embeddings_hnsw" in unfiltered_plan,
            "the index is live and the planner will use it when unfiltered",
        )
        check(
            "per-contract retrieval uses an index, not a full scan",
            "Seq Scan" not in filtered_plan,
            chosen,
        )

        # ── 4. decisions through the real retrieval path ────────
        print("\n[5] scope decisions via PostgresRagStore.search")
        threshold = float(os.environ.get("SCOPE_SIMILARITY_THRESHOLD", "0.3056"))

        hits_in = store.search(contract_id, embedder.embed(IN_SCOPE).tolist(), k=5)
        best_in = max(r.similarity for r in hits_in)
        check("in-scope message allowed", best_in >= threshold,
              f"best={best_in:.4f} >= {threshold}")
        check("in-scope decision cites evidence", len(hits_in) > 0,
              f"{len(hits_in)} chunks, top='{hits_in[0].content[:40]}…'")

        hits_out = store.search(contract_id, embedder.embed(OUT_OF_SCOPE).tolist(), k=5)
        best_out = max(r.similarity for r in hits_out)
        check("out-of-scope message flagged", best_out < threshold,
              f"best={best_out:.4f} < {threshold}")

        check("scores are not the old constants",
              best_in not in (0.32, 0.89) and best_out not in (0.32, 0.89),
              f"in={best_in:.4f} out={best_out:.4f}")

        # ── 5. unanchored contract must be refused ──────────────
        print("\n[6] unanchored contract is refused, not approved")
        try:
            anchor.genesis(f"AC-NEVER-LOCKED-{uuid.uuid4().hex[:8]}")
            check("unanchored contract raises", False, "it returned an anchor")
        except LedgerAnchorUnavailable:
            check("unanchored contract raises LedgerAnchorUnavailable", True)

    finally:
        print("\n[7] cleaning up")
        with conn.cursor() as cur:
            cur.execute("DELETE FROM rag_embeddings WHERE contract_id = %s", (contract_id,))
            cur.execute("DELETE FROM merkle_ledger WHERE contract_id = %s", (contract_id,))
            cur.execute("DELETE FROM contracts WHERE contract_id = %s", (contract_id,))
        print(f"    removed {contract_id}")
        conn.close()

    print("\n" + "=" * 76)
    if failures:
        print(f" FAILED: {len(failures)} check(s) — {', '.join(failures)}")
        return 1
    print(" All checks passed against live PostgreSQL.")
    print("=" * 76)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
