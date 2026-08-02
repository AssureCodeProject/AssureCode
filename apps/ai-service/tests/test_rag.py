"""Tests for the /rag/ingest route (task 1.5).

Verifies: chunking → embedding → persistence round-trip, count endpoint, and
that the InMemoryRagStore returns what was stored.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_ingest_stores_chunks_and_returns_count() -> None:
    text = (
        "Build a React dashboard with real-time charts.\n\n"
        "Backend in Node.js with Fastify.\n\n"
        "PostgreSQL for persistence, Redis for caching.\n\n"
        "Deploy on AWS with Docker."
    )
    response = client.post(
        "/rag/ingest",
        json={"contract_id": "AC-TEST1", "text": text, "target_chars": 128, "overlap_chars": 16},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["contract_id"] == "AC-TEST1"
    assert body["chunks_stored"] >= 1
    assert body["dim"] == 384


def test_ingest_count_round_trip() -> None:
    text = "\n\n".join(f"Requirement block number {i}." for i in range(6))
    ingest = client.post(
        "/rag/ingest",
        json={"contract_id": "AC-TEST2", "text": text, "target_chars": 96, "overlap_chars": 16},
    )
    assert ingest.status_code == 200
    stored = ingest.json()["chunks_stored"]

    count = client.get("/rag/count/AC-TEST2")
    assert count.status_code == 200
    assert count.json()["chunks"] == stored


def test_ingest_empty_text_stores_nothing() -> None:
    # Whitespace-only text → chunker returns [] → 0 stored, 200 OK.
    response = client.post(
        "/rag/ingest",
        json={"contract_id": "AC-EMPTY", "text": "   \n\n  ", "target_chars": 128},
    )
    assert response.status_code == 200
    assert response.json()["chunks_stored"] == 0


def test_ingest_is_idempotent_for_same_contract() -> None:
    payload = {
        "contract_id": "AC-IDEM",
        "text": "One sufficiently long requirement statement that exceeds the minimum chunk length threshold.",
        "target_chars": 512,
        "overlap_chars": 64,
    }
    r1 = client.post("/rag/ingest", json=payload)
    r2 = client.post("/rag/ingest", json=payload)
    assert r1.status_code == 200 and r2.status_code == 200
    # Second ingest of identical chunks should not duplicate (ON CONFLICT / set dedupe).
    assert client.get("/rag/count/AC-IDEM").json()["chunks"] == 1
