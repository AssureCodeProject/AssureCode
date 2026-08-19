"""Routes under /match — the NLP matchmaker's HTTP face.

POST /match → ranked freelancers for a requirements string, with XAI breakdown.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.deps import get_matchmaker
from app.services.matchmaker import Matchmaker, MatchResult

router = APIRouter(prefix="/match", tags=["match"])


class MatchRequest(BaseModel):
    requirements: str = Field(..., min_length=1, max_length=8000)
    top_k: int = Field(default=5, ge=1, le=20)


class ExplanationModel(BaseModel):
    skill_score: float
    trust_score: float
    history_score: float
    network_score: float
    matched_skills: list[str]


class MatchItem(BaseModel):
    freelancer_id: str
    freelancer_name: str
    trust_score: float
    score: float
    explanation: ExplanationModel
    hourly_rate_cents: int


class MatchResponse(BaseModel):
    results: list[MatchItem]
    count: int


def _to_item(r: MatchResult) -> MatchItem:
    return MatchItem(
        freelancer_id=r.freelancer_id,
        freelancer_name=r.freelancer_name,
        trust_score=r.trust_score,
        score=r.score,
        explanation=ExplanationModel(
            skill_score=r.explanation.skill_score,
            trust_score=r.explanation.trust_score,
            history_score=r.explanation.history_score,
            network_score=r.explanation.network_score,
            matched_skills=list(r.explanation.matched_skills),
        ),
        hourly_rate_cents=r.hourly_rate_cents,
    )


@router.post("", response_model=MatchResponse)
def match(req: MatchRequest, mm: Matchmaker = Depends(get_matchmaker)) -> MatchResponse:
    results = mm.match(req.requirements, top_k=req.top_k)
    return MatchResponse(results=[_to_item(r) for r in results], count=len(results))
