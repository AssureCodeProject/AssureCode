from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_xai_score_calculation():
    payload = {
        "contract_id": "c100",
        "freelancer_id": "f_alex",
        "telemetry": {
            "maintainability": 90.0,
            "cyclomatic_complexity": 4,
            "passed_tests": 5,
            "total_tests": 5,
            "vulnerabilities": 0,
            "chat_sentiment": 0.95,
        },
    }
    response = client.post("/xai/score", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["contract_id"] == "c100"
    assert data["freelancer_id"] == "f_alex"
    assert data["trust_score"] >= 0.8
    assert len(data["justifications"]) == 4
