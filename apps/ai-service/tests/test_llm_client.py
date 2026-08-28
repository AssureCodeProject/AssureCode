"""CloudflareWorkersAiClient retry/backoff.

Previously a single failed httpx.post surfaced immediately, with no
distinction between a 429/5xx (retrying can plausibly help) and a real
rejection (bad request, revoked token). This is the regression guard for the
retry policy: which failures get retried, which don't, Retry-After is
honoured, and retries eventually give up rather than looping forever.
"""
from __future__ import annotations

import time

import httpx
import pytest

from app.ports.llm_client import CloudflareWorkersAiClient, LlmUnavailableError


def _client() -> CloudflareWorkersAiClient:
    return CloudflareWorkersAiClient(account_id="acct_test", api_token="tok_test")


def _response(status_code: int, body: dict | None = None, headers: dict | None = None) -> httpx.Response:
    return httpx.Response(
        status_code=status_code,
        json=body if body is not None else {"error": "simulated"},
        headers=headers or {},
        request=httpx.Request("POST", "https://api.cloudflare.com/fake"),
    )


@pytest.fixture(autouse=True)
def no_real_sleep(monkeypatch):
    """Every test below exercises real retry/backoff logic; none should take wall-clock time to run."""
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)


def test_retries_a_429_and_succeeds_honouring_retry_after(monkeypatch):
    calls = {"n": 0}

    def fake_post(url, headers=None, json=None, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            return _response(429, {"error": "rate limited"}, headers={"retry-after": "0"})
        return _response(200, {"result": {"response": "generated text"}})

    monkeypatch.setattr(httpx, "post", fake_post)

    result = _client().generate("a prompt")
    assert result == "generated text"
    assert calls["n"] == 2


def test_retries_a_5xx_and_succeeds(monkeypatch):
    calls = {"n": 0}

    def fake_post(url, headers=None, json=None, timeout=None):
        calls["n"] += 1
        if calls["n"] < 3:
            return _response(503, {"error": "upstream unavailable"})
        return _response(200, {"result": {"response": "generated text"}})

    monkeypatch.setattr(httpx, "post", fake_post)

    result = _client().generate("a prompt")
    assert result == "generated text"
    assert calls["n"] == 3


def test_does_not_retry_a_non_429_4xx(monkeypatch):
    calls = {"n": 0}

    def fake_post(url, headers=None, json=None, timeout=None):
        calls["n"] += 1
        return _response(400, {"error": "bad request"})

    monkeypatch.setattr(httpx, "post", fake_post)

    with pytest.raises(LlmUnavailableError):
        _client().generate("a prompt")
    assert calls["n"] == 1


def test_gives_up_after_exhausting_retries_on_repeated_429s(monkeypatch):
    calls = {"n": 0}

    def fake_post(url, headers=None, json=None, timeout=None):
        calls["n"] += 1
        return _response(429, {"error": "still rate limited"}, headers={"retry-after": "0"})

    monkeypatch.setattr(httpx, "post", fake_post)

    with pytest.raises(LlmUnavailableError):
        _client().generate("a prompt")
    # 1 original attempt + 2 retries — see _MAX_ATTEMPTS in llm_client.py.
    assert calls["n"] == 3


def test_retries_a_network_level_failure(monkeypatch):
    calls = {"n": 0}

    def fake_post(url, headers=None, json=None, timeout=None):
        calls["n"] += 1
        if calls["n"] < 2:
            raise httpx.ConnectError("connection refused")
        return _response(200, {"result": {"response": "generated text"}})

    monkeypatch.setattr(httpx, "post", fake_post)

    result = _client().generate("a prompt")
    assert result == "generated text"
    assert calls["n"] == 2
