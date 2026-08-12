"""Tests for the embedding port (task 1.3).

Verifies: vector dim == 384, L2 norm == 1 (normalized for cosine), batch shape,
and determinism (same text → same vector).
"""
from __future__ import annotations

import numpy as np
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_embed_returns_384_dim_vector() -> None:
    response = client.post("/embed", json={"text": "React TypeScript frontend"})
    assert response.status_code == 200
    body = response.json()
    assert body["dim"] == 384
    assert len(body["vector"]) == 384


def test_embed_vector_is_l2_normalized() -> None:
    response = client.post("/embed", json={"text": "Python FastAPI backend"})
    assert response.status_code == 200
    vec = np.array(response.json()["vector"], dtype=np.float32)
    norm = float(np.linalg.norm(vec))
    assert abs(norm - 1.0) < 1e-5


def test_embed_is_deterministic() -> None:
    r1 = client.post("/embed", json={"text": "Node.js PostgreSQL"})
    r2 = client.post("/embed", json={"text": "Node.js PostgreSQL"})
    v1 = np.array(r1.json()["vector"], dtype=np.float32)
    v2 = np.array(r2.json()["vector"], dtype=np.float32)
    assert np.array_equal(v1, v2)


def test_embed_batch_shape() -> None:
    response = client.post(
        "/embed/batch",
        json={"texts": ["React", "Python", "Docker"]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["dim"] == 384
    assert len(body["vectors"]) == 3
    assert all(len(v) == 384 for v in body["vectors"])


def test_embed_rejects_empty_text() -> None:
    response = client.post("/embed", json={"text": ""})
    assert response.status_code == 422
