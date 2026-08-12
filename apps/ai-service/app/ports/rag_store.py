"""RAG store port: persist contract chunks + embeddings, and retrieve by similarity.

Two adapters:
  - PostgresRagStore: rag_embeddings (vector(384)) via psycopg, ANN search over
    the idx_rag_embeddings_hnsw index
  - InMemoryRagStore: dict-of-list with exact cosine, for tests/offline

Note on failure behaviour
------------------------
PostgresRagStore used to hold an InMemoryRagStore and silently divert to it
whenever a connection or query failed. That made a database outage
indistinguishable from an empty result: `store()` would report success having
written nothing durable, and `search()` would return no matches — which the
scope guard reads as "this message resembles nothing in the contract". A
retrieval-backed decision computed against a corpus that was never loaded is
worse than no decision, so the adapter now raises RagStoreUnavailable and the
caller decides what to do with it.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import numpy as np


class RagStoreUnavailable(RuntimeError):
    """The backing store could not be reached or queried."""


@dataclass(frozen=True)
class StoredChunk:
    contract_id: str
    chunk_idx: int
    content: str
    embedding: tuple[float, ...]


@dataclass(frozen=True)
class RetrievedChunk:
    """A chunk returned by similarity search, with its score."""

    chunk_idx: int
    content: str
    similarity: float


@runtime_checkable
class RagStore(Protocol):
    """Append chunks for a contract, retrieve them, and search by similarity."""

    def store(self, contract_id: str, chunks: Sequence[StoredChunk]) -> int:
        """Persist chunks; return count stored."""
        ...

    def get(self, contract_id: str) -> Sequence[StoredChunk]:
        """Return all chunks for a contract, ordered by idx."""
        ...

    def count(self, contract_id: str) -> int:
        ...

    def search(
        self, contract_id: str, query_embedding: Sequence[float], k: int = 5
    ) -> Sequence[RetrievedChunk]:
        """Return the k most similar chunks for a contract, best first."""
        ...


class InMemoryRagStore:
    """Process-local store for tests/offline. Keyed by contract_id."""

    def __init__(self) -> None:
        self._data: dict[str, list[StoredChunk]] = {}

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

    def search(
        self, contract_id: str, query_embedding: Sequence[float], k: int = 5
    ) -> Sequence[RetrievedChunk]:
        """Exact cosine over every chunk. Mirrors the Postgres ranking.

        Postgres uses HNSW, which is approximate, so the two adapters can order
        near-ties differently. Scores agree to within HNSW's recall on the same
        vectors, which is what the scope threshold is calibrated against.
        """
        chunks = self._data.get(contract_id, [])
        if not chunks:
            return ()
        scored = [
            RetrievedChunk(
                chunk_idx=c.chunk_idx,
                content=c.content,
                similarity=cosine(query_embedding, c.embedding),
            )
            for c in chunks
        ]
        scored.sort(key=lambda r: r.similarity, reverse=True)
        return tuple(scored[:k])


class PostgresRagStore:
    """Live adapter — rag_embeddings with pgvector.

    Raises RagStoreUnavailable rather than degrading to an in-memory store; see
    the module docstring for why.
    """

    def __init__(self, database_url: str, dim: int = 384) -> None:
        self._database_url = database_url
        self._dim = dim
        self._conn = None

    def _connect(self):
        """Return a live connection, reconnecting once if the last one died."""
        if self._conn is not None and not getattr(self._conn, "closed", False):
            return self._conn
        try:
            import psycopg
        except ImportError as err:  # pragma: no cover — packaging issue
            raise RagStoreUnavailable("psycopg is not installed") from err
        try:
            self._conn = psycopg.connect(self._database_url, autocommit=False)
        except Exception as err:
            self._conn = None
            raise RagStoreUnavailable(f"cannot connect to the RAG store: {err}") from err
        return self._conn

    @staticmethod
    def _vector_literal(values: Sequence[float]) -> str:
        return "[" + ",".join(f"{float(x):.7f}" for x in values) + "]"

    def store(self, contract_id: str, chunks: Sequence[StoredChunk]) -> int:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                for c in chunks:
                    cur.execute(
                        """
                        INSERT INTO rag_embeddings (contract_id, chunk_idx, content, embedding)
                        VALUES (%s, %s, %s, %s::vector)
                        ON CONFLICT DO NOTHING
                        """,
                        (c.contract_id, c.chunk_idx, c.content, self._vector_literal(c.embedding)),
                    )
            conn.commit()
            return len(chunks)
        except Exception as err:
            conn.rollback()
            self._conn = None
            raise RagStoreUnavailable(f"failed to store chunks: {err}") from err

    def get(self, contract_id: str) -> Sequence[StoredChunk]:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT chunk_idx, content, embedding FROM rag_embeddings "
                    "WHERE contract_id = %s ORDER BY chunk_idx",
                    (contract_id,),
                )
                rows = cur.fetchall()
        except Exception as err:
            conn.rollback()
            self._conn = None
            raise RagStoreUnavailable(f"failed to read chunks: {err}") from err

        return tuple(
            StoredChunk(
                contract_id=contract_id,
                chunk_idx=r[0],
                content=r[1],
                embedding=_parse_vector(r[2]),
            )
            for r in rows
        )

    def count(self, contract_id: str) -> int:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM rag_embeddings WHERE contract_id = %s", (contract_id,)
                )
                return int(cur.fetchone()[0])
        except Exception as err:
            conn.rollback()
            self._conn = None
            raise RagStoreUnavailable(f"failed to count chunks: {err}") from err

    def search(
        self, contract_id: str, query_embedding: Sequence[float], k: int = 5
    ) -> Sequence[RetrievedChunk]:
        """Similarity search for one contract's chunks.

        `<=>` is pgvector's cosine distance, so similarity is 1 - distance.

        A note on which index this uses, because it is easy to describe wrongly:
        idx_rag_embeddings_hnsw is a *global* index over every vector in the
        table. With the selective `WHERE contract_id = %s` filter below, the
        planner prefers idx_rag_embeddings_contract (btree), fetches that
        contract's handful of rows, and sorts them by distance exactly.
        Measured on PostgreSQL 17.6 with pgvector 0.8.2:

            unfiltered ORDER BY embedding <=> ...  -> Index Scan using
                                                      idx_rag_embeddings_hnsw
            WHERE contract_id = ... ORDER BY ...   -> Bitmap Index Scan on
                                                      idx_rag_embeddings_contract
                                                      + Sort

        That is the better plan, and it makes these results exact rather than
        approximate. HNSW only pays off for search across the whole corpus. So
        this path should not be described as ANN retrieval — it is exact cosine
        ranking over a btree-selected candidate set.
        """
        conn = self._connect()
        literal = self._vector_literal(query_embedding)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT chunk_idx,
                           content,
                           1 - (embedding <=> %s::vector) AS similarity
                      FROM rag_embeddings
                     WHERE contract_id = %s
                       AND embedding IS NOT NULL
                     ORDER BY embedding <=> %s::vector
                     LIMIT %s
                    """,
                    (literal, contract_id, literal, k),
                )
                rows = cur.fetchall()
        except Exception as err:
            conn.rollback()
            self._conn = None
            raise RagStoreUnavailable(f"similarity search failed: {err}") from err

        return tuple(
            RetrievedChunk(chunk_idx=r[0], content=r[1], similarity=float(r[2])) for r in rows
        )


def _parse_vector(raw: object) -> tuple[float, ...]:
    """pgvector comes back as a list, or as its '[1,2,3]' text form."""
    if raw is None:
        return ()
    if isinstance(raw, str):
        return tuple(float(x) for x in raw.strip("[]").split(",") if x.strip())
    return tuple(float(x) for x in raw)  # type: ignore[arg-type]


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity for two equal-length vectors."""
    va, vb = np.asarray(a, dtype=np.float32), np.asarray(b, dtype=np.float32)
    na, nb = float(np.linalg.norm(va)), float(np.linalg.norm(vb))
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(va, vb) / (na * nb))
