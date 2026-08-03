"""Layer 1 static scanner for the OWASP Top 10:2025 taxonomy.

Rules are loaded from packages/shared/src/owasp-2025-rules.json — the same file
apps/ci-worker/src/security-auditor.ts compiles. Keeping the rule set in one
place is the point: two hand-maintained copies of twenty-odd regexes in two
languages drift within a sprint, and a scanner that disagrees with itself
depending on which service ran it is worse than one that misses a category.

Patterns are restricted to the regex subset common to JavaScript and Python.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

# apps/ai-service/app/services/owasp_static.py -> repo root is 4 levels up.
_REPO_ROOT = Path(__file__).resolve().parents[4]
_RULES_PATH = _REPO_ROOT / "packages" / "shared" / "src" / "owasp-2025-rules.json"

SEVERITY_ORDER = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}


@dataclass(frozen=True)
class Vulnerability:
    type: str
    category: str
    severity: str
    message: str
    line: int
    layer: str = "static"

    def to_dict(self) -> dict[str, object]:
        return {
            "type": self.type,
            "category": self.category,
            "severity": self.severity,
            "message": self.message,
            "line": self.line,
            "layer": self.layer,
        }


@dataclass(frozen=True)
class _CompiledRule:
    type: str
    category: str
    severity: str
    message: str
    per_line: re.Pattern[str]
    whole_source: re.Pattern[str]


@lru_cache(maxsize=1)
def _load_rule_file() -> dict:
    if not _RULES_PATH.exists():
        raise FileNotFoundError(
            f"OWASP rule file not found at {_RULES_PATH}. The static scanner "
            "cannot run without it, and must not silently pass code it never scanned."
        )
    return json.loads(_RULES_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _compiled_rules() -> tuple[_CompiledRule, ...]:
    compiled: list[_CompiledRule] = []
    for rule in _load_rule_file()["rules"]:
        flags = re.IGNORECASE if rule["caseInsensitive"] else 0
        compiled.append(
            _CompiledRule(
                type=rule["type"],
                category=rule["category"],
                severity=rule["severity"],
                message=rule["message"],
                per_line=re.compile(rule["pattern"], flags),
                whole_source=re.compile(rule["pattern"], flags | re.DOTALL),
            )
        )
    return tuple(compiled)


def taxonomy_version() -> str:
    return str(_load_rule_file()["taxonomyVersion"])


def categories() -> list[dict[str, str]]:
    return list(_load_rule_file()["categories"])


def scan(code: str) -> list[Vulnerability]:
    """Run every Layer 1 rule against `code`.

    Each rule gets two passes: line by line for precise attribution, then once
    over the whole source so constructs that straddle a newline (an empty catch
    block, for instance) are still caught. Duplicate findings for the same rule
    and line are collapsed.
    """
    findings: dict[tuple[str, int], Vulnerability] = {}
    lines = code.split("\n")

    for rule in _compiled_rules():
        for index, line in enumerate(lines, start=1):
            if rule.per_line.search(line):
                findings.setdefault(
                    (rule.type, index),
                    Vulnerability(rule.type, rule.category, rule.severity, rule.message, index),
                )

        match = rule.whole_source.search(code)
        if match:
            line_number = code[: match.start()].count("\n") + 1
            findings.setdefault(
                (rule.type, line_number),
                Vulnerability(rule.type, rule.category, rule.severity, rule.message, line_number),
            )

    return sorted(findings.values(), key=lambda v: (v.line, v.type))


def compute_security_score(vulnerabilities: list[Vulnerability]) -> int:
    """S_sec = max(0, 100 - 40*N_c - 20*N_h - 5*N_t).

    N_t counts every finding, so a critical is charged at both 40 and 5. That
    double-count is in the published formula and is reproduced here deliberately
    rather than quietly corrected.
    """
    critical = sum(1 for v in vulnerabilities if v.severity == "CRITICAL")
    high = sum(1 for v in vulnerabilities if v.severity == "HIGH")
    return max(0, 100 - 40 * critical - 20 * high - 5 * len(vulnerabilities))
