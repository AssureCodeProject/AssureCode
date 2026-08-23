"""Scope guard: retrieval-backed decisions anchored to the contract hash.

The properties that matter most here are not accuracy but what happens when
something is missing. The previous implementation answered every request from
eight regexes and returned the constant 0.32 or 0.89, so it always had an
answer — including for contracts that did not exist. A retrieval-backed guard
must refuse when it has nothing to compare against, because "I could not check"
and "this is in scope" are opposite conclusions.
"""
from __future__ import annotations

import pytest
from support import service_client

from app.deps import (
    InMemoryLedgerAnchor,
    InMemoryRagStore,
    RagStoreUnavailable,
    get_embedder,
    get_ledger_anchor,
    get_rag_store,
)
from app.main import app

GENESIS = "a" * 64
CONTRACT = "c100"

REQUIREMENTS = [
    "Build a REST API for user login and session management using Fastify.",
    "Persist user accounts and sessions in PostgreSQL with migrations.",
    "Return JSON error responses with appropriate HTTP status codes.",
    "Write Jest integration tests covering the authentication endpoints.",
]


@pytest.fixture()
def client():
    """Wire in-memory adapters and ingest the contract requirements."""
    from app.ports.rag_store import StoredChunk

    embedder = get_embedder()
    store = InMemoryRagStore()
    store.store(
        CONTRACT,
        [
            StoredChunk(
                contract_id=CONTRACT,
                chunk_idx=i,
                content=text,
                embedding=tuple(embedder.embed(text).tolist()),
            )
            for i, text in enumerate(REQUIREMENTS)
        ],
    )

    anchor = InMemoryLedgerAnchor({CONTRACT: GENESIS})

    app.dependency_overrides[get_rag_store] = lambda: store
    app.dependency_overrides[get_ledger_anchor] = lambda: anchor
    try:
        yield service_client(app)
    finally:
        app.dependency_overrides.clear()


def test_healthz(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


# ── anchoring (Objective 3) ────────────────────────────────────────


def test_every_decision_carries_the_genesis_hash(client):
    res = client.post(
        "/scope/check",
        json={
            "contract_id": CONTRACT,
            "message": "Clarify the login error response format.",
            "sender": "client",
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["genesis_hash"] == GENESIS
    assert body["contract_id"] == CONTRACT


def test_unanchored_contract_is_refused_not_approved(client):
    # No ledger entry means no verifiable contract version. The guard must not
    # answer from an unanchored comparison.
    res = client.post(
        "/scope/check",
        json={"contract_id": "never-locked", "message": "Add a feature.", "sender": "client"},
    )
    assert res.status_code == 409
    assert "genesis hash" in res.json()["detail"]


# ── retrieval-backed decisions ─────────────────────────────────────


# These use messages chosen for LEXICAL overlap, not semantic similarity.
#
# The test embedder hashes whitespace tokens into buckets, so it measures shared
# vocabulary and nothing else. Measured on this fixture, semantically-chosen
# examples do not separate under it at all: "What HTTP status codes should the
# login API return?" scores 0.222 while "build a native iOS and Android mobile
# app..." scores 0.322 — the out-of-scope request ranks higher. Asserting
# semantic separation here would be asserting a property of a model that is not
# in the loop. Threshold separation against all-MiniLM-L6-v2 is measured by
# tools/calibrate_scope_threshold.py instead.


def test_high_overlap_message_is_allowed_with_evidence(client):
    res = client.post(
        "/scope/check",
        json={
            "contract_id": CONTRACT,
            "message": "Write Jest integration tests covering the authentication endpoints.",
            "sender": "client",
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["allowed"] is True
    # The score must come from retrieval, not a constant.
    assert body["similarity_score"] >= body["threshold"]
    assert body["retrieved"], "an allowed decision must cite the chunks it matched"
    assert body["suggested_mediation"] is None


def test_unrelated_message_is_flagged_with_mediation(client):
    res = client.post(
        "/scope/check",
        json={
            "contract_id": CONTRACT,
            "message": "Design a new company logo and brand guidelines.",
            "sender": "client",
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["allowed"] is False
    assert body["similarity_score"] < body["threshold"]
    assert body["suggested_mediation"] is not None
    # The mediation must reference the anchor, not emit a generic warning.
    assert GENESIS[:16] in body["suggested_mediation"]


def test_scores_are_not_the_old_constants(client):
    """0.32 and 0.89 were returned literally, regardless of contract or message."""
    scores = set()
    for message in [
        "Clarify the login error response format.",
        "Add PostgreSQL migrations for the sessions table.",
        "Rewrite the entire product as a blockchain game.",
        "Write Jest tests for the auth endpoints.",
    ]:
        res = client.post(
            "/scope/check",
            json={"contract_id": CONTRACT, "message": message, "sender": "client"},
        )
        assert res.status_code == 200
        scores.add(res.json()["similarity_score"])

    assert scores != {0.32}, "score is still the hardcoded off-scope constant"
    assert scores != {0.89}, "score is still the hardcoded in-scope constant"
    assert len(scores) > 1, "score does not vary with the message — it is not a similarity"


def test_empty_message_is_rejected(client):
    res = client.post(
        "/scope/check", json={"contract_id": CONTRACT, "message": "   ", "sender": "client"}
    )
    assert res.status_code == 400


# ── failure modes must never default to permissive ─────────────────


def test_contract_with_no_indexed_text_is_refused(client):
    anchor = InMemoryLedgerAnchor({"c-empty": GENESIS})
    app.dependency_overrides[get_ledger_anchor] = lambda: anchor

    res = client.post(
        "/scope/check",
        json={"contract_id": "c-empty", "message": "Anything at all.", "sender": "client"},
    )
    # Anchored, but nothing to compare against. Not an approval.
    assert res.status_code == 409
    assert "nothing to compare" in res.json()["detail"]


def test_unavailable_corpus_returns_503_not_allowed(client):
    class DeadStore:
        def search(self, contract_id, query_embedding, k=5):
            raise RagStoreUnavailable("connection refused")

    app.dependency_overrides[get_rag_store] = lambda: DeadStore()

    res = client.post(
        "/scope/check",
        json={"contract_id": CONTRACT, "message": "Clarify the login flow.", "sender": "client"},
    )
    # An unreachable corpus is not evidence that a request is in scope.
    assert res.status_code == 503
    assert "unavailable" in res.json()["detail"].lower()
