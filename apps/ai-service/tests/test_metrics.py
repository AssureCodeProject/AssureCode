"""Tests for the Prometheus endpoint the Python services previously lacked.

The label-cardinality tests are the ones worth keeping: an unbounded label is
the standard way to take a Prometheus server down, and a route template read
from the raw path would produce one time series per contract id.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.ports import telemetry

client = TestClient(app)


class TestMetricsEndpoint:
    def test_metrics_is_served(self):
        res = client.get("/metrics")
        assert res.status_code == 200

    def test_metrics_uses_the_prometheus_exposition_content_type(self):
        res = client.get("/metrics")
        assert "text/plain" in res.headers["content-type"]

    def test_metrics_needs_no_service_token(self):
        # Prometheus scrapes on a fixed interval and cannot present a token;
        # requiring one makes the target permanently down.
        assert "/metrics" in telemetry_public_paths()

    def test_declared_metric_families_are_present(self):
        body = client.get("/metrics").text
        assert "assurecode_http_requests_total" in body
        assert "assurecode_http_request_duration_seconds" in body


def telemetry_public_paths():
    from app.ports import service_auth

    return service_auth.PUBLIC_PATHS


class TestRequestAccounting:
    def test_a_handled_request_is_counted(self):
        before = _counter_value(route="/healthz", status="2xx")
        client.get("/healthz")
        assert _counter_value(route="/healthz", status="2xx") == before + 1

    def test_latency_is_observed_for_a_handled_request(self):
        client.get("/healthz")
        body = client.get("/metrics").text
        assert 'assurecode_http_request_duration_seconds_count{' in body

    def test_the_scrape_endpoint_does_not_count_itself(self):
        # Counting scrapes inflates the request rate by the scrape interval and
        # is not application traffic.
        client.get("/metrics")
        before = _counter_value(route="/metrics", status="2xx")
        client.get("/metrics")
        assert _counter_value(route="/metrics", status="2xx") == before

    def test_status_is_bucketed_by_class_not_exact_code(self):
        body = client.get("/metrics").text
        # Four series (2xx/4xx/5xx/…) rather than one per distinct status code.
        assert 'status="2xx"' in body
        assert 'status="200"' not in body


class TestLabelCardinality:
    def test_an_unmatched_path_does_not_create_a_series_per_url(self):
        # A 404 flood against random URLs would otherwise mint a new time
        # series per URL — the exact failure the module guards against.
        for i in range(5):
            client.get(f"/no-such-route-{i}")

        body = client.get("/metrics").text
        assert "no-such-route-0" not in body
        assert '<unmatched>' in body

    def test_no_metric_carries_a_contract_or_user_label(self):
        body = client.get("/metrics").text
        for forbidden in ("contract_id=", "freelancer_id=", "user_id=", "email="):
            assert forbidden not in body


class TestScopeDecisionCounter:
    def test_decisions_are_counted_by_outcome_only(self):
        telemetry.scope_decisions_total.labels(allowed="true").inc()
        telemetry.scope_decisions_total.labels(allowed="false").inc()

        body = telemetry.metrics_response().body.decode("utf-8")
        assert 'assurecode_scope_decisions_total{allowed="true"}' in body
        assert 'assurecode_scope_decisions_total{allowed="false"}' in body


def _counter_value(*, route: str, status: str) -> float:
    """Read one counter sample out of the dedicated registry."""
    value = telemetry.REGISTRY.get_sample_value(
        "assurecode_http_requests_total",
        {"service": "ai-service", "route": route, "method": "GET", "status": status},
    )
    return value or 0.0
