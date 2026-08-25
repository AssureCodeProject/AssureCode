"""FastAPI application entrypoint for the AssureCode scope guard.

Objective 3: a RAG mediator that monitors client-freelancer communications and
prevents scope creep by anchoring requests against the original hashed contract.

How a decision is made
----------------------
1. Resolve H0, the contract's genesis ledger hash. Without it there is no
   verifiable contract to judge against, and the request is refused rather than
   answered from an unanchored comparison.
2. Embed the incoming message with the same model used to embed the contract
   chunks at ingest time.
3. Retrieve the top-k contract chunks by cosine similarity.
4. Decide from the best retrieved similarity against a documented threshold.
5. Record the decision against H0, so it can be audited and so the trust score
   has a real adherence figure to draw on.
6. Return the decision together with H0 and the evidence it rests on.

What this replaced
------------------
The previous implementation matched eight hardcoded regexes ("for free",
"add mobile app", ...) and returned the literal constant 0.32 when one hit and
0.89 when none did. No embedding, no retrieval, and no contract: the same
message scored identically for every contract in the system, and the
"similarity_score" was not a similarity of anything.

Scope of the check
------------------
This is a per-message threshold test: does *this* request resemble the contract?
It cannot detect cumulative drift, where twenty individually-plausible requests
add up to a different product. That limitation is inherent to per-message
thresholding and is the subject of separate work; it is stated here so the
endpoint is not mistaken for something stronger than it is.
"""
from __future__ import annotations

from datetime import UTC, datetime

from fastapi import Depends, FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

from app.deps import (
    Embedder,
    LedgerAnchorUnavailable,
    RagStore,
    RagStoreUnavailable,
    ScopeDecisionRecord,
    ScopeLogUnavailable,
    get_drift_calibration,
    get_embedder,
    get_ledger_anchor,
    get_rag_store,
    get_scope_log,
    get_settings,
)
from app.ports.readiness import build_readiness, check_embedder, check_postgres
from app.ports.service_auth import assert_configured, verify_service_token
from app.ports.telemetry import (
    make_metrics_middleware,
    metrics_response,
    scope_decisions_total,
)
from app.services.drift_detector import ConformalDriftDetector, NotCalibrated

# `x-service-token` on every route except the probe allow-list. Same single
# definition ai-service uses — app.ports.service_auth resolves to
# apps/ai-service/app/ports/ via the __path__ extension documented in
# app/__init__.py. Declared on the constructor so routes added later are
# protected by default.
#
# Refuse to import at all in production without a real SERVICE_TOKEN. At import
# time rather than on a startup event: the process then fails before it binds a
# port, so an orchestrator sees a crash-looping container instead of a healthy
# one serving unauthenticated traffic.
assert_configured()

app = FastAPI(
    title="AssureCode Scope Guard",
    version="1.0.0a0",
    description="RAG scope mediator: retrieval-backed scope checks anchored to the contract hash.",
    dependencies=[Depends(verify_service_token)],
)

app.middleware("http")(make_metrics_middleware("scope-guard"))


class ScopeCheckRequest(BaseModel):
    contract_id: str = Field(..., description="Target contract ID")
    message: str = Field(..., description="Chat message or requested change content")
    sender: str = Field("client", description="Message sender: 'client' or 'freelancer'")


class RetrievedEvidence(BaseModel):
    chunk_idx: int
    content: str
    similarity: float


class ScopeCheckResponse(BaseModel):
    allowed: bool
    similarity_score: float
    reason: str
    suggested_mediation: str | None = None
    checked_at: str
    # ── anchoring (Objective 3) ──────────────────────────────────
    contract_id: str
    genesis_hash: str
    # ── evidence ─────────────────────────────────────────────────
    threshold: float
    retrieved: list[RetrievedEvidence]
    embedding_model: str


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe. Asserts only that the process can serve HTTP.

    Deliberately dependency-free: a liveness probe that fails on a database
    outage makes the orchestrator restart every replica over a problem no
    restart can fix. Readiness is what should take a degraded pod out of
    rotation — see /readyz.
    """
    return {"status": "ok", "service": "scope-guard", "time": datetime.now(UTC).isoformat()}


@app.get("/readyz")
def readyz(response: Response) -> dict[str, object]:
    """Readiness probe. Answers 503 when a required dependency is unreachable.

    Until this existed the Kubernetes readiness probe pointed at /healthz, so a
    replica that could not resolve H0 or record a scope decision still received
    chat traffic and refused every message it was handed.
    """
    checks: dict[str, object] = {
        "postgres": check_postgres(get_settings().database_url),
        "embedder": check_embedder(get_embedder),
    }

    # Informational, not a gate: deps.py already refuses to start without a
    # calibration file, so reaching this line means one loaded. Surfaced here
    # because "the drift endpoint is answering from synthetic residuals" is
    # something an operator should be able to read off a probe rather than
    # having to infer from a response field.
    try:
        _, synthetic = get_drift_calibration()
        checks["drift_calibration"] = {
            "status": "ok",
            "detail": "synthetic" if synthetic else "measured",
        }
    except Exception as err:
        checks["drift_calibration"] = {
            "status": "not_configured",
            "detail": f"{type(err).__name__}: {str(err)[:200]}",
        }

    body, status = build_readiness("scope-guard", checks)
    response.status_code = status
    return body


@app.get("/metrics")
def metrics():
    """Prometheus exposition. Unauthenticated — see service_auth.PUBLIC_PATHS."""
    return metrics_response()


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "assurecode-scope-guard", "status": "active", "version": "1.0.0a0"}


class DriftStepOut(BaseModel):
    index: int
    residual: float
    p_value: float
    log_martingale: float
    cumulative_drift: float
    alarmed: bool


class DriftAssessment(BaseModel):
    contract_id: str
    genesis_hash: str
    messages_observed: int
    alarmed: bool
    alarmed_at: int | None
    alarm_reason: str
    delta: float
    epsilon: float
    calibration_n: int
    calibration_is_synthetic: bool
    coverage_note: str
    steps: list[DriftStepOut]
    ledger_payload: dict


@app.get("/scope/drift/{contract_id}", response_model=DriftAssessment)
def assess_drift(
    contract_id: str,
    anchor=Depends(get_ledger_anchor),
    scope_log=Depends(get_scope_log),
) -> DriftAssessment:
    """Cumulative scope-drift assessment over a contract's recorded decisions.

    This is the C1 detector applied to the sequence the scope guard has already
    written down, rather than a parallel stream of its own. Two consequences
    worth stating: the assessment is reproducible by anyone with read access to
    scope_checks, and it cannot disagree with the per-message decisions, because
    it is computed from them.

    The endpoint does not itself write to the ledger. It returns `ledger_payload`
    for the gateway to anchor, so the RFC 8785 canonical serializer stays a
    single implementation in TypeScript — a second one here could disagree, and
    a hash chain with two serializers is the defect Phase 8 removed.
    """
    settings = get_settings()

    # Anchor first, for the same reason /scope/check does: an assessment that
    # cannot name the contract version it was made against is not auditable.
    try:
        contract_anchor = anchor.genesis(contract_id)
    except LedgerAnchorUnavailable as err:
        raise HTTPException(status_code=409, detail=str(err)) from err

    calibration, synthetic = get_drift_calibration()
    if not calibration:
        # The honest failure. There is no T2 calibration set yet (Phase 7), and
        # a martingale run against a default would report a false-alarm rate for
        # a distribution nobody measured — indistinguishable in this response
        # from a real one.
        raise HTTPException(
            status_code=503,
            detail=(
                "No drift calibration set is configured, so no anytime-valid false-alarm rate "
                "can be reported. The conformal guarantee requires calibration residuals from "
                "known in-scope traffic (the T2 set). Set SCOPE_DRIFT_CALIBRATION_PATH. "
                "Refusing to return an alarm whose delta would describe nothing."
            ),
        )

    try:
        residuals = scope_log.residuals(contract_id)
    except ScopeLogUnavailable as err:
        raise HTTPException(status_code=503, detail=f"Scope decision log unavailable: {err}") from err

    if not residuals:
        raise HTTPException(
            status_code=409,
            detail=(
                f"No scope decisions are recorded for {contract_id}. Drift is a property of a "
                "sequence; there is no sequence to assess."
            ),
        )

    # The contract centroid would normally anchor the cumulative-drift term. The
    # embeddings of past messages are not retained (only their similarities are),
    # so D_t is not computed here and the alarm rests on the residual stream —
    # which is what carries the guarantee. Stated rather than silently omitted.
    try:
        detector = ConformalDriftDetector(
            contract_centroid=[1.0],
            calibration_residuals=calibration,
            delta=settings.drift_delta,
            epsilon=settings.drift_epsilon,
            calibration_is_synthetic=synthetic,
        )
    except NotCalibrated as err:
        raise HTTPException(status_code=503, detail=str(err)) from err

    for residual in residuals:
        detector.observe_residual(residual)

    state = detector.state
    return DriftAssessment(
        contract_id=contract_id,
        genesis_hash=contract_anchor.genesis_hash,
        messages_observed=len(state.steps),
        alarmed=state.alarmed,
        alarmed_at=state.alarmed_at,
        alarm_reason=state.alarm_reason,
        delta=detector.delta,
        epsilon=detector.epsilon,
        calibration_n=detector.calibration_n,
        calibration_is_synthetic=detector.calibration_is_synthetic,
        coverage_note=detector.coverage_note,
        steps=[
            DriftStepOut(
                index=s.index,
                residual=round(s.residual, 6),
                p_value=round(s.p_value, 6),
                log_martingale=round(s.log_martingale, 6),
                cumulative_drift=round(s.cumulative_drift, 6),
                alarmed=s.alarmed,
            )
            for s in state.steps
        ],
        ledger_payload=detector.ledger_record(contract_id, contract_anchor.genesis_hash),
    )


@app.post("/scope/check", response_model=ScopeCheckResponse)
def check_scope(
    req: ScopeCheckRequest,
    embedder: Embedder = Depends(get_embedder),
    store: RagStore = Depends(get_rag_store),
    anchor=Depends(get_ledger_anchor),
    scope_log=Depends(get_scope_log),
) -> ScopeCheckResponse:
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    settings = get_settings()

    # 1. Anchor first. A decision that cannot name the contract version it was
    #    made against is not auditable, which is the whole point of Objective 3.
    try:
        contract_anchor = anchor.genesis(req.contract_id)
    except LedgerAnchorUnavailable as err:
        raise HTTPException(status_code=409, detail=str(err)) from err

    # 2. Embed the message.
    query_vector = embedder.embed(req.message)

    # 3. Retrieve.
    try:
        retrieved = store.search(
            req.contract_id, query_vector.tolist(), k=settings.retrieval_k
        )
    except RagStoreUnavailable as err:
        # 503, never a permissive default. An unreachable corpus is not
        # evidence that a request is in scope.
        raise HTTPException(status_code=503, detail=f"Scope corpus unavailable: {err}") from err

    if not retrieved:
        raise HTTPException(
            status_code=409,
            detail=(
                f"No contract text indexed for {req.contract_id}. The scope guard has nothing "
                "to compare against; ingest the contract requirements before checking scope."
            ),
        )

    # 4. Decide on the best match.
    best = max(r.similarity for r in retrieved)
    allowed = best >= settings.scope_threshold

    # Counted by outcome only. The label is the decision, not its correctness —
    # this cannot tell you the false-negative rate, and given the measured
    # recall of 0.20 the gap between the two is large. Deliberately not labelled
    # by contract: that would be unbounded cardinality.
    scope_decisions_total.labels(allowed=str(allowed).lower()).inc()

    if allowed:
        reason = (
            f"Request matches indexed contract requirements "
            f"(best similarity {best:.3f} >= threshold {settings.scope_threshold:.3f})."
        )
        mediation = None
    else:
        reason = (
            f"Request does not match the agreed contract requirements "
            f"(best similarity {best:.3f} < threshold {settings.scope_threshold:.3f})."
        )
        mediation = (
            "Scope Guard alert: this request does not resemble the requirements anchored at "
            f"contract hash {contract_anchor.genesis_hash[:16]}…. To proceed, raise a scope "
            "amendment or a milestone addendum so the change is priced and recorded."
        )

    # 5. Record it. A scope decision that leaves no trace cannot be audited
    #    against H0 later, and the trust score's adherence term would be
    #    computed over an incomplete history without anyone being able to tell.
    #    The write is therefore part of the request, not a side effect of it: if
    #    it fails the caller is told, rather than receiving a decision that the
    #    system has already lost.
    try:
        scope_log.record(
            ScopeDecisionRecord(
                contract_id=req.contract_id,
                sender=req.sender,
                message=req.message,
                allowed=allowed,
                similarity=best,
                threshold=settings.scope_threshold,
                genesis_hash=contract_anchor.genesis_hash,
            )
        )
    except ScopeLogUnavailable as err:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Scope decision computed (allowed={allowed}, similarity={best:.4f}) but could "
                f"not be recorded: {err}. Refusing to return an unrecorded decision."
            ),
        ) from err

    return ScopeCheckResponse(
        allowed=allowed,
        similarity_score=round(best, 4),
        reason=reason,
        suggested_mediation=mediation,
        checked_at=datetime.now(UTC).isoformat(),
        contract_id=req.contract_id,
        genesis_hash=contract_anchor.genesis_hash,
        threshold=settings.scope_threshold,
        retrieved=[
            RetrievedEvidence(
                chunk_idx=r.chunk_idx,
                content=r.content[:400],
                similarity=round(r.similarity, 4),
            )
            for r in retrieved
        ],
        embedding_model=settings.embed_model_name
        if settings.embed_provider != "fake"
        else "fake-hash-embedder",
    )
