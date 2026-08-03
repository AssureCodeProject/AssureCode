"""Tests for the NLP matchmaker (task 1.4).

Verifies: returns ranked list, scores in [0,1], top result is a React/Node
freelancer for a React requirements string, and every result carries the XAI
explanation breakdown.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_match_returns_ranked_list() -> None:
    response = client.post(
        "/match",
        json={"requirements": "React TypeScript frontend dashboard", "top_k": 3},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 3
    scores = [r["score"] for r in body["results"]]
    assert scores == sorted(scores, reverse=True), "results must be sorted desc by score"


def test_match_top_result_has_relevant_skills() -> None:
    # Priya is the React/TypeScript/Node expert with the highest trust (0.92).
    response = client.post(
        "/match",
        json={"requirements": "React TypeScript Node.js frontend"},
    )
    assert response.status_code == 200
    top = response.json()["results"][0]
    assert top["freelancer_id"] == "freelancer-priya"
    assert top["trust_score"] == 0.92
    assert "react" in top["explanation"]["matched_skills"]


def test_match_scores_in_unit_interval() -> None:
    response = client.post(
        "/match",
        json={"requirements": "Python FastAPI backend"},
    )
    assert response.status_code == 200
    for r in response.json()["results"]:
        assert 0.0 <= r["score"] <= 1.0
        assert 0.0 <= r["explanation"]["skill_score"] <= 1.0
        assert 0.0 <= r["explanation"]["trust_score"] <= 1.0
        assert 0.0 <= r["explanation"]["history_score"] <= 1.0


def test_match_respects_top_k() -> None:
    response = client.post(
        "/match",
        json={"requirements": "Docker PostgreSQL backend", "top_k": 2},
    )
    assert response.status_code == 200
    assert response.json()["count"] == 2


def test_match_python_requirements_prefer_python_freelancer() -> None:
    """A Python/FastAPI brief must rank Python specialists above React ones.

    This deliberately asserts the ranking *property* rather than naming a single
    freelancer. The previous version asserted `== "freelancer-marcus"`, which was
    true only for the original 5-freelancer fixture; once chen was seeded, chen
    legitimately outranked marcus on identical matched skills (python, fastapi)
    plus higher trust (0.89 vs 0.81) and more deliveries (15 vs 11). Pinning the
    id made fixture growth look like a ranking regression.
    """
    response = client.post(
        "/match",
        json={"requirements": "Python FastAPI backend API", "top_k": 8},
    )
    assert response.status_code == 200
    results = response.json()["results"]

    ranks = {r["freelancer_id"]: i for i, r in enumerate(results)}

    # The top match must actually match on the Python side of the brief.
    top = results[0]
    assert {"python", "fastapi"} & set(top["explanation"]["matched_skills"]), (
        f"top match {top['freelancer_id']} shares no python/fastapi skill with the brief"
    )

    # Every Python/FastAPI specialist outranks every React-only specialist.
    python_specialists = ["freelancer-marcus", "freelancer-chen"]
    react_specialists = ["freelancer-priya", "freelancer-aisha", "freelancer-tomas"]
    for py in python_specialists:
        for react in react_specialists:
            assert ranks[py] < ranks[react], (
                f"{py} (python/fastapi) ranked below {react} (react) "
                f"for a Python brief: {ranks[py]} vs {ranks[react]}"
            )
