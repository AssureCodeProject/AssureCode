"""C1 drift detector tests.

The plan's gate for this phase:

    synthetic drift sequence: alarm fires after onset
    pure in-scope sequence:   no alarm
    empirical false-alarm rate over 1000 in-scope sequences <= delta

All three are here. The third is the one that matters: it is the difference
between claiming an anytime-valid bound and having measured one. Note that it is
measured against a *synthetic* null, so it verifies the martingale arithmetic,
not the detector's behaviour on real conversations — that needs T2 (Phase 7).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pytest

_SCOPE_GUARD = Path(__file__).resolve().parents[1]
if str(_SCOPE_GUARD) not in sys.path:
    sys.path.insert(0, str(_SCOPE_GUARD))

from app.services.drift_detector import (  # noqa: E402
    AlarmReason,
    ConformalDriftDetector,
    NotCalibrated,
    conformal_p_value,
)

DELTA = 0.05
EPSILON = 0.92
DIM = 16


def in_scope_calibration(rng: np.random.Generator, n: int = 300) -> list[float]:
    """Residuals from 'known in-scope' traffic. Beta-shaped, mass near zero."""
    return list(rng.beta(2.0, 8.0, size=n))


def make_detector(rng: np.random.Generator, **kwargs) -> ConformalDriftDetector:
    centroid = rng.normal(size=DIM)
    return ConformalDriftDetector(
        contract_centroid=centroid,
        calibration_residuals=in_scope_calibration(rng),
        delta=DELTA,
        epsilon=EPSILON,
        calibration_is_synthetic=True,
        **kwargs,
    )


# ── The conformal p-value ─────────────────────────────────────────────


def test_p_value_uses_the_plus_one_correction() -> None:
    """(1 + |{s_i >= s}|) / (n + 1), not the naive fraction.

    Without the correction an observation larger than everything in the
    calibration set gets p = 0, log(p) is undefined, and the guarantee fails on
    exactly the extreme values the detector exists to catch.
    """
    cal = [0.1, 0.2, 0.3, 0.4]
    assert conformal_p_value(cal, 0.35) == pytest.approx(2 / 5)  # one value >= 0.35
    assert conformal_p_value(cal, 0.05) == pytest.approx(5 / 5)  # all four >= 0.05
    assert conformal_p_value(cal, 99.0) == pytest.approx(1 / 5)  # none, but never 0
    assert conformal_p_value(cal, 99.0) > 0.0


def test_p_value_requires_a_calibration_set() -> None:
    with pytest.raises(NotCalibrated):
        conformal_p_value([], 0.5)


def test_p_values_are_approximately_uniform_under_the_null() -> None:
    """The property Ville's inequality rests on."""
    rng = np.random.default_rng(7)
    cal = in_scope_calibration(rng, 500)
    ps = [conformal_p_value(cal, float(x)) for x in rng.beta(2.0, 8.0, size=2000)]
    # Mean of a uniform is 0.5; allow generous slack for a finite sample.
    assert 0.45 < float(np.mean(ps)) < 0.55
    assert 0.03 < float(np.mean([p <= 0.05 for p in ps])) < 0.09


# ── Refusal to run uncalibrated ───────────────────────────────────────


def test_detector_refuses_without_calibration() -> None:
    """No default calibration set. A reported delta must describe something
    that was actually measured."""
    with pytest.raises(NotCalibrated):
        ConformalDriftDetector(contract_centroid=[1.0, 0.0], calibration_residuals=[])


def test_synthetic_calibration_is_labelled_as_such() -> None:
    rng = np.random.default_rng(1)
    det = make_detector(rng)
    assert det.calibration_is_synthetic is True
    assert "SYNTHETIC" in det.coverage_note
    assert "not a measured false-alarm rate" in det.coverage_note


def test_epsilon_of_one_is_rejected() -> None:
    """epsilon = 1 makes every martingale term exactly 1, so the detector can
    never alarm while appearing to run normally."""
    rng = np.random.default_rng(2)
    with pytest.raises(ValueError):
        ConformalDriftDetector(
            contract_centroid=rng.normal(size=DIM),
            calibration_residuals=in_scope_calibration(rng),
            epsilon=1.0,
        )


# ── Behaviour on sequences ────────────────────────────────────────────


def test_pure_in_scope_sequence_does_not_alarm() -> None:
    rng = np.random.default_rng(11)
    det = make_detector(rng)
    for _ in range(200):
        det.observe_residual(float(rng.beta(2.0, 8.0)))
    assert det.state.alarmed is False


def test_gradual_drift_alarms_after_onset() -> None:
    """The case a per-message threshold cannot catch.

    Residuals ramp slowly from the in-scope distribution toward out-of-scope.
    No single message is extreme; the sequence is.
    """
    rng = np.random.default_rng(13)
    det = make_detector(rng)

    onset = 40
    for _i in range(onset):
        det.observe_residual(float(rng.beta(2.0, 8.0)))
    assert det.state.alarmed is False, "alarmed before drift began"

    for step in range(80):
        # Slow ramp: mean residual creeps from ~0.2 toward ~0.7.
        shift = 0.2 + 0.006 * step
        det.observe_residual(float(np.clip(rng.normal(shift, 0.05), 0.0, 1.0)))

    assert det.state.alarmed is True
    assert det.state.alarmed_at >= onset, "alarm must not predate the onset"
    assert det.state.alarm_reason == AlarmReason.MARTINGALE
    delay = det.detection_delay(onset)
    assert delay is not None and delay > 0


def test_abrupt_out_of_scope_run_alarms_quickly() -> None:
    rng = np.random.default_rng(17)
    det = make_detector(rng)
    for _ in range(20):
        det.observe_residual(float(rng.beta(2.0, 8.0)))
    for _ in range(30):
        det.observe_residual(float(np.clip(rng.normal(0.85, 0.05), 0.0, 1.0)))
    assert det.state.alarmed is True
    assert det.detection_delay(20) is not None


def test_a_miss_reports_none_rather_than_zero_delay() -> None:
    """An undetected drift is a miss. Reporting it as delay 0 would make the
    evaluation's mean detection delay better the more often it failed."""
    rng = np.random.default_rng(19)
    det = make_detector(rng)
    for _ in range(50):
        det.observe_residual(float(rng.beta(2.0, 8.0)))
    assert det.detection_delay(10) is None


def test_only_the_first_alarm_is_recorded() -> None:
    rng = np.random.default_rng(23)
    det = make_detector(rng)
    for _ in range(60):
        det.observe_residual(0.95)
    first = det.state.alarmed_at
    for _ in range(60):
        det.observe_residual(0.99)
    assert det.state.alarmed_at == first


# ── The false-alarm bound ─────────────────────────────────────────────


def test_empirical_false_alarm_rate_is_at_most_delta_over_1000_sequences() -> None:
    """The plan's stated gate.

    1000 in-scope sequences of 200 messages each, monitored continuously. Ville's
    inequality bounds P(the martingale ever exceeds 1/delta) by delta, so at most
    ~5% of these sequences may alarm at any point.

    This is measured against a synthetic null, so it verifies that the martingale
    arithmetic delivers its bound — not that the detector behaves this way on
    real conversations, which requires T2.
    """
    rng = np.random.default_rng(2027)
    calibration = in_scope_calibration(rng, 500)
    centroid = rng.normal(size=DIM)

    sequences = 1000
    alarms = 0
    for _ in range(sequences):
        det = ConformalDriftDetector(
            contract_centroid=centroid,
            calibration_residuals=calibration,
            delta=DELTA,
            epsilon=EPSILON,
            calibration_is_synthetic=True,
        )
        for residual in rng.beta(2.0, 8.0, size=200):
            det.observe_residual(float(residual))
            if det.state.alarmed:
                break
        if det.state.alarmed:
            alarms += 1

    rate = alarms / sequences
    print(f"\nempirical false-alarm rate: {rate:.4f} over {sequences} sequences (delta={DELTA})")
    assert rate <= DELTA, f"false-alarm rate {rate:.4f} exceeds delta={DELTA}"


# ── Cumulative drift and the anchor ───────────────────────────────────


def test_cumulative_drift_stays_near_zero_for_on_topic_messages() -> None:
    rng = np.random.default_rng(29)
    centroid = rng.normal(size=DIM)
    det = ConformalDriftDetector(
        contract_centroid=centroid,
        calibration_residuals=in_scope_calibration(rng),
        calibration_is_synthetic=True,
    )
    for _ in range(30):
        nearby = centroid + rng.normal(scale=0.05, size=DIM)
        step = det.observe_residual(0.1, embedding=nearby)
    assert step.cumulative_drift < 0.05


def test_cumulative_drift_grows_as_messages_move_away() -> None:
    """The anchor does not follow. A slow attacker cannot drag c_0 along."""
    rng = np.random.default_rng(31)
    centroid = np.zeros(DIM)
    centroid[0] = 1.0
    away = np.zeros(DIM)
    away[1] = 1.0

    det = ConformalDriftDetector(
        contract_centroid=centroid,
        calibration_residuals=in_scope_calibration(rng),
        calibration_is_synthetic=True,
    )
    drifts = [det.observe_residual(0.5, embedding=away).cumulative_drift for _ in range(30)]
    assert drifts[-1] > drifts[0]
    assert drifts == sorted(drifts), "drift against a fixed anchor must be monotone here"


def test_a_zero_centroid_is_rejected() -> None:
    rng = np.random.default_rng(37)
    with pytest.raises(ValueError):
        ConformalDriftDetector(
            contract_centroid=np.zeros(DIM),
            calibration_residuals=in_scope_calibration(rng),
        )


# ── Ledger anchoring ──────────────────────────────────────────────────


def test_ledger_record_carries_the_contract_anchor_and_the_evidence() -> None:
    rng = np.random.default_rng(41)
    det = make_detector(rng)
    for _ in range(40):
        det.observe_residual(0.9)

    record = det.ledger_record("AC-TEST", "a" * 64)
    assert record["contractId"] == "AC-TEST"
    assert record["genesisHash"] == "a" * 64
    assert record["alarmed"] is True
    assert record["calibrationIsSynthetic"] is True
    # The statistics travel with the decision, so a disputed flag can be
    # re-derived rather than taken on trust.
    for key in ("logMartingale", "pValue", "residual", "cusum", "delta", "calibrationN"):
        assert record[key] is not None


def test_martingale_is_tracked_in_log_space() -> None:
    """A long in-scope run underflows float64 in linear space, and an alarm that
    never fires because the product rounded to zero looks exactly like an alarm
    that correctly did not fire."""
    rng = np.random.default_rng(43)
    det = make_detector(rng)
    for _ in range(2000):
        det.observe_residual(0.01)  # p ≈ 1, each term slightly below 1
    last = det.state.steps[-1]
    assert math.isfinite(last.log_martingale)
    assert last.log_martingale < 0
    assert det.state.alarmed is False


# ── CUSUM ─────────────────────────────────────────────────────────────


def test_cusum_ignores_noise_below_kappa_and_accumulates_above_it() -> None:
    rng = np.random.default_rng(47)
    det = make_detector(rng, cusum_kappa=0.3, cusum_h=5.0)

    for _ in range(50):
        det.observe_residual(0.1)
    assert det.state.steps[-1].cusum == pytest.approx(0.0)

    for _ in range(20):
        step = det.observe_residual(0.5)
    assert step.cusum == pytest.approx(20 * 0.2, abs=1e-9)


def test_cusum_is_inert_when_unconfigured() -> None:
    """kappa and h are null in configs/c1_rules.json until they are selected on
    T2. Until then CUSUM must not fire on placeholder values."""
    rng = np.random.default_rng(53)
    det = make_detector(rng)
    for _ in range(100):
        step = det.observe_residual(0.99)
    assert step.cusum == pytest.approx(0.0)
    assert det.state.alarm_reason in (AlarmReason.NONE, AlarmReason.MARTINGALE)
