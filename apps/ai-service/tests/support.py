"""A TestClient that authenticates the way a real caller does.

Why this exists. Every route test used to build a bare `TestClient(app)` and
send no credential. Those tests passed — but only because `SERVICE_TOKEN` is
normally unset in a developer shell, and `verify_service_token` disables itself
when the configured token is a placeholder (`service_auth._is_placeholder`).
The suite was therefore green for a reason that had nothing to do with the code
under test.

`npm run test:e2e` sets `SERVICE_TOKEN` deliberately, so the guard activates and
every one of those requests became a 401. That is how the e2e run was red for
53 ai-service tests and 8 scope-guard tests while `pytest` alone was green —
the two disagreed about ambient environment, not about behaviour.

Sending the token makes the suite independent of what happens to be in the
environment, and means a regression that broke service auth would surface as a
401 here rather than as a silent pass.

`tests/test_service_auth.py` deliberately does NOT use this — it builds its own
app and asserts the guard rejects, which is the one place a missing credential
is the point.
"""
from __future__ import annotations

import os

from fastapi.testclient import TestClient

from app.ports.service_auth import SERVICE_TOKEN_HEADER


def service_client(app, **kwargs) -> TestClient:
    """A TestClient carrying the configured service token, if there is one.

    When `SERVICE_TOKEN` is unset the guard is already disabled, so the header
    is omitted rather than sent empty — an empty credential and no credential
    are different requests, and only one of them is what a real caller sends.
    """
    token = os.environ.get("SERVICE_TOKEN", "").strip()
    headers = {SERVICE_TOKEN_HEADER: token} if token else {}
    headers.update(kwargs.pop("headers", None) or {})
    return TestClient(app, headers=headers, **kwargs)
