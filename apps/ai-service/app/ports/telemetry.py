"""Prometheus metrics for the Python services.

The Node tier has exposed `/metrics` since packages/telemetry was written.
`ai-service` and `scope-guard` exposed nothing at all, so the two slowest and
most interesting operations in the system — embedding + retrieval on a scope
check, and the matchmaker's ranking pass — were invisible to Prometheus. Every
latency figure in the reports had to come from a client-side harness measuring
the gateway, which cannot separate "the model is slow" from "the network is".

Placed in `app/ports/` for the same reason as `service_auth`: that is the
namespace `apps/scope-guard` falls through to (see the docstring in
`apps/scope-guard/app/__init__.py`), so both services share one definition of
the metric names. Two services publishing differently-named versions of the same
measurement is how a dashboard ends up lying.

Label discipline
----------------
No `contract_id`, `freelancer_id`, or message text anywhere. Those are unbounded
label values, and unbounded cardinality is the standard way to take a Prometheus
server down. This mirrors the reasoning already recorded in
`packages/telemetry/src/metrics.ts`; per-contract detail belongs in traces.

`route` is taken from the matched *route template* rather than the request path
for the same reason — `/scope/drift/{contract_id}` is one series, while the raw
path would be one series per contract.

Tracing
-------
Still absent. OpenTelemetry spans would need
`opentelemetry-instrumentation-fastapi` and a working exporter in both images;
metrics answer "how slow, how often, how many failures" without that dependency.
The Node services do emit spans, so a trace crossing into a Python service
currently stops at the boundary. Stated so it is not mistaken for working.
"""
from __future__ import annotations

import time
from collections.abc import Awaitable, Callable

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Histogram,
    generate_latest,
)
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response

#: A dedicated registry rather than the global default. The default collects
#: process- and GC-level collectors from any library that happens to import
#: prometheus_client, which makes what this service exports depend on its
#: transitive dependency graph.
REGISTRY = CollectorRegistry()

#: Buckets tuned to what these endpoints actually do. The default Prometheus
#: buckets top out at 10s, which is fine, but they are far too coarse below
#: 100ms — and an embed call on a warm model is 20-80ms, so nearly every
#: observation would land in a single bucket and the p50 would be unusable.
_LATENCY_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0)

http_requests_total = Counter(
    "assurecode_http_requests_total",
    "HTTP requests handled, by route template, method and status class.",
    ["service", "route", "method", "status"],
    registry=REGISTRY,
)

http_request_duration_seconds = Histogram(
    "assurecode_http_request_duration_seconds",
    "Wall-clock time to handle a request, by route template.",
    ["service", "route", "method"],
    buckets=_LATENCY_BUCKETS,
    registry=REGISTRY,
)

scope_decisions_total = Counter(
    "assurecode_scope_decisions_total",
    "Scope-guard decisions by outcome. `allowed` is the decision, not its correctness.",
    ["allowed"],
    registry=REGISTRY,
)

llm_calls_total = Counter(
    "assurecode_llm_calls_total",
    "Calls to the LLM provider by outcome. `unavailable` counts LlmUnavailableError.",
    ["operation", "outcome"],
    registry=REGISTRY,
)

embedding_duration_seconds = Histogram(
    "assurecode_embedding_duration_seconds",
    "Time to embed a batch. The dominant cost in a scope check and a match.",
    ["provider"],
    buckets=_LATENCY_BUCKETS,
    registry=REGISTRY,
)


def _route_template(request: Request) -> str:
    """The matched route's path template, or a constant for unmatched paths.

    Falls back to "<unmatched>" rather than the raw path: a 404 flood against
    random URLs would otherwise create a new time series per URL, which is
    exactly the cardinality failure this module is trying to avoid.
    """
    route = request.scope.get("route")
    path_format = getattr(route, "path_format", None) or getattr(route, "path", None)
    return path_format if isinstance(path_format, str) else "<unmatched>"


def _status_class(status_code: int) -> str:
    """`2xx`, `4xx`, … — four series instead of one per distinct status code."""
    return f"{status_code // 100}xx"


def make_metrics_middleware(service: str) -> Callable:
    """Build the ASGI middleware that records every request.

    `service` is a label rather than a separate metric name so a dashboard can
    sum across services or break down by one, without a recording rule.
    """

    async def metrics_middleware(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        # The scrape endpoint is excluded: counting it inflates the request rate
        # by the scrape interval and it is not application traffic.
        if request.url.path == "/metrics":
            return await call_next(request)

        started = time.perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        except Exception:
            # An unhandled exception is a 5xx from the caller's point of view and
            # must be counted as one; without this the error rate reads zero for
            # exactly the failures that matter most.
            raise
        finally:
            elapsed = time.perf_counter() - started
            route = _route_template(request)
            http_requests_total.labels(
                service=service,
                route=route,
                method=request.method,
                status=_status_class(status_code),
            ).inc()
            http_request_duration_seconds.labels(
                service=service, route=route, method=request.method
            ).observe(elapsed)

    return metrics_middleware


def metrics_response() -> Response:
    """Prometheus exposition for the `/metrics` route."""
    return PlainTextResponse(
        generate_latest(REGISTRY).decode("utf-8"),
        media_type=CONTENT_TYPE_LATEST,
    )
