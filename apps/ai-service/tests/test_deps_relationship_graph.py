"""app.deps.get_relationship_graph — the Neo4j/AuraDB collaboration-graph selector.

conftest.py forces NODE_ENV=test globally (so the rest of the suite never
needs live infra), which this factory must also respect: test environment
always means None, regardless of NEO4J_ENABLED. The "enabled in a non-test
environment" branch is exercised by monkeypatching get_settings directly,
since Neo4jGraphRepo connects lazily — constructing it performs no network
I/O, so this needs no live Neo4j/AuraDB instance either.
"""
from __future__ import annotations

from app import deps
from app.ports.graph_repo import Neo4jGraphRepo
from app.settings import Settings


def test_returns_none_in_test_environment_even_if_enabled(monkeypatch) -> None:
    monkeypatch.setenv("NEO4J_ENABLED", "true")
    deps.get_settings.cache_clear()
    deps.reset_deps_cache()
    try:
        assert deps.get_settings().environment == "test"
        assert deps.get_relationship_graph() is None
    finally:
        deps.get_settings.cache_clear()
        deps.reset_deps_cache()


def test_returns_none_when_disabled(monkeypatch) -> None:
    monkeypatch.setenv("NEO4J_ENABLED", "false")
    deps.get_settings.cache_clear()
    deps.reset_deps_cache()
    try:
        assert deps.get_relationship_graph() is None
    finally:
        deps.get_settings.cache_clear()
        deps.reset_deps_cache()


def test_returns_a_neo4j_repo_when_enabled_outside_test_environment(monkeypatch) -> None:
    enabled_settings = Settings(
        NODE_ENV="dev",
        NEO4J_ENABLED=True,
        NEO4J_URI="neo4j+s://example.databases.neo4j.io",
        NEO4J_USER="neo4j",
        NEO4J_PASSWORD="secret",
    )
    monkeypatch.setattr(deps, "get_settings", lambda: enabled_settings)
    deps.reset_deps_cache()
    try:
        repo = deps.get_relationship_graph()
        assert isinstance(repo, Neo4jGraphRepo)
    finally:
        deps.reset_deps_cache()


def test_relationship_graph_is_cached(monkeypatch) -> None:
    enabled_settings = Settings(
        NODE_ENV="dev",
        NEO4J_ENABLED=True,
        NEO4J_URI="neo4j+s://example.databases.neo4j.io",
        NEO4J_USER="neo4j",
        NEO4J_PASSWORD="secret",
    )
    monkeypatch.setattr(deps, "get_settings", lambda: enabled_settings)
    deps.reset_deps_cache()
    try:
        assert deps.get_relationship_graph() is deps.get_relationship_graph()
    finally:
        deps.reset_deps_cache()
