## 2026-07-28T18:58:12Z

You are teamwork_preview_worker_sprint6_remediation. Your working directory is `C:\Users\hp\AssureCode\.agents\teamwork_preview_worker_sprint6_remediation`.

Your task is to implement all 8 fixes detailed in the Remediation Plan (`C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint6_remediation\remediation_plan.md`):

1. **Defect #1 — Dynamic Audit Results (`apps/api-gateway/src/server.ts`)**:
   - Replace static hardcoded return in `/api/audits/:contractId/results` with dynamic query on `merkle_ledger` for `AUDIT_COMPLETED` / `CI_PASSED` events, returning computed audit statistics.
2. **Defect #2 — Oracle Guarding (`apps/settlement-worker/src/worker.ts`)**:
   - Remove `XAI_SCORED` listener that auto-passed `videoPassed = true`. Require explicit `payload.auditResults` to pass audit signals; default missing signals to `false`.
3. **Defect #3 — Cryptographic SHA-256 Verification (`packages/ledger-client/src/index.ts`)**:
   - Fix SQL string concatenation in `verifyChain` and implement Node `crypto` SHA-256 recalculation across row payload and previous hash in both primary query processing and JavaScript `catch` fallback.
4. **Defect #4 — Red-Team Tamper Test Integrity (`apps/api-gateway/test/ledger-tamper.test.ts`)**:
   - Remove conditional `if (verifyRes.statusCode === 200)` assertions. Strictly assert HTTP status 409 `{ contractId, valid: false }` when DB hash tampering is executed. Implement genuine mock verification test asserting HTTP 409.
5. **Defect #5 — Settlement Guard Strict Execution (`apps/settlement-worker/src/worker.ts`)**:
   - Replace `if (guardRes && guardRes.rowCount === 0) return;` with strict check: `if (!guardRes || guardRes.rowCount !== 1) return;`. Abort settlement if DB query fails or lock is not acquired.
6. **Defect #6 — Connection Leak Fix (`packages/ledger-client/src/index.ts`)**:
   - Wrap `this.pool.connect()` in `append()` with a `try...finally` block to release `client` back to pool.
7. **Defect #7 — Remove Duplicate Route (`apps/api-gateway/src/server.ts`)**:
   - Delete duplicate registration of `GET /api/contracts/:contractId/verify` (lines 564–581).
8. **Defect #8 — Atomic Idempotency Middleware (`apps/api-gateway/src/middleware/idempotency.ts`)**:
   - Replace non-atomic SELECT with atomic in-flight DB reservation (`INSERT INTO idempotency_keys (key, status_code) VALUES ($1, 0) ON CONFLICT DO NOTHING`).

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Run builds and tests (`npm run build`, `npm test` / vitest) across modified components to ensure compilation and tests pass cleanly. Send your completion report via send_message to parent.
