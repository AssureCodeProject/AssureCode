"""Tests for the dual-layer OWASP Top 10:2025 scanner.

Two properties matter more than raw detection here:

  1. Clean code must produce no findings. A scanner that flags everything has
     100% recall and is useless. The old verification harness in
     tools/verify_owasp_2025_cloudflare.py counted a category as passed whenever
     the API returned HTTP 200, so it could not have noticed.

  2. An unavailable or unparseable LLM must surface as an error, never as an
     empty finding list. "No vulnerabilities" and "could not read the answer"
     are opposite outcomes and must not collapse into the same response.
"""
from __future__ import annotations

import pytest
from support import service_client

from app.main import app
from app.services import owasp_static

client = service_client(app)


# ── Layer 1: static detection ──────────────────────────────────────

VULNERABLE_SAMPLES = {
    "A01:2025": "app.get('/api/proxy', async (req, res) => { const r = await fetch(req.query.target); });",
    "A02:2025": "app.use(cors({ origin: '*' }));",
    "A03:2025": "execSync(`npm install http://untrusted-repo.org/${pkg}.tgz`);",
    "A04:2025": 'const apiKey = "sk_live_9f8e7d6c5b4a3210";',
    "A05:2025": "db.query('SELECT * FROM users WHERE id = ' + req.params.id);",
    "A06:2025": "fs.readFile(req.query.path, cb);",
    "A07:2025": "if (jwt.decode(token)) { grantAccess(); }",
    "A08:2025": "eval(userSuppliedExpression);",
    "A09:2025": "console.log('login attempt', { password: req.body.password });",
    "A10:2025": "try { risky(); } catch (e) {}",
}


@pytest.mark.parametrize("category,code", sorted(VULNERABLE_SAMPLES.items()))
def test_static_scan_detects_each_owasp_category(category: str, code: str) -> None:
    findings = owasp_static.scan(code)
    hit = [v for v in findings if v.category == category]
    assert hit, f"{category} not detected in: {code!r} (found {[v.type for v in findings]})"


CLEAN_SAMPLES = [
    # Parameterized query — the safe counterpart to the A05 sample.
    "db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);",
    # Restrictive CORS — the safe counterpart to A02.
    "app.use(cors({ origin: 'https://app.example.com' }));",
    # Secret read from the environment rather than inlined.
    "const apiKey = process.env.API_KEY;",
    # Strong hash with a real salt.
    "const digest = createHash('sha256').update(payload).digest('hex');",
    # Exception handled rather than swallowed.
    "try { risky(); } catch (e) { logger.error({ err: e }, 'failed'); throw e; }",
    # Ordinary business logic with no security surface at all.
    "function total(items) { return items.reduce((sum, i) => sum + i.price, 0); }",
]


@pytest.mark.parametrize("code", CLEAN_SAMPLES)
def test_static_scan_reports_nothing_on_clean_code(code: str) -> None:
    findings = owasp_static.scan(code)
    assert findings == [], f"false positive on clean code {code!r}: {[v.type for v in findings]}"


def test_security_score_matches_published_formula() -> None:
    # 1 critical + 1 high, 2 findings total:
    #   100 - 40(1) - 20(1) - 5(2) = 30
    vulns = [
        owasp_static.Vulnerability("A", "A05:2025", "CRITICAL", "", 1),
        owasp_static.Vulnerability("B", "A04:2025", "HIGH", "", 2),
    ]
    assert owasp_static.compute_security_score(vulns) == 30


def test_security_score_floors_at_zero() -> None:
    vulns = [owasp_static.Vulnerability(f"V{i}", "A05:2025", "CRITICAL", "", i) for i in range(1, 6)]
    assert owasp_static.compute_security_score(vulns) == 0


# ── Route behaviour ────────────────────────────────────────────────


def test_route_static_only_reports_which_layers_ran() -> None:
    res = client.post(
        "/security-scan",
        json={"code": "eval(x);", "include_static": True, "include_llm": False},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["layers_run"] == ["static"]
    assert body["taxonomy_version"] == "OWASP Top 10:2025"
    assert any(v["type"] == "DYNAMIC_CODE_EXECUTION" for v in body["vulnerabilities"])
    assert all(v["layer"] == "static" for v in body["vulnerabilities"])


def test_route_rejects_a_request_with_no_layers() -> None:
    res = client.post(
        "/security-scan",
        json={"code": "const x = 1;", "include_static": False, "include_llm": False},
    )
    assert res.status_code == 400


def test_route_returns_503_when_the_llm_is_unavailable() -> None:
    from app.deps import get_security_llm_client
    from app.ports.llm_client import LlmUnavailableError

    class DeadLlm:
        def generate(self, prompt: str, max_tokens: int = 2048) -> str:
            raise LlmUnavailableError("provider down", retry_after=7)

    app.dependency_overrides[get_security_llm_client] = lambda: DeadLlm()
    try:
        res = client.post("/security-scan", json={"code": "const x = 1;"})
        assert res.status_code == 503
        assert res.headers["Retry-After"] == "7"
    finally:
        app.dependency_overrides.clear()


def test_route_returns_502_when_the_llm_response_is_unparseable() -> None:
    from app.deps import get_security_llm_client

    class BabblingLlm:
        def generate(self, prompt: str, max_tokens: int = 2048) -> str:
            return "I think the code looks fine, honestly."

    app.dependency_overrides[get_security_llm_client] = lambda: BabblingLlm()
    try:
        res = client.post("/security-scan", json={"code": "const x = 1;"})
        # Must not be a 200 with an empty finding list — that would report
        # "clean" for a scan that never actually produced a verdict.
        assert res.status_code == 502
    finally:
        app.dependency_overrides.clear()


def test_route_merges_llm_findings_and_labels_their_layer() -> None:
    from app.deps import get_security_llm_client

    class ScriptedLlm:
        def generate(self, prompt: str, max_tokens: int = 2048) -> str:
            return (
                '[{"type":"MISSING_OWNERSHIP_CHECK","category":"A01:2025",'
                '"severity":"HIGH","message":"deletes any id without checking ownership","line":1}]'
            )

    app.dependency_overrides[get_security_llm_client] = lambda: ScriptedLlm()
    try:
        res = client.post(
            "/security-scan",
            json={"code": "app.delete('/item/:id', (req,res) => db.remove(req.params.id));"},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["layers_run"] == ["static", "llm"]
        llm_findings = [v for v in body["vulnerabilities"] if v["layer"] == "llm"]
        assert any(v["type"] == "MISSING_OWNERSHIP_CHECK" for v in llm_findings)
    finally:
        app.dependency_overrides.clear()


def test_route_discards_llm_findings_that_cannot_be_located() -> None:
    from app.deps import get_security_llm_client

    class HallucinatingLlm:
        def generate(self, prompt: str, max_tokens: int = 2048) -> str:
            return (
                '[{"type":"BAD_LINE","category":"A01:2025","severity":"HIGH","message":"x","line":9999},'
                '{"type":"BAD_CATEGORY","category":"A99:2025","severity":"HIGH","message":"x","line":1},'
                '{"type":"BAD_SEVERITY","category":"A01:2025","severity":"SPICY","message":"x","line":1}]'
            )

    app.dependency_overrides[get_security_llm_client] = lambda: HallucinatingLlm()
    try:
        res = client.post("/security-scan", json={"code": "const x = 1;"})
        assert res.status_code == 200
        types = {v["type"] for v in res.json()["vulnerabilities"]}
        assert "BAD_LINE" not in types
        assert "BAD_CATEGORY" not in types
        assert "BAD_SEVERITY" not in types
    finally:
        app.dependency_overrides.clear()
