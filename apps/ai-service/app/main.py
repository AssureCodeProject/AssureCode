"""FastAPI application entrypoint for the AssureCode AI service.

Sprint 1 wires the real ports:
  - POST /embed, /embed/batch  (embedding port, task 1.3)
  - POST /match                (NLP matchmaker, task 1.4)
  - POST /rag/ingest           (RAG chunk store, task 1.5)
  - POST /generate-tests       (LLM test-gen + S3 upload, task 1.6)
Later sprints add /security-scan (2.6), /score (4.2).
"""
from __future__ import annotations

from datetime import UTC, datetime

from fastapi import FastAPI

from app.routes import embed as embed_routes
from app.routes import match as match_routes
from app.routes import rag as rag_routes
from app.routes import security_scan as security_scan_routes
from app.routes import test_gen as test_gen_routes
from app.routes import xai as xai_routes

app = FastAPI(
    title="AssureCode AI Service",
    version="1.0.0a0",
    description="NLP matchmaker, test generation, security audit, RAG, and XAI judge.",
)

app.include_router(embed_routes.router)
app.include_router(match_routes.router)
app.include_router(rag_routes.router)
app.include_router(security_scan_routes.router)
app.include_router(test_gen_routes.router)
app.include_router(xai_routes.router)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe used by docker-compose healthchecks."""
    return {"status": "ok", "service": "ai-service", "time": datetime.now(UTC).isoformat()}


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "assurecode-ai-service",
        "status": "ok",
        "endpoints": "/healthz, POST /embed, POST /embed/batch, POST /match, POST /rag/ingest, POST /generate-tests",
    }
