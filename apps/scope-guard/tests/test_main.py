from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_healthz():
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_scope_check_in_scope():
    payload = {
        "contract_id": "c100",
        "message": "Can we clarify the API response format for the user login?",
        "sender": "client",
    }
    response = client.post("/scope/check", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["allowed"] is True
    assert data["similarity_score"] > 0.5


def test_scope_check_off_scope():
    payload = {
        "contract_id": "c100",
        "message": "Please add a mobile app for free without extra budget.",
        "sender": "client",
    }
    response = client.post("/scope/check", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["allowed"] is False
    assert "suggested_mediation" in data
    assert data["suggested_mediation"] is not None
