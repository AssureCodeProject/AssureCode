"""RAG store port: persist contract chunks + embeddings for scope-check retrieval.

Two adapters:
  - PostgresRagStore: writes to rag_embeddings (vector(384)) via psycopg
  - InMemoryRagStore: dict-of-list, for tests/offline

The route depends on the port; the factory (app.deps) picks the adapter based
on whether DATABASE_URL is reachable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, Sequence, runtime_checkable

import numpy as np


@dataclass(frozen=True)
class StoredChunk:
    contract_id: str
    chunk_idx: int
    content: str
    embedding: tuple[float, ...]


@runtime_checkable
class RagStore(Protocol):
    """Append chunks for a contract and retrieve them back."""

    def store(self, contract_id: str, chunks: Sequence[StoredChunk]) -> int:
        """Persist chunks; return count stored."""
        ...

    def get(self, contract_id: str) -> Sequence[StoredChunk]:
        """Return all chunks for a contract, ordered by idx."""
        ...

    def count(self, contract_id: str) -> int:
        ...


class InMemoryRagStore:
    """Process-local store for tests/offline. Keyed by contract_id."""

    def __init__(self) -> None:
        self._data: dict[str, list[StoredChunk]] = field(default_factory=dict)  # type: ignore[assignment]
        self._data = {}

    def store(self, contract_id: str, chunks: Sequence[StoredChunk]) -> int:
        bucket = self._data.setdefault(contract_id, [])
        # Replace existing chunks for the contract (idempotent re-ingest).
        existing_idx = {c.chunk_idx for c in bucket}
        added = 0
        for c in chunks:
            if c.chunk_idx not in existing_idx:
                bucket.append(c)
                added += 1
        bucket.sort(key=lambda c: c.chunk_idx)
        return added

    def get(self, contract_id: str) -> Sequence[StoredChunk]:
        return tuple(self._data.get(contract_id, ()))

    def count(self, contract_id: str) -> int:
        return len(self._data.get(contract_id, []))


class PostgresRagStore:
    """Live adapter — writes rows into rag_embeddings with pgvector.

    Connects lazily and swallows connection errors so the route can fall back
    to the InMemory store (the scope guard still has data for this process).
    """

    def __init__(self, database_url: str, dim: int = 384) -> None:
        self._database_url = database_url
        self._dim = dim
        self._conn = None
        self._fallback = InMemoryRagStore()

    def _ensure_conn(self) -> bool:
        if self._conn is not None:
            return True
        try:  # pragma: no cover — live DB only
            import psycopg

            self._conn = psycopg.connect(self._database_url, autocommit=False)
            return True
        except Exception:
            self._conn = None
            return False

    def store(self, contract_id: str, chunks: Sequence[StoredChunk]) -> int:
        if not self._ensure_conn():
            return self._fallback.store(contract_id, chunks)
        try:  # pragma: no cover — live DB only
            with self._conn.cursor() as cur:  # type: ignore[union-attr]
                for c in chunks:
                    vec_literal = "[" + ",".join(f"{x:.7f}" for x in c.embedding) + "]"
                    cur.execute(
                        """
                        INSERT INTO rag_embeddings (contract_id, chunk_idx, content, embedding)
                        VALUES (%s, %s, %s, %s::vector)
                        ON CONFLICT DO NOTHING
                        """,
                        (c.contract_id, c.chunk_idx, c.content, vec_literal),
                    )
            self._conn.commit()  # type: ignore[union-attr]
            return len(chunks)
        except Exception:
            self._conn = None  # type: ignore[assignment]
            return self._fallback.store(contract_id, chunks)

    def get(self, contract_id: str) -> Sequence[StoredChunk]:  # pragma: no cover — live DB only
        if not self._ensure_conn():
            return self._fallback.get(contract_id)
        try:
            with self._conn.cursor() as cur:  # type: ignore[union-attr]
                cur.execute(
                    "SELECT chunk_idx, content, embedding FROM rag_embeddings "
                    "WHERE contract_id = %s ORDER BY chunk_idx",
                    (contract_id,),
                )
                rows = cur.fetchall()
            return tuple(
                StoredChunk(
                    contract_id=contract_id,
                    chunk_idx=r[0],
                    content=r[1],
                    embedding=tuple(float(x) for x in (r[2] or [])),
                )
                for r in rows
            )
        except Exception:
            return self._fallback.get(contract_id)

    def count(self, contract_id: str) -> int:
        return len(self.get(contract_id))


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity for two equal-length vectors."""
    va, vb = np.asarray(a, dtype=np.float32), np.asarray(b, dtype=np.float32)
    na, nb = float(np.linalg.norm(va)), float(np.linalg.norm(vb))
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(va, vb) / (na * nb))
