"""Matchmaker's optional collaboration-network term (Neo4j-backed).

Unit-level, not via HTTP: constructs Matchmaker directly with a stub
relationship graph so these tests need neither Postgres nor a live Neo4j —
consistent with the project_exposure degrade contract in
test_graph_repo_neo4j.py, which is the only thing Matchmaker relies on here.
"""
from __future__ import annotations

from app.ports.embedder import FakeEmbedder
from app.ports.graph_repo import InMemoryGraphRepo
from app.services.matchmaker import Matchmaker


class StubRelationshipGraph:
    """Records the call it received and returns a canned exposure map."""

    def __init__(self, exposure: dict[str, int]) -> None:
        self.exposure = exposure
        self.calls: list[tuple[tuple[str, ...], tuple[str, ...]]] = []

    def project_exposure(self, freelancer_ids, required_skills) -> dict[str, int]:
        self.calls.append((tuple(freelancer_ids), tuple(required_skills)))
        return self.exposure


def test_network_term_is_zero_and_unweighted_without_a_relationship_graph() -> None:
    """Regression guard: no relationship_graph must reproduce today's formula exactly."""
    mm = Matchmaker(embedder=FakeEmbedder(), graph=InMemoryGraphRepo())
    results = mm.match("React TypeScript frontend", top_k=20)
    assert results
    for r in results:
        assert r.explanation.network_score == 0.0
        expected = round(
            0.5 * r.explanation.skill_score
            + 0.35 * r.explanation.trust_score
            + 0.15 * r.explanation.history_score,
            4,
        )
        assert r.score == expected


def test_network_term_ranks_higher_exposure_above_lower_exposure() -> None:
    """Isolate the network term: zero out every other weight."""
    graph = InMemoryGraphRepo()
    all_ids = [f.id for f in graph.all_freelancers()]
    # Elena gets heavy exposure, everyone else gets none.
    stub = StubRelationshipGraph(exposure={"freelancer-elena": 10})

    mm = Matchmaker(
        embedder=FakeEmbedder(),
        graph=graph,
        w_skill=0.0,
        w_trust=0.0,
        w_history=0.0,
        w_network=1.0,
        relationship_graph=stub,
    )
    results = mm.match("Python security backend", top_k=len(all_ids))

    ranked_ids = [r.freelancer_id for r in results]
    assert ranked_ids[0] == "freelancer-elena"

    top = results[0]
    assert top.explanation.network_score == 1.0
    assert top.score == 1.0

    for r in results[1:]:
        assert r.explanation.network_score == 0.0
        assert r.score == 0.0


def test_relationship_graph_is_queried_once_per_match_not_per_candidate() -> None:
    graph = InMemoryGraphRepo()
    stub = StubRelationshipGraph(exposure={})

    mm = Matchmaker(embedder=FakeEmbedder(), graph=graph, w_network=0.1, relationship_graph=stub)
    mm.match("Docker PostgreSQL backend", top_k=5)

    assert len(stub.calls) == 1


def test_unmeasured_exposure_degrades_to_zero_not_an_error() -> None:
    """project_exposure returning {} (its own degrade contract) must not fail matching."""
    graph = InMemoryGraphRepo()
    stub = StubRelationshipGraph(exposure={})

    mm = Matchmaker(embedder=FakeEmbedder(), graph=graph, w_network=0.2, relationship_graph=stub)
    results = mm.match("React frontend", top_k=5)

    assert results
    for r in results:
        assert r.explanation.network_score == 0.0
