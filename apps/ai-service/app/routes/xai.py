"""Trust score: a deterministic, interpretable linear model over CI telemetry.

Objective 4 requires a Trust Score computed from telemetry, which then triggers
the settlement oracle. Three properties are load-bearing and each is enforced
here rather than assumed:

  deterministic  The same telemetry always produces the same score. There is no
                 model inference, no sampling, and no clock in the arithmetic.
  from telemetry Every term is measured by a pipeline component. No term has a
                 default, because a default is an invented measurement wearing
                 the costume of a real one.
  interpretable  Each term contributes a named, signed amount that sums to the
                 total, and the justification strings report those amounts.

The score
---------
    T = 0.40·S_test + 0.25·S_maint + 0.20·S_sec + 0.15·S_scope       (0-100)

    S_test  = 100 · passed_tests / total_tests
    S_maint = maintainability index from the AST analyzer (already 0-100)
    S_sec   = max(0, 100 - 40·N_c - 20·N_h - 5·N_t)
    S_scope = 100 · allowed_scope_checks / total_scope_checks

S_sec is the published penalty formula. A CRITICAL finding is charged twice —
once at 40 as a critical and again at 5 as part of the total N_t. That is what
the published formula says, so it is what is implemented; the double-count is
documented in security-auditor.ts rather than quietly corrected here, since the
two implementations must agree.

What changed, and why
---------------------
The previous version returned a 0-1 value while the settlement gate compares
against 85, so the gate could never pass. It also had a fourth term called
`chat_sentiment` that no component in the system produced — the gateway posted
the literal 0.95 on every request — and every field carried a flattering
default, so a request with an empty body scored 0.92. That number appeared in
the specification as a result.

The scope term now comes from the recorded scope decisions (see
app/ports/scope_log.py), which are real per-message retrieval outcomes anchored
to the contract's genesis hash.

Unmeasured scope
----------------
A contract with no recorded scope checks has an *unmeasured* fourth term, not a
perfect one. Scoring it 1.0 would hand 15 free points to any contract whose
chat was never checked. Instead the term is dropped and the remaining three
weights are renormalised over 0.85, which leaves the score neutral with respect
to the missing evidence — and `scope_measured: false` says so explicitly in the
response.

This is a known and stated weakness: because an unmeasured term is neutral
rather than penalised, avoiding the chat channel avoids the term. Fixing that
requires treating silence as evidence, which a per-message check cannot do.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.deps import get_graph_repo, get_scope_log
from app.ports.graph_repo import GraphRepo
from app.ports.scope_log import ScopeLogUnavailable

router = APIRouter(prefix="/xai", tags=["xai"])

# Published weights. They must sum to 1.0; the assertion below is a guard
# against an edit that changes one weight and forgets the others.
W_TEST = 0.40
W_MAINT = 0.25
W_SEC = 0.20
W_SCOPE = 0.15
assert abs((W_TEST + W_MAINT + W_SEC + W_SCOPE) - 1.0) < 1e-9


class TelemetryData(BaseModel):
    """Measured CI output. No field has a default — see the module docstring."""

    maintainability: float = Field(..., ge=0.0, le=100.0)
    cyclomatic_complexity: int = Field(..., ge=1)
    passed_tests: int = Field(..., ge=0)
    total_tests: int = Field(..., ge=0)
    total_vulnerabilities: int = Field(..., ge=0)
    critical_vulnerabilities: int = Field(..., ge=0)
    high_vulnerabilities: int = Field(..., ge=0)


class XaiScoreRequest(BaseModel):
    contract_id: str = Field(..., min_length=1)
    freelancer_id: str = Field(..., min_length=1)
    telemetry: TelemetryData


class TermBreakdown(BaseModel):
    """One term of the linear model, with the arithmetic that produced it."""

    name: str
    value: float
    weight: float
    contribution: float
    justification: str


class XaiScoreResponse(BaseModel):
    contract_id: str
    freelancer_id: str
    trust_score: float
    critical_vulnerabilities: int
    scope_measured: bool
    terms: List[TermBreakdown]
    justifications: List[str]
    scored_at: str


def _security_score(total: int, critical: int, high: int) -> float:
    """Published penalty: max(0, 100 - 40·N_c - 20·N_h - 5·N_t)."""
    return max(0.0, 100.0 - 40.0 * critical - 20.0 * high - 5.0 * total)


@router.post("/score", response_model=XaiScoreResponse)
def calculate_xai_score(
    req: XaiScoreRequest,
    graph_repo: GraphRepo = Depends(get_graph_repo),
    scope_log=Depends(get_scope_log),
) -> XaiScoreResponse:
    tel = req.telemetry

    if tel.critical_vulnerabilities + tel.high_vulnerabilities > tel.total_vulnerabilities:
        raise HTTPException(
            status_code=422,
            detail=(
                "critical + high vulnerabilities exceed the total. The counts come from one "
                "scan and cannot disagree; refusing to score inconsistent telemetry."
            ),
        )

    # A pipeline that ran no tests has not demonstrated anything. 0/0 is
    # indeterminate, not a pass — the same contract the sandbox runner keeps.
    if tel.total_tests == 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"No tests were executed for {req.contract_id}. A trust score derived from an "
                "empty test run would assert a verification that never happened."
            ),
        )

    # Adherence is read from the recorded decisions, never accepted from the
    # caller — otherwise the party being scored could supply their own term.
    try:
        adherence = scope_log.adherence(req.contract_id)
    except ScopeLogUnavailable as err:
        raise HTTPException(
            status_code=503,
            detail=f"Scope decision log unavailable, cannot compute the adherence term: {err}",
        )

    s_test = 100.0 * tel.passed_tests / tel.total_tests
    s_maint = tel.maintainability
    s_sec = _security_score(
        tel.total_vulnerabilities, tel.critical_vulnerabilities, tel.high_vulnerabilities
    )
    s_scope: Optional[float] = None if adherence.ratio is None else 100.0 * adherence.ratio

    terms: List[TermBreakdown] = []

    if s_scope is None:
        # Renormalise the measured weights over their own sum so the score stays
        # on 0-100 and the missing evidence is neutral rather than flattering.
        norm = W_TEST + W_MAINT + W_SEC
        w_test, w_maint, w_sec = W_TEST / norm, W_MAINT / norm, W_SEC / norm
    else:
        w_test, w_maint, w_sec = W_TEST, W_MAINT, W_SEC

    terms.append(
        TermBreakdown(
            name="tests",
            value=round(s_test, 2),
            weight=round(w_test, 4),
            contribution=round(w_test * s_test, 2),
            justification=(
                f"CI pass rate: {tel.passed_tests}/{tel.total_tests} hidden tests passed "
                f"({s_test:.0f}%)."
            ),
        )
    )
    terms.append(
        TermBreakdown(
            name="maintainability",
            value=round(s_maint, 2),
            weight=round(w_maint, 4),
            contribution=round(w_maint * s_maint, 2),
            justification=(
                f"Code quality: SEI maintainability index {s_maint:.1f}/100 at cyclomatic "
                f"complexity {tel.cyclomatic_complexity}."
            ),
        )
    )
    terms.append(
        TermBreakdown(
            name="security",
            value=round(s_sec, 2),
            weight=round(w_sec, 4),
            contribution=round(w_sec * s_sec, 2),
            justification=(
                f"Security audit: {tel.critical_vulnerabilities} critical, "
                f"{tel.high_vulnerabilities} high, {tel.total_vulnerabilities} total findings "
                f"-> S_sec {s_sec:.0f}/100."
            ),
        )
    )
    if s_scope is not None:
        terms.append(
            TermBreakdown(
                name="scope_adherence",
                value=round(s_scope, 2),
                weight=W_SCOPE,
                contribution=round(W_SCOPE * s_scope, 2),
                justification=(
                    f"Scope adherence: {adherence.allowed}/{adherence.total} messages matched the "
                    f"anchored contract ({s_scope:.0f}%)."
                ),
            )
        )

    trust_score = round(sum(t.contribution for t in terms), 2)

    justifications = [t.justification for t in terms]
    if s_scope is None:
        justifications.append(
            "Scope adherence: not measured — no scope checks are recorded for this contract. "
            "The term is excluded and the remaining weights renormalised, so this score neither "
            "rewards nor penalises the missing evidence."
        )

    # Persist the score on the freelancer node where the graph repo supports it.
    if hasattr(graph_repo, "update_trust_score"):
        graph_repo.update_trust_score(req.freelancer_id, trust_score)

    return XaiScoreResponse(
        contract_id=req.contract_id,
        freelancer_id=req.freelancer_id,
        trust_score=trust_score,
        critical_vulnerabilities=tel.critical_vulnerabilities,
        scope_measured=s_scope is not None,
        terms=terms,
        justifications=justifications,
        scored_at=datetime.now(timezone.utc).isoformat(),
    )
