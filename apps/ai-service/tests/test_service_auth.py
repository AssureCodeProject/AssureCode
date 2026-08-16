"""Tests for service-to-service authentication (threat T8).

Both Python services previously registered every router with no auth dependency
at all. These cover the two properties that make the control worth having: it
fails *closed* in production, and it never blocks a probe.
"""
from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.ports import service_auth


@pytest.fixture
def clean_env(monkeypatch):
    monkeypatch.delenv("SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    return monkeypatch


def build_app() -> FastAPI:
    """A minimal app wired the same way the real services are."""
    app = FastAPI(dependencies=[Depends(service_auth.verify_service_token)])

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.get("/metrics")
    def metrics():
        return {"metrics": ""}

    @app.post("/score")
    def score():
        return {"trust_score": 91.0}

    return app


class TestTokenEnforcement:
    def test_a_valid_token_is_accepted(self, clean_env):
        clean_env.setenv("SERVICE_TOKEN", "s3cret-token-value")
        client = TestClient(build_app())

        res = client.post("/score", headers={"x-service-token": "s3cret-token-value"})
        assert res.status_code == 200

    def test_a_missing_token_is_rejected(self, clean_env):
        clean_env.setenv("SERVICE_TOKEN", "s3cret-token-value")
        client = TestClient(build_app())

        res = client.post("/score")
        assert res.status_code == 401

    def test_a_wrong_token_is_rejected(self, clean_env):
        clean_env.setenv("SERVICE_TOKEN", "s3cret-token-value")
        client = TestClient(build_app())

        res = client.post("/score", headers={"x-service-token": "not-the-token"})
        assert res.status_code == 401

    def test_a_token_that_is_a_prefix_of_the_real_one_is_rejected(self, clean_env):
        # compare_digest, not startswith and not ==.
        clean_env.setenv("SERVICE_TOKEN", "s3cret-token-value")
        client = TestClient(build_app())

        res = client.post("/score", headers={"x-service-token": "s3cret"})
        assert res.status_code == 401

    def test_an_empty_header_is_rejected(self, clean_env):
        clean_env.setenv("SERVICE_TOKEN", "s3cret-token-value")
        client = TestClient(build_app())

        res = client.post("/score", headers={"x-service-token": ""})
        assert res.status_code == 401


class TestProbesAreNeverBlocked:
    """A liveness probe cannot present a token; 401ing it restart-loops the pod."""

    @pytest.mark.parametrize("path", ["/healthz", "/metrics"])
    def test_probe_paths_bypass_auth(self, clean_env, path):
        clean_env.setenv("SERVICE_TOKEN", "s3cret-token-value")
        client = TestClient(build_app())

        assert client.get(path).status_code == 200

    def test_the_public_path_list_covers_the_probe_endpoints(self):
        assert "/healthz" in service_auth.PUBLIC_PATHS
        assert "/readyz" in service_auth.PUBLIC_PATHS
        assert "/metrics" in service_auth.PUBLIC_PATHS


class TestUnconfiguredBehaviour:
    def test_development_without_a_token_leaves_the_check_disabled(self, clean_env):
        # The offline stack and the test suites must keep working without
        # ceremony; the environment is what says the check is off.
        client = TestClient(build_app())
        assert client.post("/score").status_code == 200

    @pytest.mark.parametrize(
        "placeholder",
        ["", "REPLACE_ME", "changeme", "dev_insecure_service_token_change_me"],
    )
    def test_placeholder_tokens_do_not_count_as_configured(self, clean_env, placeholder):
        clean_env.setenv("SERVICE_TOKEN", placeholder)
        client = TestClient(build_app())

        # Not production, so the check is simply off — importantly, the
        # placeholder is NOT accepted as a valid secret that callers could send.
        assert client.post("/score").status_code == 200
        assert service_auth._is_placeholder(placeholder)

    def test_any_dev_insecure_prefix_is_a_placeholder(self):
        assert service_auth._is_placeholder("dev_insecure_anything_at_all")


class TestFailsClosedInProduction:
    """The property that makes this a control rather than a suggestion."""

    def test_production_without_a_token_refuses_to_start(self, clean_env):
        clean_env.setenv("NODE_ENV", "production")
        with pytest.raises(service_auth.ServiceAuthMisconfigured):
            service_auth.assert_configured()

    @pytest.mark.parametrize("placeholder", ["REPLACE_ME", "dev_insecure_service_token_change_me"])
    def test_production_with_a_placeholder_refuses_to_start(self, clean_env, placeholder):
        clean_env.setenv("NODE_ENV", "production")
        clean_env.setenv("SERVICE_TOKEN", placeholder)
        with pytest.raises(service_auth.ServiceAuthMisconfigured):
            service_auth.assert_configured()

    def test_production_with_a_real_token_starts(self, clean_env):
        clean_env.setenv("NODE_ENV", "production")
        clean_env.setenv("SERVICE_TOKEN", "a-real-production-token")
        service_auth.assert_configured()  # must not raise

    def test_production_with_a_late_emptied_token_serves_503_not_200(self, clean_env):
        # Belt and braces: if assert_configured somehow did not stop startup,
        # the request path must still refuse rather than fall through to the
        # "check disabled" branch.
        clean_env.setenv("NODE_ENV", "production")
        clean_env.setenv("SERVICE_TOKEN", "")
        client = TestClient(build_app())

        assert client.post("/score").status_code == 503

    def test_development_without_a_token_starts_fine(self, clean_env):
        service_auth.assert_configured()  # must not raise
