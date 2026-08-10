"""Advisory LLM narrative on /xai/score (plan item G2).

Three properties are load-bearing, matching the plan's constraints:
  1. The narrative is advisory only — the trust score is bit-for-bit
     identical whether or not a narrative was produced.
  2. LlmUnavailableError degrades the narrative to absent, not the score to
     unavailable — /xai/score must still return 200 with a real score.
  3. A successful LLM call does produce a narrative string.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.deps import reset_deps_cache
from app.main import app

client = TestClient(app)

# A clean, all-passing CI run. Every test here varies only LLM availability, so
# the telemetry is deliberately identical across calls — that is what makes the
# score parity assertion below meaningful.
TELEMETRY = {
    "maintainability": 90.0,
    "cyclomatic_complexity": 4,
    "passed_tests": 5,
    "total_tests": 5,
    "total_vulnerabilities": 0,
    "critical_vulnerabilities": 0,
    "high_vulnerabilities": 0,
}


@pytest.fixture(autouse=True)
def _clean_deps():
    reset_deps_cache()
    yield
    reset_deps_cache()


def post_score(contract_id: str, freelancer_id: str = "f_narrative_test") -> tuple[int, dict]:
    res = client.post(
        "/xai/score",
        json={"contract_id": contract_id, "freelancer_id": freelancer_id, "telemetry": TELEMETRY},
    )
    return res.status_code, res.json()


def test_narrative_present_when_llm_available(monkeypatch) -> None:
    # conftest.py sets LLM_PROVIDER=fake; FakeLlmClient.generate() succeeds
    # unless explicitly told to raise (see the next test).
    monkeypatch.delenv("LLM_UNAVAILABLE", raising=False)
    status, body = post_score("c-narrative-ok")
    assert status == 200
    assert isinstance(body["narrative"], str) and body["narrative"] != ""


def test_llm_unavailable_degrades_narrative_not_score(monkeypatch) -> None:
    """LlmUnavailableError must not turn into a 503 for the whole endpoint."""
    monkeypatch.setenv("LLM_UNAVAILABLE", "true")
    status, body = post_score("c-narrative-unavailable")
    assert status == 200, f"score endpoint must survive an LLM outage, got {status}: {body}"
    assert body["narrative"] is None
    assert isinstance(body["trust_score"], (int, float))


def test_trust_score_identical_with_and_without_narrative(monkeypatch) -> None:
    """The isolation guarantee: same telemetry -> same score, LLM up or down.

    If the narrative could feed back into the score in any way, this would be
    the test that catches it — same contract-shaped input, LLM toggled off
    for one call, and the two scores (and every term) must match exactly.
    """
    monkeypatch.delenv("LLM_UNAVAILABLE", raising=False)
    status_a, body_a = post_score("c-narrative-parity-a", freelancer_id="f_parity_a")
    assert status_a == 200
    assert body_a["narrative"] is not None

    monkeypatch.setenv("LLM_UNAVAILABLE", "true")
    status_b, body_b = post_score("c-narrative-parity-b", freelancer_id="f_parity_b")
    assert status_b == 200
    assert body_b["narrative"] is None

    assert body_a["trust_score"] == body_b["trust_score"]
    assert body_a["terms"] == body_b["terms"]
    assert body_a["critical_vulnerabilities"] == body_b["critical_vulnerabilities"]
