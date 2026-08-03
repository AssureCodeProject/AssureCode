#!/usr/bin/env python3
"""Measure detection accuracy of the shipped OWASP Top 10:2025 scanner.

What changed and why
--------------------
The previous version of this harness carried its own inline copy of the
detection logic and counted a category as "passed" whenever the Cloudflare API
returned HTTP 200 — see `total_passed += 1` guarded only by `status == SUCCESS`.
That measured API reachability, not detection: a model replying "this looks
fine" scored identically to one that found the flaw, and the inline copy could
drift arbitrarily far from the scanner that actually ships.

This version:

  * imports the real scanner (app.services.owasp_static) and the real LLM
    adapter, so what is measured is what runs in production;
  * scores planted flaws as true positives and, critically, runs CLEAN samples
    to measure false positives. A scanner that flags everything has perfect
    recall and no value, which the old harness could not have detected;
  * reports precision, recall and F1 per layer instead of a pass count;
  * exits non-zero when the deterministic layer regresses, so CI can gate on it.

Usage
-----
    python tools/verify_owasp_2025_cloudflare.py            # both layers
    python tools/verify_owasp_2025_cloudflare.py --static   # skip the LLM
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps" / "ai-service"))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def _load_dotenv() -> None:
    """Populate os.environ from .env without taking a dependency."""
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

from app.services import owasp_static  # noqa: E402


@dataclass
class Sample:
    """One labelled input. `expected` is None for a deliberately clean sample."""

    label: str
    code: str
    expected: str | None
    note: str = ""
    # True when Layer 1 provably cannot judge this sample correctly, because
    # doing so needs dataflow the pattern matcher does not perform. Such a
    # sample still counts in the reported precision — the number stays honest —
    # but does not fail the CI gate, which exists to catch regressions rather
    # than to re-report a limitation we have already characterised. Layer 2 is
    # the layer expected to get these right.
    layer1_known_limitation: bool = False


# ── Vulnerable samples: one per OWASP Top 10:2025 category ──────────

VULNERABLE: list[Sample] = [
    Sample("A01 SSRF", """app.get('/api/proxy', async (req, res) => {
    const response = await fetch(req.query.target);
    res.send(await response.text());
});""", "A01:2025", "unrestricted outbound fetch to a user-supplied URL"),

    Sample("A02 wildcard CORS", """app.use(cors({ origin: '*' }));
app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message, stack: err.stack });
});""", "A02:2025", "any-origin CORS plus stack trace leakage"),

    Sample("A03 supply chain", """const { execSync } = require('child_process');
app.post('/plugin/install', (req, res) => {
    execSync(`npm install http://untrusted-repo.org/${req.body.packageName}.tgz`);
});""", "A03:2025", "package installed from an unverified source"),

    Sample("A04 hardcoded secret", """const stripeKey = "sk_live_51H8xQ2eZvKYlo2C";
const sessionToken = Math.random().toString(36);""", "A04:2025", "inlined credential and weak randomness"),

    Sample("A05 SQL injection", """app.get('/user', (req, res) => {
    db.query('SELECT * FROM users WHERE id = ' + req.query.id, cb);
});""", "A05:2025", "SQL assembled by concatenation"),

    Sample("A06 path traversal", """app.get('/download', (req, res) => {
    res.sendFile(path.join('/var/data', req.query.file));
});""", "A06:2025", "user-controlled path with no normalization"),

    Sample("A07 unverified JWT", """function authenticate(token) {
    const claims = jwt.decode(token);
    return claims && claims.role === 'admin';
}""", "A07:2025", "JWT decoded without verifying the signature"),

    Sample("A08 dynamic execution", """app.post('/calc', (req, res) => {
    res.json({ result: eval(req.body.expression) });
});""", "A08:2025", "eval on request input"),

    Sample("A09 secret logging", """app.post('/login', (req, res) => {
    console.log('login attempt', { user: req.body.user, password: req.body.password });
});""", "A09:2025", "credential written to logs"),

    Sample("A10 fails open", """function checkAccess(user) {
    try {
        return authorize(user);
    } catch (e) {
        return true;
    }
}""", "A10:2025", "error handler grants access instead of denying"),
]


# ── Clean samples: the safe counterpart of each risky construct ─────
#
# These are the control group. Every finding here is a false positive. Without
# them, a scanner that returned "vulnerable" unconditionally would score 100%
# on the vulnerable set and look flawless.

CLEAN: list[Sample] = [
    Sample("clean parameterized SQL", """app.get('/user', (req, res) => {
    db.query('SELECT * FROM users WHERE id = $1', [req.query.id], cb);
});""", None, "safe counterpart of A05"),

    Sample("clean restrictive CORS", """app.use(cors({ origin: 'https://app.example.com', credentials: true }));""",
           None, "safe counterpart of A02"),

    Sample("clean env secret", """const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) throw new Error('STRIPE_SECRET_KEY is required');""", None, "safe counterpart of A04"),

    Sample("clean verified JWT", """function authenticate(token) {
    const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
    return claims && claims.role === 'admin';
}""", None, "safe counterpart of A07"),

    Sample("clean fail-closed handler", """function checkAccess(user) {
    try {
        return authorize(user);
    } catch (e) {
        logger.error({ err: e }, 'authorization failed');
        return false;
    }
}""", None, "safe counterpart of A10"),

    Sample("clean strong crypto", """const digest = createHash('sha256').update(payload).digest('hex');
const nonce = crypto.randomBytes(32).toString('hex');""", None, "safe counterpart of A04 weak hash/PRNG"),

    Sample("clean business logic", """function invoiceTotal(items, taxRate) {
    const subtotal = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
    return Math.round(subtotal * (1 + taxRate));
}""", None, "no security surface at all"),

    Sample("clean allowlisted file read", """app.get('/download', (req, res) => {
    const allowed = new Set(['report.pdf', 'summary.csv']);
    if (!allowed.has(req.query.file)) return res.status(400).end();
    res.sendFile(path.join('/var/data', req.query.file));
});""", None,
           "allowlisted filename, not raw user input — safe, but only provably so "
           "if you follow the guard on the line above into the sendFile call",
           layer1_known_limitation=True),
]


@dataclass
class LayerScore:
    name: str
    true_positives: int = 0
    false_negatives: int = 0
    false_positives: int = 0
    true_negatives: int = 0
    errors: list[str] = field(default_factory=list)
    elapsed_s: float = 0.0
    # False positives that are characterised limitations rather than regressions.
    # Counted in precision, excluded from the CI gate.
    known_limitations: int = 0
    # Lenient scoring for the semantic layer: a serious finding was raised on a
    # vulnerable sample, regardless of which OWASP heading it was filed under.
    flaw_detected: int = 0
    flaw_missed: int = 0

    @property
    def precision(self) -> float:
        denom = self.true_positives + self.false_positives
        return self.true_positives / denom if denom else 0.0

    @property
    def recall(self) -> float:
        denom = self.true_positives + self.false_negatives
        return self.true_positives / denom if denom else 0.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if (p + r) else 0.0


def run_static_layer() -> LayerScore:
    score = LayerScore("Layer 1 - static (deterministic)")
    started = time.perf_counter()

    print("\n" + "=" * 78)
    print(" LAYER 1 - static scanner (app/services/owasp_static.py)")
    print("=" * 78)

    for sample in VULNERABLE:
        findings = owasp_static.scan(sample.code)
        hit = [v for v in findings if v.category == sample.expected]
        if hit:
            score.true_positives += 1
            print(f"  TP  {sample.label:26s} -> {hit[0].type}")
        else:
            score.false_negatives += 1
            found = ", ".join(sorted({v.type for v in findings})) or "nothing"
            print(f"  FN  {sample.label:26s} -> missed {sample.expected}; found: {found}")

    print("  " + "-" * 74)

    for sample in CLEAN:
        findings = owasp_static.scan(sample.code)
        if findings:
            score.false_positives += 1
            types = ", ".join(sorted({v.type for v in findings}))
            if sample.layer1_known_limitation:
                score.known_limitations += 1
                print(f"  FP* {sample.label:26s} -> {types}  (known Layer 1 limitation)")
            else:
                print(f"  FP  {sample.label:26s} -> flagged clean code: {types}")
        else:
            score.true_negatives += 1
            print(f"  TN  {sample.label:26s} -> clean, as expected")

    score.elapsed_s = time.perf_counter() - started
    return score


def run_llm_layer() -> LayerScore:
    from app.ports.llm_client import CloudflareWorkersAiClient, LlmUnavailableError
    from app.routes.security_scan import (
        PROMPT_TEMPLATE,
        _extract_json_array,
        _normalize_llm_findings,
    )

    score = LayerScore("Layer 2 - Cloudflare Workers AI")
    started = time.perf_counter()

    print("\n" + "=" * 78)
    print(" LAYER 2 - Cloudflare Workers AI @cf/meta/llama-3.1-8b-instruct")
    print("=" * 78)

    client = CloudflareWorkersAiClient(
        account_id=os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""),
        api_token=os.environ.get("CLOUDFLARE_API_TOKEN", ""),
    )
    category_lines = "\n".join(f"  {c['id']} - {c['name']}" for c in owasp_static.categories())

    def query(sample: Sample):
        prompt = PROMPT_TEMPLATE.format(categories=category_lines, code=sample.code)
        raw = client.generate(prompt, max_tokens=1024)
        items = _extract_json_array(raw)
        return _normalize_llm_findings(items, sample.code.count("\n") + 1)

    for sample in VULNERABLE:
        try:
            findings = query(sample)
        except LlmUnavailableError as err:
            score.errors.append(f"{sample.label}: {err}")
            print(f"  ERR {sample.label:26s} -> {str(err)[:60]}")
            continue
        except (ValueError, json.JSONDecodeError) as err:
            score.errors.append(f"{sample.label}: unparseable response ({err})")
            print(f"  ERR {sample.label:26s} -> unparseable model response")
            continue

        # Two questions, deliberately kept apart:
        #
        #   1. Did the model land the exact OWASP category? (strict)
        #   2. Did it flag a serious flaw here at all?        (lenient)
        #
        # llama-3.1-8b routinely finds the real defect and files it under the
        # wrong Ax:2025 heading — "SSRF" reported as A02 rather than A01. Scoring
        # only the strict form understates what Layer 2 contributes; scoring only
        # the lenient form would hide a genuine weakness. Both are reported.
        exact = any(v.category == sample.expected for v in findings)
        located = any(v.severity in ("HIGH", "CRITICAL") for v in findings)

        if located:
            score.flaw_detected += 1
        else:
            score.flaw_missed += 1

        if exact:
            score.true_positives += 1
            print(f"  TP  {sample.label:26s} -> {sample.expected} identified")
        else:
            score.false_negatives += 1
            got = ", ".join(sorted({v.category for v in findings})) or "nothing"
            marker = "flaw found, wrong category" if located else "no serious finding"
            print(f"  FN  {sample.label:26s} -> expected {sample.expected}, got {got} ({marker})")

    print("  " + "-" * 74)

    for sample in CLEAN:
        try:
            findings = query(sample)
        except (LlmUnavailableError, ValueError, json.JSONDecodeError) as err:
            score.errors.append(f"{sample.label}: {err}")
            print(f"  ERR {sample.label:26s} -> {str(err)[:60]}")
            continue

        # Only HIGH and CRITICAL count against precision. Models routinely
        # volunteer low-severity hardening advice on correct code, which is
        # noise rather than a false alarm about a vulnerability.
        serious = [v for v in findings if v.severity in ("HIGH", "CRITICAL")]
        if serious:
            score.false_positives += 1
            print(f"  FP  {sample.label:26s} -> {', '.join(v.type for v in serious)}")
        else:
            score.true_negatives += 1
            print(f"  TN  {sample.label:26s} -> clean, as expected")

    score.elapsed_s = time.perf_counter() - started
    return score


def report(scores: list[LayerScore]) -> int:
    print("\n" + "=" * 78)
    print(" DETECTION ACCURACY")
    print("=" * 78)
    print(f"  {'layer':<34} {'TP':>3} {'FN':>3} {'FP':>3} {'TN':>3}  {'prec':>6} {'rec':>6} {'F1':>6}")
    print("  " + "-" * 74)

    for s in scores:
        print(
            f"  {s.name:<34} {s.true_positives:>3} {s.false_negatives:>3} "
            f"{s.false_positives:>3} {s.true_negatives:>3}  "
            f"{s.precision:>6.3f} {s.recall:>6.3f} {s.f1:>6.3f}"
        )

    print("  " + "-" * 74)
    for s in scores:
        n = s.true_positives + s.false_negatives + s.false_positives + s.true_negatives
        print(f"  {s.name}: {n} samples scored in {s.elapsed_s:.2f}s")
        if s.flaw_detected or s.flaw_missed:
            total = s.flaw_detected + s.flaw_missed
            rate = s.flaw_detected / total if total else 0.0
            print(f"    lenient recall (serious flaw found, any category): "
                  f"{s.flaw_detected}/{total} = {rate:.3f}")
            print("    The gap between this and strict recall is category assignment,")
            print("    not detection: the model finds the defect and mislabels it.")
        if s.errors:
            print(f"    {len(s.errors)} error(s), excluded from the counts above rather")
            print("    than silently scored as correct:")
            for err in s.errors:
                print(f"      - {err}")

    print("\n  Recall alone is not a result. The clean samples are what make")
    print("  precision meaningful: a scanner that flags everything reaches")
    print("  recall 1.000 and precision near zero.")
    print("=" * 78)

    static = next((s for s in scores if s.name.startswith("Layer 1")), None)
    if static:
        unexpected_fp = static.false_positives - static.known_limitations
        if static.known_limitations:
            print(f"\n  {static.known_limitations} Layer 1 false positive(s), marked FP*, are known")
            print("  limitations of pattern matching without dataflow analysis. They are")
            print("  counted in the precision above and are the case Layer 2 exists to cover.")
        if static.false_negatives > 0 or unexpected_fp > 0:
            print(
                f"\n  FAIL: the deterministic layer regressed "
                f"({static.false_negatives} FN, {unexpected_fp} unexpected FP)."
            )
            return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--static", action="store_true", help="run only the deterministic layer")
    args = parser.parse_args()

    print("=" * 78)
    print(" AssureCode - OWASP Top 10:2025 detection accuracy")
    print(f" taxonomy: {owasp_static.taxonomy_version()}")
    print(f" samples:  {len(VULNERABLE)} vulnerable, {len(CLEAN)} clean")
    print("=" * 78)

    scores = [run_static_layer()]

    if not args.static:
        if not os.environ.get("CLOUDFLARE_API_TOKEN"):
            print("\n  Skipping Layer 2: CLOUDFLARE_API_TOKEN is not set.")
            print("  This is a SKIP, not a pass.")
        else:
            scores.append(run_llm_layer())

    return report(scores)


if __name__ == "__main__":
    raise SystemExit(main())
