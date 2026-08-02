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
    # Marcus is the Python/FastAPI expert — should outrank React specialists.
    response = client.post(
        "/match",
        json={"requirements": "Python FastAPI backend API"},
    )
    assert response.status_code == 200
    top = response.json()["results"][0]
    assert top["freelancer_id"] == "freelancer-marcus"
