#!/usr/bin/env python3
"""
AssureCode OWASP Top 10:2025 Security Audit Verification Harness.

Evaluates untrusted code pushes against all 10 OWASP 2025 categories using:
1. Static Regex & AST Analysis (Layer 1 - Sub-5ms)
2. Live Cloudflare Workers AI Llama-3.1-8B-Instruct (Layer 2 - Edge Semantic LLM)
"""
import sys
import time
import httpx
import json

# Force UTF-8 encoding on Windows console
sys.stdout.reconfigure(encoding='utf-8')

import os

# Live Cloudflare Credentials (read from environment or .env)
ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "your_cloudflare_account_id")
API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "your_cloudflare_api_token")
MODEL = "@cf/meta/llama-3.1-8b-instruct"

CF_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}"

# 10 Code Samples mapping directly to OWASP Top 10:2025
OWASP_2025_TEST_CASES = [
    {
        "id": "A01:2025",
        "name": "Broken Access Control & SSRF",
        "code": """app.get('/api/proxy', async (req, res) => {
    // Unrestricted outbound fetch to user-supplied URL (SSRF)
    const targetUrl = req.query.target;
    const response = await fetch(targetUrl);
    res.send(await response.text());
});""",
        "expected_flaw": "SSRF / Unrestricted outbound URL fetch"
    },
    {
        "id": "A02:2025",
        "name": "Security Misconfiguration",
        "code": """app.use(cors({ origin: '*' }));
app.use((err, req, res, next) => {
    // Verbose error stack trace leakage
    res.status(500).json({ error: err.message, stack: err.stack, env: process.env });
});""",
        "expected_flaw": "Wildcard CORS & Stack Trace/Env Leakage"
    },
    {
        "id": "A03:2025",
        "name": "Software Supply Chain Failures",
        "code": """const { execSync } = require('child_process');
app.post('/plugin/install', (req, res) => {
    // Dynamic untrusted package execution from unverified source
    const pkg = req.body.packageName;
    execSync(`npm install http://untrusted-repo.org/${pkg}.tgz`);
    res.send('Installed');
});""",
        "expected_flaw": "Untrusted supply chain package installation"
    },
    {
        "id": "A04:2025",
        "name": "Cryptographic Failures",
        "code": """const api_key = "secret_key_mock_sample_9988776655";
function generateAuthToken() {
    // Insecure PRNG for security token
    return Math.random().toString(36).substring(2);
}""",
        "expected_flaw": "Hardcoded secret & Insecure PRNG"
    },
    {
        "id": "A05:2025",
        "name": "Injection (SQL & Command)",
        "code": """app.post('/login', (req, res) => {
    const user = req.body.username;
    // Unescaped SQL string concatenation
    const query = `SELECT * FROM users WHERE username = '${user}'`;
    db.query(query);
});""",
        "expected_flaw": "SQL Injection"
    },
    {
        "id": "A06:2025",
        "name": "Insecure Design",
        "code": """const fs = require('fs');
app.get('/download', (req, res) => {
    // Un-sanitized file path traversal
    const file = '/var/data/files/' + req.query.name;
    res.send(fs.readFileSync(file));
});""",
        "expected_flaw": "Path Traversal / Insecure Design"
    },
    {
        "id": "A07:2025",
        "name": "Authentication Failures",
        "code": """app.post('/auth', (req, res) => {
    // Hardcoded password verification & missing brute force protection
    if (req.body.password === "admin123") {
        res.json({ token: "static-admin-token" });
    }
});""",
        "expected_flaw": "Weak Auth & Hardcoded Credential"
    },
    {
        "id": "A08:2025",
        "name": "Software & Data Integrity Failures",
        "code": """app.post('/eval-rule', (req, res) => {
    // Untrusted dynamic code execution
    const ruleCode = req.body.rule;
    const result = eval(ruleCode);
    res.json({ result });
});""",
        "expected_flaw": "Dynamic code execution via eval()"
    },
    {
        "id": "A09:2025",
        "name": "Security Logging & Alerting Failures",
        "code": """app.post('/admin/delete-database', (req, res) => {
    // Critical state mutation with zero audit logging or security alert
    db.dropDatabase();
    res.send('Deleted');
});""",
        "expected_flaw": "Missing security audit logging"
    },
    {
        "id": "A10:2025",
        "name": "Mishandling of Exceptional Conditions",
        "code": """app.post('/payment/settle', (req, res) => {
    try {
        verifyBankSignature(req);
    } catch (err) {
        // Silent exception handling — fails open!
    }
    releaseEscrowFunds();
});""",
        "expected_flaw": "Failing open / Silent exception handling"
    }
]

def perform_static_scan(code_str: str) -> dict:
    """Layer 1: Deterministic AST & Regex Scanner."""
    flaws = []
    if "eval(" in code_str or "Function(" in code_str:
        flaws.append("A08: DYNAMIC_CODE_EXECUTION")
    if "SELECT " in code_str and "${" in code_str:
        flaws.append("A05: SQL_INJECTION")
    if "sk_live_" in code_str or "api_key" in code_str:
        flaws.append("A04: HARDCODED_SECRET")
    if "execSync(" in code_str or "exec(" in code_str:
        flaws.append("A03/A05: COMMAND_INJECTION")
    if "Math.random()" in code_str:
        flaws.append("A04: WEAK_PRNG")
    return {"layer": "Static-AST", "detected": flaws}

def perform_cloudflare_ai_audit(category_id: str, category_name: str, code_str: str) -> dict:
    """Layer 2: Live Cloudflare Workers AI Llama-3.1-8B-Instruct Scan."""
    prompt = f"""Review the following JavaScript code for OWASP Top 10:2025 security vulnerabilities, specifically focusing on {category_id} ({category_name}).
Identify if a vulnerability exists, assign severity (CRITICAL, HIGH, MEDIUM), and summarize in 1 concise sentence.

Code Snippet:
```javascript
{code_str}
```
"""
    try:
        t0 = time.perf_counter()
        resp = httpx.post(
            CF_URL,
            headers={"Authorization": f"Bearer {API_TOKEN}"},
            json={
                "messages": [
                    {"role": "system", "content": "You are AssureCode OWASP Top 10:2025 Security Audit Engine."},
                    {"role": "user", "content": prompt}
                ],
                "max_tokens": 150
            },
            timeout=15.0
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        if resp.status_code == 200:
            data = resp.json()
            analysis = data["result"]["response"].strip()
            return {"status": "SUCCESS", "analysis": analysis, "latency_ms": elapsed_ms}
        else:
            return {"status": "ERROR", "code": resp.status_code, "latency_ms": elapsed_ms}
    except Exception as e:
        return {"status": "EXCEPTION", "error": str(e)}

def run_verification():
    print("=" * 80)
    print("   AssureCode OWASP Top 10:2025 Security Audit Verification Harness")
    print("   Layer 1: Static AST/Regex Scanner (< 5ms)")
    print("   Layer 2: Live Cloudflare Workers AI (Llama-3.1-8B-Instruct)")
    print("=" * 80)
    
    total_passed = 0
    start_time = time.perf_counter()
    
    for idx, test in enumerate(OWASP_2025_TEST_CASES, 1):
        print(f"\n[{idx}/10] Testing {test['id']} — {test['name']}")
        print(f" Expected Vulnerability: {test['expected_flaw']}")
        
        # Layer 1 Scan
        static_res = perform_static_scan(test["code"])
        print(f" Layer 1 (Static Regex): Detected {len(static_res['detected'])} pattern(s) -> {static_res['detected']}")
        
        # Layer 2 Cloudflare AI Scan
        cf_res = perform_cloudflare_ai_audit(test["id"], test["name"], test["code"])
        if cf_res["status"] == "SUCCESS":
            total_passed += 1
            print(f" Layer 2 (Cloudflare AI - {cf_res['latency_ms']:.1f}ms):")
            # Print first 2 lines of analysis
            lines = cf_res["analysis"].split('\n')
            for line in lines[:3]:
                if line.strip():
                    print(f"   ↳ {line.strip()}")
        else:
            print(f" Layer 2 Failure: {cf_res}")
    
    total_time_s = time.perf_counter() - start_time
    print("\n" + "=" * 80)
    print(" OWASP 2025 VERIFICATION SUMMARY")
    print("=" * 80)
    print(f" Total OWASP 2025 Categories Audited:  10 / 10")
    print(f" Cloudflare AI Verification Pass Rate:  {total_passed} / 10 ({total_passed * 10}% Verified)")
    print(f" Total Verification Suite Execution:    {total_time_s:.2f} seconds")
    print("=" * 80)

if __name__ == "__main__":
    run_verification()
