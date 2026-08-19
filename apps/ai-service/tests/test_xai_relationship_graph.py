"""XAI /score dual-writes the trust score to the optional Neo4j relationship graph.

Mirrors the existing graph_repo persistence contract (trust_score_persisted):
the Neo4j write is an advisory side effect that must never fail the request,
and the response must let a caller distinguish "written" from "not written"
rather than silently swallowing the outcome.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.deps import get_relationship_graph, get_scope_log, reset_deps_cache
from app.main import app
from app.ports.scope_log import ScopeDecisionRecord

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean_state():
    reset_deps_cache()
    yield
    app.dependency_overrides.clear()
    reset_deps_cache()


def record_scope(contract_id: str) -> None:
    get_scope_log().record(
        ScopeDecisionRecord(
            contract_id=contract_id,
            sender="client",
            message="m",
            allowed=True,
            similarity=0.5,
            threshold=0.2731,
            genesis_hash="a" * 64,
        )
    )


def post(contract_id: str, freelancer_id: str = "freelancer-priya") -> tuple[int, dict]:
    res = client.post(
        "/xai/score",
        json={
            "contract_id": contract_id,
            "freelancer_id": freelancer_id,
            "telemetry": {
                "maintainability": 90.0,
                "cyclomatic_complexity": 4,
                "passed_tests": 5,
                "total_tests": 5,
                "total_vulnerabilities": 0,
                "critical_vulnerabilities": 0,
                "high_vulnerabilities": 0,
            },
        },
    )
    return res.status_code, res.json()


class StubRelationshipGraph:
    def __init__(self, succeed: bool = True, raises: bool = False) -> None:
        self.succeed = succeed
        self.raises = raises
        self.calls: list[tuple[str, float]] = []

    def update_trust_score(self, freelancer_id: str, trust_score: float) -> bool:
        if self.raises:
            raise RuntimeError("AuraDB unreachable")
        self.calls.append((freelancer_id, trust_score))
        return self.succeed


def test_no_relationship_graph_configured_reports_not_persisted() -> None:
    """Default test environment: get_relationship_graph() is None (see test_deps_relationship_graph.py)."""
    record_scope("c-none")
    status, data = post("c-none")
    assert status == 200
    assert data["network_graph_persisted"] is False


def test_writes_the_score_to_the_relationship_graph_when_configured() -> None:
    record_scope("c-write")
    stub = StubRelationshipGraph(succeed=True)
    app.dependency_overrides[get_relationship_graph] = lambda: stub

    status, data = post("c-write", freelancer_id="freelancer-priya")

    assert status == 200
    assert data["network_graph_persisted"] is True
    assert stub.calls == [("freelancer-priya", data["trust_score"])]


def test_relationship_graph_failure_does_not_fail_the_request() -> None:
    record_scope("c-fail")
    stub = StubRelationshipGraph(raises=True)
    app.dependency_overrides[get_relationship_graph] = lambda: stub

    status, data = post("c-fail")

    assert status == 200
    assert data["network_graph_persisted"] is False
    assert data["trust_score"] > 0
