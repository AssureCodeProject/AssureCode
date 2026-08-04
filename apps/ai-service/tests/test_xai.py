"""Trust score arithmetic.

The old test posted telemetry and asserted `trust_score >= 0.8`. Every field of
that telemetry had a default, and the route returned 0.92 for essentially any
input, so the assertion held no matter what the formula did. These tests pin the
arithmetic to hand-computed values instead, and cover the cases where the route
must refuse to produce a number at all.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.deps import get_scope_log, reset_deps_cache
from app.main import app
from app.ports.scope_log import ScopeDecisionRecord

client = TestClient(app)


def telemetry(**overrides) -> dict:
    """Fully-measured telemetry. Every field is explicit — there are no defaults."""
    base = {
        "maintainability": 90.0,
        "cyclomatic_complexity": 4,
        "passed_tests": 5,
        "total_tests": 5,
        "total_vulnerabilities": 0,
        "critical_vulnerabilities": 0,
        "high_vulnerabilities": 0,
    }
    base.update(overrides)
    return base


def post(contract_id="c100", freelancer_id="f_alex", **tel) -> tuple[int, dict]:
    res = client.post(
        "/xai/score",
        json={
            "contract_id": contract_id,
            "freelancer_id": freelancer_id,
            "telemetry": telemetry(**tel),
        },
    )
    return res.status_code, res.json()


@pytest.fixture(autouse=True)
def clean_scope_log():
    reset_deps_cache()
    yield
    reset_deps_cache()


def record_scope(contract_id: str, allowed: bool, n: int = 1) -> None:
    log = get_scope_log()
    for _ in range(n):
        log.record(
            ScopeDecisionRecord(
                contract_id=contract_id,
                sender="client",
                message="m",
                allowed=allowed,
                similarity=0.5,
                threshold=0.2731,
                genesis_hash="a" * 64,
            )
        )


# ── the score itself ──────────────────────────────────────────────


def test_score_is_on_0_to_100_not_0_to_1():
    """The settlement gate compares against 85. A 0-1 score could never pass it."""
    status, data = post()
    assert status == 200
    assert 0.0 <= data["trust_score"] <= 100.0
    assert data["trust_score"] > 1.0


def test_all_measured_terms_match_hand_computation():
    # 4 allowed of 5 -> S_scope = 80
    record_scope("c-hand", allowed=True, n=4)
    record_scope("c-hand", allowed=False, n=1)

    # S_test = 100·(4/5) = 80, S_maint = 60, S_sec = max(0,100-40-20-5·3) = 25
    status, data = post(
        contract_id="c-hand",
        maintainability=60.0,
        passed_tests=4,
        total_tests=5,
        total_vulnerabilities=3,
        critical_vulnerabilities=1,
        high_vulnerabilities=1,
    )
    assert status == 200
    # 0.40·80 + 0.25·60 + 0.20·25 + 0.15·80 = 32 + 15 + 5 + 12 = 64
    assert data["trust_score"] == pytest.approx(64.0, abs=0.01)
    assert data["scope_measured"] is True


def test_contributions_sum_to_the_reported_score():
    """Interpretability claim: the parts must actually add up to the whole."""
    record_scope("c-sum", allowed=True, n=3)
    status, data = post(contract_id="c-sum", maintainability=77.0)
    assert status == 200
    assert sum(t["contribution"] for t in data["terms"]) == pytest.approx(
        data["trust_score"], abs=0.01
    )


def test_score_is_deterministic():
    record_scope("c-det", allowed=True, n=2)
    first = post(contract_id="c-det")[1]["trust_score"]
    second = post(contract_id="c-det")[1]["trust_score"]
    assert first == second


def test_score_varies_with_telemetry():
    """The defect this replaces: every contract scored the same 0.92."""
    record_scope("c-vary", allowed=True, n=1)
    good = post(contract_id="c-vary")[1]["trust_score"]
    bad = post(
        contract_id="c-vary",
        maintainability=20.0,
        passed_tests=1,
        total_tests=5,
        total_vulnerabilities=4,
        critical_vulnerabilities=2,
        high_vulnerabilities=1,
    )[1]["trust_score"]
    assert bad < good


def test_security_penalty_follows_the_published_formula():
    """S_sec = max(0, 100 - 40·N_c - 20·N_h - 5·N_t), clamped at zero."""
    record_scope("c-sec", allowed=True, n=1)
    _, data = post(
        contract_id="c-sec",
        total_vulnerabilities=5,
        critical_vulnerabilities=3,
        high_vulnerabilities=1,
    )
    sec_term = next(t for t in data["terms"] if t["name"] == "security")
    # 100 - 120 - 20 - 25 < 0 -> clamped to 0, not negative.
    assert sec_term["value"] == 0.0


# ── refusals: the cases where no number is the right answer ────────


def test_unmeasured_scope_is_excluded_not_defaulted():
    status, data = post(contract_id="c-noscope")
    assert status == 200
    assert data["scope_measured"] is False
    assert [t["name"] for t in data["terms"]] == ["tests", "maintainability", "security"]
    # Weights renormalise over 0.85 so the score stays on 0-100.
    assert sum(t["weight"] for t in data["terms"]) == pytest.approx(1.0, abs=0.001)
    assert any("not measured" in j for j in data["justifications"])


def test_zero_scope_checks_does_not_award_a_perfect_scope_term():
    """Unmeasured must not be worth the same as perfect adherence."""
    unmeasured = post(contract_id="c-unmeasured")[1]["trust_score"]

    record_scope("c-perfect", allowed=True, n=5)
    perfect = post(contract_id="c-perfect")[1]["trust_score"]

    # With maintainability 90 the scope term at 100 pulls the score up, so a
    # contract that never had its scope checked must not match one that did.
    assert unmeasured != perfect


def test_no_tests_executed_is_refused():
    status, data = post(passed_tests=0, total_tests=0)
    assert status == 409
    assert "empty test run" in data["detail"]


def test_inconsistent_severity_counts_are_refused():
    status, _ = post(
        total_vulnerabilities=1, critical_vulnerabilities=2, high_vulnerabilities=0
    )
    assert status == 422


def test_telemetry_is_required_and_has_no_defaults():
    """A request with no telemetry must not produce a score."""
    assert client.post(
        "/xai/score", json={"contract_id": "c1", "freelancer_id": "f1"}
    ).status_code == 422

    # Omitting a single field must fail too — no field carries a default.
    tel = telemetry()
    del tel["maintainability"]
    assert client.post(
        "/xai/score",
        json={"contract_id": "c1", "freelancer_id": "f1", "telemetry": tel},
    ).status_code == 422
