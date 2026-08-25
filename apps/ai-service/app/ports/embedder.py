"""Embedding port: convert text into a fixed-dim vector for similarity search.

The port is a Protocol (structural interface). Two adapters implement it:
  - SentenceTransformerEmbedder: real all-MiniLM-L6-v2 (384-dim)
  - FakeEmbedder: deterministic hash-based vector for tests/offline

The router never imports an adapter directly — it receives whichever the
factory (app.deps) constructs based on EMBED_PROVIDER.
"""
from __future__ import annotations

import hashlib
import os
import sys
import time
from collections.abc import Sequence
from typing import Protocol, runtime_checkable

import numpy as np


@runtime_checkable
class Embedder(Protocol):
    """A text → vector encoder. Vectors are L2-normalized for cosine similarity."""

    @property
    def dim(self) -> int:
        ...

    def embed(self, text: str) -> np.ndarray:
        ...

    def embed_batch(self, texts: Sequence[str]) -> np.ndarray:
        """Stack a batch into shape (n, dim). Default impl loops embed()."""
        ...


class SentenceTransformerEmbedder:
    """Real adapter backed by sentence-transformers (all-MiniLM-L6-v2).

    Loads lazily on first use so importing the module doesn't pull torch when
    the fake provider is selected.
    """

    def __init__(self, model_name: str = "all-MiniLM-L6-v2", dim: int = 384) -> None:
        self._model_name = model_name
        self._dim = dim
        self._model = None  # lazy

    def _ensure_loaded(self) -> None:
        if self._model is None:
            # Imported lazily so tests using the fake provider never load torch.
            from sentence_transformers import SentenceTransformer

            # TEMPORARY diagnostic — pins down whether a specific CI stall
            # (a ~245s gap seen before "Scope Guard unreachable"/scorer
            # timeouts, unchanged across two prior fix attempts) is actually
            # inside this load, and if so whether HF_HUB_OFFLINE was even in
            # effect for *this* process. Remove once that run's log confirms
            # or rules this out — this is not meant to stay long-term.
            t0 = time.monotonic()
            print(
                f"[embedder-diag] loading {self._model_name!r} pid={os.getpid()} "
                f"epoch_ms={int(time.time() * 1000)} "
                f"HF_HUB_OFFLINE={os.environ.get('HF_HUB_OFFLINE')!r} "
                f"HF_HOME={os.environ.get('HF_HOME')!r}",
                file=sys.stderr,
                flush=True,
            )
            self._model = SentenceTransformer(self._model_name)
            # Sync dim to the model's actual output.
            self._dim = self._model.get_sentence_embedding_dimension()  # type: ignore[union-attr]
            print(
                f"[embedder-diag] loaded {self._model_name!r} pid={os.getpid()} "
                f"epoch_ms={int(time.time() * 1000)} "
                f"in {time.monotonic() - t0:.2f}s",
                file=sys.stderr,
                flush=True,
            )

    @property
    def dim(self) -> int:
        return self._dim

    def embed(self, text: str) -> np.ndarray:
        self._ensure_loaded()
        vec = self._model.encode(text, normalize_embeddings=True)  # type: ignore[union-attr]
        return np.asarray(vec, dtype=np.float32)

    def embed_batch(self, texts: Sequence[str]) -> np.ndarray:
        self._ensure_loaded()
        vecs = self._model.encode(list(texts), normalize_embeddings=True)  # type: ignore[union-attr]
        return np.asarray(vecs, dtype=np.float32)


class FakeEmbedder:
    """Deterministic hash-based embedder for tests/offline.

    Maps text → dim-dim vector via sha256 buckets, then L2-normalizes. Same
    text always yields the same vector, so cosine similarity is stable and
    tests can assert on it without a neural net.
    """

    def __init__(self, dim: int = 384) -> None:
        self._dim = dim

    @property
    def dim(self) -> int:
        return self._dim

    def embed(self, text: str) -> np.ndarray:
        vec = np.zeros(self._dim, dtype=np.float32)
        # Hash each whitespace token into a bucket and accumulate — this gives
        # texts with shared vocabulary positive cosine similarity, which is
        # exactly what the matchmaker ranking needs to be testable.
        for token in text.lower().split():
            h = hashlib.sha256(token.encode("utf-8")).digest()
            bucket = int.from_bytes(h[:4], "little") % self._dim
            sign = 1.0 if (h[4] & 1) == 0 else -1.0
            vec[bucket] += sign
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm
        return vec

    def embed_batch(self, texts: Sequence[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self._dim), dtype=np.float32)
        return np.stack([self.embed(t) for t in texts])
