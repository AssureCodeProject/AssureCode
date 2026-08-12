"""C1: sequential contract-anchored scope-drift detection.

The gap this addresses
----------------------
The shipped scope guard asks, of each message independently: is this request far
from the contract? That is the obvious formulation and it has a defect that no
amount of threshold tuning removes. Scope creep is *incremental*. Each request
is a two-percent stretch that any per-message test correctly judges in-scope,
and twenty requests later the deliverable is a different product. A per-message
threshold cannot detect this by construction — every individual observation is
genuinely unremarkable, and the evidence exists only in the sequence.

So the detector here is sequential. It accumulates.

Three quantities
----------------
1. Per-message residual, against the retrieved contract chunks R_c:

       s_t = 1 - max_{r in R_c} cos(e(m_t), r)

   Small when the message resembles the contract, large when it does not. This
   is the same retrieval the scope guard already performs, deliberately: a
   detector evaluated on a representation the product does not use would not
   measure the product.

2. Cumulative drift, anchored at the contract centroid c_0 fixed at lock time:

       c_t = normalize(c_{t-1} + eta * e(m_t))
       D_t = 1 - cos(c_t, c_0)

   The anchor is what makes this contract-anchored rather than merely
   sequential. c_0 does not move, so drift is measured against what was agreed,
   not against a rolling window that a slow attacker can drag along with them.

3. CUSUM over the residuals, with per-message slack kappa:

       S_t = max(0, S_{t-1} + (s_t - kappa))

   Noise below kappa accumulates nothing; a persistent small excess accumulates
   linearly. This is what makes twenty two-percent stretches visible.

Why a conformal martingale rather than a tuned threshold
--------------------------------------------------------
A CUSUM threshold h is a number someone picked. When the system it gates freezes
a payment, "we picked 8.5" is not an answer to "how often does this fire on an
honest freelancer?"

The conformal test martingale gives a distribution-free, finite-sample answer.
Given calibration residuals from known in-scope traffic, the conformal p-value
of the current residual is

       p_t = (1 + |{i : s_i >= s_t}|) / (n + 1)

Under exchangeability these are uniform on (0,1], so the martingale

       M_t = prod_{i<=t} epsilon * p_i^(epsilon - 1)

has expectation 1 under the null. Ville's inequality then bounds the probability
that it ever exceeds 1/delta, at any time, by delta. That is an *anytime-valid*
guarantee: it holds under continuous monitoring, without a pre-declared sample
size and without correction for repeated looks. For a system that halts money on
an automated flag, a calibrated false-alarm rate is the contribution; a
hand-picked threshold is not.

What is honest about the guarantee, and what is not
---------------------------------------------------
The bound holds *within distribution* — it requires the calibration residuals
and the monitored residuals to be exchangeable. Calibrating on authored data
(T2) and monitoring real threads (T1) violates that, so on real data delta is an
approximation whose error must be measured and reported, not assumed away.

More immediately: **this module ships with no calibration set.** T2 is Phase 7
and does not exist. `ConformalDriftDetector` therefore requires calibration
residuals to be passed in and refuses to run without them, rather than
substituting a default that would make the delta printed in the output a
fiction. Synthetic calibration is available for testing and is labelled
synthetic in the result; it is not a publishable false-alarm rate.

Positioning
-----------
Conformal test martingales are established (Ville 1939; Vovk 2003; Volkhonskiy
et al. 2017), CUSUM is Page 1954, and requirements-volatility metrics exist in
the software-engineering literature but are retrospective and non-ML. The
contribution claimed here is the combination: sequential, embedding-based,
anchored to a hashed contract, with anytime-valid coverage. Change-point
detection is not new and this module does not pretend otherwise.
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

__all__ = [
    "AlarmReason",
    "ConformalDriftDetector",
    "DriftState",
    "DriftStep",
    "NotCalibrated",
    "conformal_p_value",
]


class NotCalibrated(RuntimeError):
    """Raised when the detector is asked to decide without a calibration set.

    Deliberately fatal. The alternative is a default calibration, which would
    make `delta` a decoration: the reported false-alarm rate would describe a
    distribution nobody measured, and the caller could not tell.
    """


def conformal_p_value(calibration: Sequence[float], observed: float) -> float:
    """Smoothed-free conformal p-value of `observed` against `calibration`.

        p = (1 + |{i : s_i >= s}|) / (n + 1)

    The +1 in both places is not cosmetic. It is what makes the p-value valid
    for finite n: without it p can be 0, the martingale term is undefined, and
    the coverage guarantee fails on exactly the extreme observations that matter.
    """
    n = len(calibration)
    if n == 0:
        raise NotCalibrated("conformal p-value requires a non-empty calibration set")
    ge = sum(1 for s in calibration if s >= observed)
    return (1.0 + ge) / (n + 1.0)


class AlarmReason:
    NONE = "none"
    MARTINGALE = "conformal_martingale"
    CUSUM = "cusum"


@dataclass
class DriftStep:
    """One message's contribution, and what the detector concluded after it."""

    index: int
    residual: float
    p_value: float
    log_martingale: float
    cusum: float
    cumulative_drift: float
    alarmed: bool
    reason: str = AlarmReason.NONE


@dataclass
class DriftState:
    """The running state of one monitored conversation."""

    steps: list[DriftStep] = field(default_factory=list)
    alarmed_at: int | None = None
    alarm_reason: str = AlarmReason.NONE

    @property
    def alarmed(self) -> bool:
        return self.alarmed_at is not None


def _normalize(v: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(v))
    if norm == 0.0:
        # A zero vector has no direction, so it cannot be a centroid. Returning
        # it unchanged would make every subsequent cosine NaN and the detector
        # would silently stop deciding anything.
        raise ValueError("cannot normalize a zero vector")
    return v / norm


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0.0:
        raise ValueError("cosine is undefined for a zero vector")
    return float(np.dot(a, b) / denom)


class ConformalDriftDetector:
    """Sequential drift detector with an anytime-valid false-alarm bound.

    One instance monitors one conversation. State is per-conversation because
    the martingale is a running product over that conversation's messages;
    sharing an instance across contracts would let one participant's traffic
    raise an alarm on another's.
    """

    def __init__(
        self,
        contract_centroid: Sequence[float],
        calibration_residuals: Sequence[float],
        *,
        delta: float = 0.05,
        epsilon: float = 0.92,
        eta: float = 0.15,
        cusum_kappa: float | None = None,
        cusum_h: float | None = None,
        calibration_is_synthetic: bool = False,
    ) -> None:
        if not calibration_residuals:
            raise NotCalibrated(
                "ConformalDriftDetector requires calibration residuals from known in-scope "
                "traffic. There is no default: a martingale calibrated against nothing reports "
                "a false-alarm rate for a distribution that was never measured. Build the T2 "
                "calibration set (Phase 7), or pass synthetic residuals with "
                "calibration_is_synthetic=True for testing."
            )
        if not 0.0 < delta < 1.0:
            raise ValueError("delta must be in (0, 1)")
        if not 0.0 < epsilon < 1.0:
            # epsilon = 1 makes every term 1 and the martingale constant; the
            # detector would never alarm and would look like it was working.
            raise ValueError("epsilon must be in (0, 1)")

        self._c0 = _normalize(np.asarray(contract_centroid, dtype=float))
        self._centroid = self._c0.copy()
        self._calibration = list(calibration_residuals)
        self.delta = delta
        self.epsilon = epsilon
        self.eta = eta
        self.cusum_kappa = cusum_kappa
        self.cusum_h = cusum_h
        self.calibration_is_synthetic = calibration_is_synthetic

        # Tracked in log space. A martingale over hundreds of messages
        # underflows float64 quickly when p-values are large, and an alarm that
        # never fires because the product rounded to zero is indistinguishable
        # from an alarm that correctly did not fire.
        self._log_martingale = 0.0
        self._cusum = 0.0
        self.state = DriftState()

    # ── properties ────────────────────────────────────────────────────

    @property
    def log_alarm_threshold(self) -> float:
        return math.log(1.0 / self.delta)

    @property
    def calibration_n(self) -> int:
        return len(self._calibration)

    @property
    def coverage_note(self) -> str:
        """What the reported delta actually means, in words, for this instance."""
        if self.calibration_is_synthetic:
            return (
                f"delta={self.delta} is nominal against a SYNTHETIC calibration set of "
                f"n={self.calibration_n}. This is not a measured false-alarm rate and must not "
                "be published as one."
            )
        return (
            f"delta={self.delta} is anytime-valid under exchangeability with the calibration "
            f"set (n={self.calibration_n}). On data drawn from a different distribution than "
            "the calibration set it is an approximation whose error must be measured."
        )

    # ── the sequential update ─────────────────────────────────────────

    def observe_residual(self, residual: float, embedding: Sequence[float] | None = None) -> DriftStep:
        """Feed one message's residual, and optionally its embedding.

        The embedding is only needed to advance the cumulative-drift statistic
        D_t; the alarm itself rests on the residual stream. It is optional so
        the detector can be tested and evaluated on residual sequences alone.
        """
        index = len(self.state.steps)

        p = conformal_p_value(self._calibration, residual)
        # log(epsilon * p^(epsilon-1)) = log(epsilon) + (epsilon-1)*log(p)
        self._log_martingale += math.log(self.epsilon) + (self.epsilon - 1.0) * math.log(p)

        if self.cusum_kappa is not None:
            self._cusum = max(0.0, self._cusum + (residual - self.cusum_kappa))

        if embedding is not None:
            e = np.asarray(embedding, dtype=float)
            self._centroid = _normalize(self._centroid + self.eta * e)
        cumulative_drift = 1.0 - _cosine(self._centroid, self._c0)

        alarmed = False
        reason = AlarmReason.NONE
        if self._log_martingale > self.log_alarm_threshold:
            alarmed, reason = True, AlarmReason.MARTINGALE
        elif self.cusum_h is not None and self._cusum > self.cusum_h:
            alarmed, reason = True, AlarmReason.CUSUM

        step = DriftStep(
            index=index,
            residual=residual,
            p_value=p,
            log_martingale=self._log_martingale,
            cusum=self._cusum,
            cumulative_drift=cumulative_drift,
            alarmed=alarmed,
            reason=reason,
        )
        self.state.steps.append(step)

        # First alarm only. The martingale can cross and re-cross; the detection
        # delay reported in the evaluation is measured from the first crossing,
        # and overwriting it with a later one would flatter the result.
        if alarmed and self.state.alarmed_at is None:
            self.state.alarmed_at = index
            self.state.alarm_reason = reason

        return step

    def detection_delay(self, onset_index: int) -> int | None:
        """Messages from the labelled drift onset to the first alarm.

        None when no alarm fired — which is a miss, not a delay of zero, and the
        evaluation must not average it in as though it were a fast detection.
        """
        if self.state.alarmed_at is None:
            return None
        return self.state.alarmed_at - onset_index

    def ledger_record(self, contract_id: str, genesis_hash: str) -> dict:
        """The detector's own audit trail, shaped for the Merkle ledger.

        Anchoring the decision to H0 is what lets a disputed scope flag be
        re-derived later against a specific contract version. Without it the
        detector's output is an assertion; with it, it is evidence.
        """
        last = self.state.steps[-1] if self.state.steps else None
        return {
            "contractId": contract_id,
            "genesisHash": genesis_hash,
            "messagesObserved": len(self.state.steps),
            "alarmed": self.state.alarmed,
            "alarmedAt": self.state.alarmed_at,
            "alarmReason": self.state.alarm_reason,
            "delta": self.delta,
            "epsilon": self.epsilon,
            "calibrationN": self.calibration_n,
            "calibrationIsSynthetic": self.calibration_is_synthetic,
            "logMartingale": None if last is None else round(last.log_martingale, 6),
            "cusum": None if last is None else round(last.cusum, 6),
            "cumulativeDrift": None if last is None else round(last.cumulative_drift, 6),
            "residual": None if last is None else round(last.residual, 6),
            "pValue": None if last is None else round(last.p_value, 6),
        }
