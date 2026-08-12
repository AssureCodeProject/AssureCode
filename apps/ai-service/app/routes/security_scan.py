"""Routes under /security-scan — dual-layer OWASP Top 10:2025 analysis.

Layer 1 is the deterministic static scanner in app.services.owasp_static.
Layer 2 asks an LLM for the semantic findings patterns cannot reach: missing
authorization, unsafe control flow, logic that is dangerous without containing
any characteristic token.

The two layers are reported separately and never merged into an undifferentiated
score. A caller has to be able to tell which findings came from a regex and
which from a model, because they carry very different confidence.
"""
from __future__ import annotations

import json
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.deps import get_llm_client
from app.ports.llm_client import LlmClient, LlmUnavailableError
from app.services import owasp_static

router = APIRouter(prefix="/security-scan", tags=["security"])

SEVERITIES = {"LOW", "MEDIUM", "HIGH", "CRITICAL"}

PROMPT_TEMPLATE = """\
You are a application security reviewer auditing untrusted code against the
OWASP Top 10:2025 categories listed below.

{categories}

Report only vulnerabilities you can point to in the code. Do not report
stylistic issues, missing tests, or hypothetical risks that require code not
shown here. If the code has no vulnerability, return an empty array.

Respond with ONLY a JSON array, no prose and no markdown fence. Each element:

  {{"type": "SCREAMING_SNAKE_CASE_ID",
    "category": "A0N:2025",
    "severity": "LOW|MEDIUM|HIGH|CRITICAL",
    "message": "one sentence naming the specific flaw",
    "line": <1-based line number>}}

Code under review:
```
{code}
```
"""


class SecurityScanRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=200_000)
    contract_id: str | None = Field(default=None, max_length=128)
    # ci-worker runs Layer 1 in-process and sets this False to avoid paying for
    # the same static pass twice.
    include_static: bool = True
    include_llm: bool = True


class VulnerabilityModel(BaseModel):
    type: str
    category: str
    severity: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
    message: str
    line: int
    layer: Literal["static", "llm"]


class SecurityScanResponse(BaseModel):
    contract_id: str | None
    taxonomy_version: str
    vulnerabilities: list[VulnerabilityModel]
    passed: bool
    score: int
    layers_run: list[str]


def _extract_json_array(raw: str) -> list[dict]:
    """Pull a JSON array out of a model response.

    Models wrap JSON in prose or a markdown fence often enough that requiring a
    bare array would fail constantly. This tolerates the wrapping but not
    malformed JSON — a response we cannot parse is an error, not an empty
    finding list, because "no vulnerabilities" and "could not read the answer"
    must never collapse into the same result.
    """
    text = raw.strip()

    fence = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()

    if not text.startswith("["):
        start = text.find("[")
        end = text.rfind("]")
        if start == -1 or end == -1 or end < start:
            raise ValueError(f"no JSON array found in model response: {raw[:200]}")
        text = text[start : end + 1]

    parsed = json.loads(text)
    if not isinstance(parsed, list):
        raise ValueError("model response was not a JSON array")
    return parsed


def _normalize_llm_findings(items: list[dict], max_line: int) -> list[owasp_static.Vulnerability]:
    """Keep only well-formed findings that point at a real line.

    A model will occasionally invent a category or a line beyond the end of the
    file. Those are dropped rather than repaired: a finding we cannot locate is
    not evidence of anything.
    """
    valid_categories = {c["id"] for c in owasp_static.categories()}
    out: list[owasp_static.Vulnerability] = []

    for item in items:
        if not isinstance(item, dict):
            continue
        severity = str(item.get("severity", "")).upper()
        category = str(item.get("category", ""))
        try:
            line = int(item.get("line", 0))
        except (TypeError, ValueError):
            continue

        if severity not in SEVERITIES or category not in valid_categories:
            continue
        if line < 1 or line > max_line:
            continue

        out.append(
            owasp_static.Vulnerability(
                type=str(item.get("type", "UNSPECIFIED"))[:80],
                category=category,
                severity=severity,
                message=str(item.get("message", ""))[:500],
                line=line,
                layer="llm",
            )
        )
    return out


@router.post("", response_model=SecurityScanResponse)
def security_scan(
    req: SecurityScanRequest,
    llm: LlmClient = Depends(get_llm_client),
) -> SecurityScanResponse:
    if not req.include_static and not req.include_llm:
        raise HTTPException(status_code=400, detail="At least one scan layer must be enabled")

    findings: list[owasp_static.Vulnerability] = []
    layers_run: list[str] = []

    if req.include_static:
        findings.extend(owasp_static.scan(req.code))
        layers_run.append("static")

    if req.include_llm:
        category_lines = "\n".join(f"  {c['id']} — {c['name']}" for c in owasp_static.categories())
        prompt = PROMPT_TEMPLATE.format(categories=category_lines, code=req.code)

        try:
            raw = llm.generate(prompt, max_tokens=2048)
        except LlmUnavailableError as err:
            # 503 rather than a static-only result labelled as a full scan.
            raise HTTPException(
                status_code=503,
                detail=err.message,
                headers={"Retry-After": str(err.retry_after)},
            ) from err

        try:
            items = _extract_json_array(raw)
        except (ValueError, json.JSONDecodeError) as err:
            raise HTTPException(
                status_code=502,
                detail=f"LLM returned an unparseable security report: {err}",
            ) from err

        max_line = req.code.count("\n") + 1
        llm_findings = _normalize_llm_findings(items, max_line)

        # Static findings win on a collision — they name an exact rule.
        static_keys = {(v.type, v.line) for v in findings}
        findings.extend(v for v in llm_findings if (v.type, v.line) not in static_keys)
        layers_run.append("llm")

    critical = sum(1 for v in findings if v.severity == "CRITICAL")
    high = sum(1 for v in findings if v.severity == "HIGH")

    return SecurityScanResponse(
        contract_id=req.contract_id,
        taxonomy_version=owasp_static.taxonomy_version(),
        vulnerabilities=[VulnerabilityModel(**v.to_dict()) for v in findings],  # type: ignore[arg-type]
        passed=critical == 0 and high == 0,
        score=owasp_static.compute_security_score(findings),
        layers_run=layers_run,
    )
