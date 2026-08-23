"""Smoke test for the AI service health endpoint (task 0.1)."""
from __future__ import annotations

from support import service_client

from app.main import app

client = service_client(app)


def test_healthz() -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_root() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["service"] == "assurecode-ai-service"
