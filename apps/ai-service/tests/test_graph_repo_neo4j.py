"""Neo4jGraphRepo.project_exposure — the collaboration-network signal.

No live Neo4j in CI (see conftest.py), so these tests only exercise the
degrade-to-{} contract: an unreachable/misconfigured instance must never
raise, and must return an explicit "unmeasured" empty dict rather than a
fabricated zero-count per freelancer (same convention retrieve_by_embedding
already uses for its own similarity fallback).
"""
from __future__ import annotations

from app.ports.graph_repo import Neo4jGraphRepo


def _unreachable_repo() -> Neo4jGraphRepo:
    # Port 1 is a reserved, always-closed port — connection fails fast rather
    # than waiting out a real timeout window.
    return Neo4jGraphRepo(uri="bolt://localhost:1", user="neo4j", password="x")


def test_project_exposure_degrades_to_empty_dict_when_unreachable() -> None:
    repo = _unreachable_repo()
    result = repo.project_exposure(["freelancer-priya", "freelancer-marcus"], ["react"])
    assert result == {}


def test_project_exposure_handles_empty_inputs_without_a_live_driver() -> None:
    repo = _unreachable_repo()
    assert repo.project_exposure([], []) == {}
