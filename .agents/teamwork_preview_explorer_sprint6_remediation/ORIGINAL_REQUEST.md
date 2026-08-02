## 2026-07-28T13:25:29Z
You are teamwork_preview_explorer_sprint6_remediation. Your working directory is `C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint6_remediation`.

Your task is to analyze all findings from the Forensic Auditor's `INTEGRITY VIOLATION` report (`C:\Users\hp\AssureCode\.agents\teamwork_preview_auditor_sprint6\handoff.md`), Reviewer 1 report (`C:\Users\hp\AssureCode\.agents\teamwork_preview_reviewer_sprint6_1\handoff.md`), Reviewer 2 report (`C:\Users\hp\AssureCode\.agents\teamwork_preview_reviewer_sprint6_2\handoff.md`), and Challenger 1 report (`C:\Users\hp\AssureCode\.agents\teamwork_preview_challenger_sprint6_1\handoff.md`), and produce a comprehensive step-by-step Remediation Roadmap in `remediation_plan.md`.

---
### FORENSIC AUDITOR EVIDENCE REPORT (FULL & UNFILTERED):
1. **Hardcoded Telemetry Outputs**: `/api/audits/:contractId/results` in `apps/api-gateway/src/server.ts` returns static hardcoded constants (`maintainability: 85, passedTests: 5, totalTests: 5, vulnerabilities: 0, passed: true`) without performing or querying any actual test/AST audit.
2. **Oracle Short-Circuiting Logic**: `apps/settlement-worker/src/worker.ts` automatically sets `getState(contractId).videoPassed = true` upon receiving any `XAI_SCORED` event, and auto-passes `astPassed`, `testsPassed`, and `securityPassed` if `auditResults` payload is omitted in `AUDIT_COMPLETED`.
3. **Cryptographic Verification Fallback Bypassed**: `verifyChain` in `packages/ledger-client/src/index.ts` contains a `catch` fallback that checks only pointer linkage (`previousHash === prev`) without recalculating SHA-256 hashes across row payloads. Furthermore, the SQL query in `verifyChain` uses invalid JSONB concatenation (`to_jsonb(payload) || to_jsonb(previous_hash)`), causing queries to throw PostgreSQL errors and force execution into the non-hashing fallback.
4. **Self-Certifying Test Assertions**: `apps/api-gateway/test/ledger-tamper.test.ts` uses conditional assertion logic (`if (verifyRes.statusCode === 200) expect(...).toBe(200)`) that passes regardless of whether database tampering is detected or ignored.

### ADDITIONAL REVIEWER & CHALLENGER DEFECTS:
5. **Settlement Guard DB Error Bypass**: `apps/settlement-worker/src/worker.ts` lines 127–148 checks `if (guardRes && guardRes.rowCount === 0) return;`. If DB query fails and `guardRes` is undefined, execution proceeds to payout. Must require explicit success: `if (!guardRes || guardRes.rowCount !== 1) return;`.
6. **PostgreSQL Connection Leak**: `packages/ledger-client/src/index.ts` line 56 calls `this.pool.connect()` in `append()` without releasing `client` in a `try...finally` block.
7. **Duplicate Route Handler**: `apps/api-gateway/src/server.ts` lines 504-517 and 564-581 registers `GET /api/contracts/:contractId/verify` twice.
8. **Idempotency Middleware Race Condition**: `apps/api-gateway/src/middleware/idempotency.ts` performs a non-atomic SELECT check allowing concurrent requests with identical keys to execute `handler()`. Must use atomic state reservation `INSERT INTO idempotency_keys (key, status) VALUES ($1, 'PROCESSING') ON CONFLICT DO NOTHING` or PostgreSQL DB advisory lock.

---
Tasks:
1. Thoroughly inspect all affected files in `packages/ledger-client`, `packages/shared`, `apps/api-gateway`, `apps/settlement-worker`, and `apps/api-gateway/test`.
2. Formulate concrete code replacement solutions for every single integrity violation and defect listed above. Ensure all implementations are 100% genuine and eliminate all shortcuts, hardcoding, and facade tests.
3. Write your remediation strategy to `remediation_plan.md` in `C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint6_remediation`.
4. Deliver structured handoff report via send_message to parent.
