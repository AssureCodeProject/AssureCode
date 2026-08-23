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

from fastapi import Depends, FastAPI, Response

from app.ports.readiness import build_readiness, check_postgres
from app.ports.service_auth import assert_configured, verify_service_token
from app.ports.telemetry import make_metrics_middleware, metrics_response
from app.routes import embed as embed_routes
from app.routes import ledger_sign as ledger_sign_routes
from app.routes import match as match_routes
from app.routes import rag as rag_routes
from app.routes import security_scan as security_scan_routes
from app.routes import test_gen as test_gen_routes
from app.routes import xai as xai_routes
from app.settings import get_settings

# `x-service-token` on every route except the probe allow-list in
# service_auth.PUBLIC_PATHS. Declared on the constructor rather than on each
# router: a route added later is then protected by default, whereas per-router
# decoration fails open when somebody forgets one. Until this existed, anything
# that could reach :8000 could invoke the XAI scorer and the security scanner
# directly — in docker-compose, that was anything on the network.
#
# Refuse to import at all in production without a real SERVICE_TOKEN. At import
# time rather than on a startup event: the process then fails before it binds a
# port, so an orchestrator sees a crash-looping container instead of a healthy
# one serving unauthenticated traffic.
assert_configured()

app = FastAPI(
    title="AssureCode AI Service",
    version="1.0.0a0",
    description="NLP matchmaker, test generation, security audit, RAG, and XAI judge.",
    dependencies=[Depends(verify_service_token)],
)

app.middleware("http")(make_metrics_middleware("ai-service"))

app.include_router(embed_routes.router)
app.include_router(match_routes.router)
app.include_router(ledger_sign_routes.router)
app.include_router(rag_routes.router)
app.include_router(security_scan_routes.router)
app.include_router(test_gen_routes.router)
app.include_router(xai_routes.router)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe. Asserts only that the process can serve HTTP.

    Deliberately dependency-free: a liveness probe that fails on a database
    outage makes the orchestrator restart every replica over a problem no
    restart can fix. Readiness is what should take a degraded pod out of
    rotation — see /readyz.
    """
    return {"status": "ok", "service": "ai-service", "time": datetime.now(UTC).isoformat()}


@app.get("/readyz")
def readyz(response: Response) -> dict[str, object]:
    """Readiness probe. Answers 503 when a required dependency is unreachable.

    Until this existed the Kubernetes readiness probe pointed at /healthz, so a
    replica with no database still received traffic and failed every request it
    was handed.
    """
    body, status = build_readiness(
        "ai-service",
        {"postgres": check_postgres(get_settings().database_url)},
    )
    response.status_code = status
    return body


@app.get("/metrics")
def metrics():
    """Prometheus exposition. Unauthenticated — see service_auth.PUBLIC_PATHS."""
    return metrics_response()


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "assurecode-ai-service",
        "status": "ok",
        "endpoints": "/healthz, POST /embed, POST /embed/batch, POST /match, POST /rag/ingest, POST /generate-tests",
    }
