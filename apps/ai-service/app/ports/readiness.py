"""Readiness probing shared by ai-service and scope-guard.

Both services previously pointed their Kubernetes readiness *and* liveness
probes at `/healthz`, which returns a literal `{"status": "ok"}` and touches
nothing. That makes readiness meaningless: a pod whose database is unreachable
answers `/healthz` happily, so the orchestrator keeps routing requests to it and
every one of them fails. Readiness is supposed to be the signal that takes a
degraded replica out of rotation, and it could not do that.

`/readyz` here probes the dependency the service genuinely cannot work without —
Postgres — and reports per-dependency status so a failing probe says *which*
thing is wrong rather than just "not ready".

Liveness must NOT use this. A database outage would make every replica fail its
liveness probe, and the orchestrator would restart every pod, repeatedly, over a
problem no restart can fix. `/healthz` stays the liveness endpoint precisely
because it asserts nothing beyond "the process is running and can serve HTTP".

Lives in ai-service's `app/ports/` because scope-guard has no ports package of
its own and reaches these modules through the deliberate `__path__` extension in
`apps/scope-guard/app/__init__.py` — the same route `ledger_anchor`,
`service_auth` and `telemetry` already travel. See ARCHITECTURE.md.
"""
from __future__ import annotations

from typing import Any

# Probes must not hang a probe endpoint. Kubernetes' own timeoutSeconds would
# fire first, but a socket left waiting on a wedged database holds a worker
# thread, and with `uvicorn --workers 4` a handful of those takes the service
# down for reasons unrelated to the database.
_CONNECT_TIMEOUT_SECONDS = 3


def check_postgres(database_url: str) -> dict[str, Any]:
    """Open a connection and run `SELECT 1`.

    A connection alone is not enough: pgbouncer and some proxies accept a TCP
    connection before the backend is reachable, so a handshake-only check can
    report ready against a database that cannot answer a query.
    """
    if not database_url:
        return {"status": "not_configured", "detail": "DATABASE_URL is empty"}

    try:
        # psycopg v3, matching ledger_anchor.py, rag_store.py and scope_log.py.
        # `psycopg[binary]` is the declared dependency in both pyproject files;
        # the lone psycopg2 import in graph_repo.py is a legacy first-choice
        # that already falls back to this.
        import psycopg

        with (
            psycopg.connect(database_url, connect_timeout=_CONNECT_TIMEOUT_SECONDS) as conn,
            conn.cursor() as cur,
        ):
            cur.execute("SELECT 1")
            cur.fetchone()
        return {"status": "ok"}
    except Exception as err:
        # The class name plus a truncated message: enough to tell a bad password
        # from an unreachable host, without pasting a DSN into a public endpoint.
        return {
            "status": "error",
            "detail": f"{type(err).__name__}: {str(err)[:200]}",
        }


def build_readiness(service: str, checks: dict[str, dict[str, Any]]) -> tuple[dict[str, Any], int]:
    """Combine per-dependency results into a body and an HTTP status.

    `not_configured` is deliberately not a failure. A dependency the deployment
    chose not to wire is a stated configuration, not a fault — and treating it
    as one would keep a legitimately-degraded-by-design deployment permanently
    out of rotation.
    """
    failed = [name for name, result in checks.items() if result["status"] == "error"]
    ready = not failed

    body: dict[str, Any] = {
        "status": "ready" if ready else "not_ready",
        "service": service,
        "checks": checks,
    }
    if failed:
        body["failing"] = failed

    return body, (200 if ready else 503)
