"""Pytest configuration — force fake providers so tests run without torch/Neo4j.

The lru_cache in app.deps caches the real adapters; we clear it and re-set the
environment before the app imports them. EMBED_PROVIDER=fake + NODE_ENV=test
make the factory pick FakeEmbedder + InMemoryGraphRepo.
"""
from __future__ import annotations

import os

# Must run before app.deps is imported anywhere.
os.environ["EMBED_PROVIDER"] = "fake"
os.environ["NODE_ENV"] = "test"
os.environ["LLM_PROVIDER"] = "fake"

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_deps_cache():
    """Clear adapter caches between tests so overrides take effect."""
    # Imported here so the env vars above are honored on first import.
    from app import deps

    deps.reset_deps_cache()
    yield
    deps.reset_deps_cache()
