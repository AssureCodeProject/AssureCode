"""FastAPI route for Explainable AI (XAI) Trust Scoring (Sprint 4).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.deps import get_graph_repo
from app.ports.graph_repo import GraphRepo

router = APIRouter(prefix="/xai", tags=["xai"])


class TelemetryData(BaseModel):
    maintainability: float = Field(default=85.0, ge=0.0, le=100.0)
    cyclomatic_complexity: int = Field(default=5, ge=1)
    passed_tests: int = Field(default=5, ge=0)
    total_tests: int = Field(default=5, ge=1)
    vulnerabilities: int = Field(default=0, ge=0)
    chat_sentiment: float = Field(default=0.9, ge=0.0, le=1.0)


class XaiScoreRequest(BaseModel):
    contract_id: str = Field(..., min_length=1)
    freelancer_id: str = Field(..., min_length=1)
    telemetry: TelemetryData = Field(default_factory=TelemetryData)


class XaiScoreResponse(BaseModel):
    contract_id: str
    freelancer_id: str
    trust_score: float
    justifications: List[str]
    scored_at: str


@router.post("/score", response_model=XaiScoreResponse)
def calculate_xai_score(
    req: XaiScoreRequest,
    graph_repo: GraphRepo = Depends(get_graph_repo),
) -> XaiScoreResponse:
    tel = req.telemetry

    # Weighted score calculation
    test_score = tel.passed_tests / tel.total_tests if tel.total_tests > 0 else 0.0
    maint_score = tel.maintainability / 100.0
    security_score = 1.0 if tel.vulnerabilities == 0 else max(0.0, 1.0 - tel.vulnerabilities * 0.25)
    sentiment_score = tel.chat_sentiment

    trust_score = round(0.40 * test_score + 0.25 * maint_score + 0.20 * security_score + 0.15 * sentiment_score, 2)

    # Persist updated Freelancer.XAI_Trust_Score to Neo4j / Graph Repo
    if hasattr(graph_repo, "update_trust_score"):
        graph_repo.update_trust_score(req.freelancer_id, trust_score)

    justifications = [
        f"CI Pass Rate: {tel.passed_tests}/{tel.total_tests} tests passed ({(test_score*100):.0f}%).",
        f"Code Quality: Maintainability index scored {tel.maintainability:.0f}/100.",
        f"Security Audit: {tel.vulnerabilities} vulnerabilities detected.",
        f"Communication: Sentiment index scored {tel.chat_sentiment:.2f}/1.00.",
    ]

    return XaiScoreResponse(
        contract_id=req.contract_id,
        freelancer_id=req.freelancer_id,
        trust_score=trust_score,
        justifications=justifications,
        scored_at=datetime.now(timezone.utc).isoformat(),
    )
