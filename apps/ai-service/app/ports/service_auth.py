"""Shared service-to-service authentication for the Python services.

Threat T8 in docs/THREAT_MODEL.md. Both `ai-service` and `scope-guard`
registered every router with no auth dependency at all. In Kubernetes the only
control was `infra/k8s/14-network-policies.yaml`; under docker-compose there was
no control whatsoever, so anything on the network could invoke the XAI scorer,
the security scanner or the scope guard directly.

This lives in `app/ports/` because that is the namespace `apps/scope-guard`
deliberately falls through to — see the docstring in
`apps/scope-guard/app/__init__.py`, which extends `__path__` so that names it
does not itself define resolve against ai-service. One definition of the check,
used by both services.

Design notes
------------

*Shared secret, not JWT.* These services are only ever called by the gateway and
by the CI/verification harnesses, all of which already hold `SERVICE_TOKEN`.
There is no end-user identity to carry here, and minting a second JWT trust root
for machine callers would be more surface, not less. This is the same
`x-service-token` header `apps/api-gateway/src/middleware/auth.ts` accepts.

*Constant-time comparison.* `secrets.compare_digest`, not `==`. Token comparison
with `==` short-circuits on the first differing byte and leaks the prefix length
through timing.

*Probes stay open.* `/healthz` and `/metrics` are exempt. A kubelet probe cannot
present a token, and a liveness check that 401s restart-loops the pod.

*Fails closed in production, open in development.* With no `SERVICE_TOKEN` set,
production refuses to start rather than serve unauthenticated — a security
control that silently disables itself when misconfigured is worse than none,
because it reports success. Outside production an unset token disables the check
so the offline stack and the test suites keep working without ceremony.
"""
from __future__ import annotations

import os
import secrets

from fastapi import HTTPException, Request

#: Header the gateway and the harnesses already send.
SERVICE_TOKEN_HEADER = "x-service-token"

#: Paths served without authentication. Probes and scrape targets only.
PUBLIC_PATHS: frozenset[str] = frozenset(
    {
        "/healthz",
        "/readyz",
        "/metrics",
        "/",
        # FastAPI's own docs. Harmless and useful locally; if you object to them
        # being reachable in a deployment, disable them at the FastAPI()
        # constructor rather than by removing them here, so the app does not
        # serve a 401 for a route it still advertises.
        "/docs",
        "/redoc",
        "/openapi.json",
    }
)

#: Placeholder values that must never be accepted as a real token. Mirrors the
#: list in packages/config/src/secrets.ts so the two tiers agree on what counts
#: as "not actually configured".
_PLACEHOLDERS: frozenset[str] = frozenset(
    {
        "",
        "REPLACE_ME",
        "changeme",
        "change_me",
        "dev_insecure_service_token_change_me",
    }
)


def _is_placeholder(token: str) -> bool:
    return token.strip() in _PLACEHOLDERS or token.strip().startswith("dev_insecure_")


def _is_production() -> bool:
    return os.environ.get("NODE_ENV", os.environ.get("ENVIRONMENT", "development")) == "production"


def _is_test() -> bool:
    return os.environ.get("NODE_ENV", os.environ.get("ENVIRONMENT", "development")) == "test"


class ServiceAuthMisconfigured(RuntimeError):
    """Raised at import/startup when production has no usable SERVICE_TOKEN."""


def assert_configured() -> None:
    """Fail fast at startup if production cannot enforce the check.

    Called from each service's FastAPI startup. Deliberately raises rather than
    logging a warning: a warning in a container log is not a control.
    """
    if not _is_production():
        return

    token = os.environ.get("SERVICE_TOKEN", "")
    if _is_placeholder(token):
        raise ServiceAuthMisconfigured(
            "SERVICE_TOKEN is unset or still a placeholder while NODE_ENV=production. "
            "This service would accept unauthenticated calls to the scorer, the "
            "security scanner and the scope guard. Set a real SERVICE_TOKEN."
        )


def verify_service_token(request: Request) -> None:
    """FastAPI dependency: require a valid `x-service-token`.

    Applied once per app via `dependencies=[Depends(verify_service_token)]` on
    the FastAPI constructor, so a route added later is protected by default —
    the opposite of decorating each router, where the failure mode of forgetting
    is an open endpoint.
    """
    if request.url.path in PUBLIC_PATHS:
        return

    expected = os.environ.get("SERVICE_TOKEN", "")

    # Unconfigured outside production: check disabled, and it is the caller's
    # environment that says so, not a fallback buried in a handler.
    if _is_placeholder(expected):
        if _is_production():
            # assert_configured() should have stopped startup; refuse anyway
            # rather than let a late-set empty value open the service.
            raise HTTPException(
                status_code=503,
                detail="Service authentication is not configured.",
            )
        return

    presented = request.headers.get(SERVICE_TOKEN_HEADER, "")
    if not presented or not secrets.compare_digest(presented, expected):
        raise HTTPException(
            status_code=401,
            detail="Missing or invalid service token.",
            headers={"WWW-Authenticate": SERVICE_TOKEN_HEADER},
        )
