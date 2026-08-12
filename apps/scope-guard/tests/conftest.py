"""Pytest configuration — force offline adapters.

EMBED_PROVIDER=fake selects the deterministic hash-bucket embedder so tests run
without downloading sentence-transformers weights, and NODE_ENV=test selects the
in-memory RAG store and ledger anchor. These must be set before app.deps is
imported anywhere, because the factories are lru_cached on first use.

The fake embedder gives shared vocabulary a positive cosine, which is enough for
the ranking assertions here. It is not a stand-in for retrieval quality — that
is measured against the real model in tools/, not asserted in unit tests.
"""
from __future__ import annotations

import os

os.environ["EMBED_PROVIDER"] = "fake"
os.environ["NODE_ENV"] = "test"
os.environ.pop("DATABASE_URL", None)

import pytest


@pytest.fixture(autouse=True)
def _reset_deps_cache():
    """Clear adapter caches between tests so overrides take effect."""
    from app import deps

    deps.reset_deps_cache()
    yield
    deps.reset_deps_cache()
