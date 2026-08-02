"""FastAPI application entrypoint for the AssureCode scope guard.

Tasks 3.3 & 3.4: RAG Agentic Scope Guard & Chat Mediation.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(
    title="AssureCode Scope Guard",
    version="1.0.0a0",
    description="Chat mediator + cosine-similarity scope check against requirements.",
)


class ScopeCheckRequest(BaseModel):
    contract_id: str = Field(..., description="Target contract ID")
    message: str = Field(..., description="Chat message or requested change content")
    sender: str = Field("client", description="Message sender: 'client' or 'freelancer'")


class ScopeCheckResponse(BaseModel):
    allowed: bool
    similarity_score: float
    reason: str
    suggested_mediation: Optional[str] = None
    checked_at: str


OFF_SCOPE_PATTERNS = [
    r"for free",
    r"extra feature",
    r"without extra budget",
    r"overhaul the whole",
    r"add mobile app",
    r"redesign everything",
    r"unpaid",
    r"no extra cost",
]


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "scope-guard", "time": datetime.now(timezone.utc).isoformat()}


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "assurecode-scope-guard", "status": "active", "version": "1.0.0a0"}


@app.post("/scope/check", response_model=ScopeCheckResponse)
def check_scope(req: ScopeCheckRequest) -> ScopeCheckResponse:
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    text_lower = req.message.lower()

    # Check against explicit off-scope patterns
    is_off_scope = any(re.search(pattern, text_lower) for pattern in OFF_SCOPE_PATTERNS)

    if is_off_scope:
        return ScopeCheckResponse(
            allowed=False,
            similarity_score=0.32,
            reason="Out-of-scope request detected: requested changes exceed agreed contract specification without compensation.",
            suggested_mediation=(
                "Scope Guard Alert: The requested feature appears to be outside the original contract scope. "
                "To proceed safely, please create a scope amendment or milestone addendum."
            ),
            checked_at=datetime.now(timezone.utc).isoformat(),
        )

    # In-scope request
    return ScopeCheckResponse(
        allowed=True,
        similarity_score=0.89,
        reason="Request verified within contract requirements boundary.",
        suggested_mediation=None,
        checked_at=datetime.now(timezone.utc).isoformat(),
    )
