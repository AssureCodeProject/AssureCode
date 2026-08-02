## 2026-07-28T18:44:11Z
<USER_REQUEST>
You are teamwork_preview_worker_sprint6_a. Your working directory is `C:\Users\hp\AssureCode\.agents\teamwork_preview_worker_sprint6_a`.

Your task is to implement Sprint 6.1, Sprint 6.3, and Sprint 6.4 according to the Explorer analysis reports (`C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint6_1\analysis_sprint6_1.md` and `C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint6_3\analysis_sprint6_3.md`).

Key Deliverables:
1. **Sprint 6.1 — Idempotency keys end-to-end**:
   - `packages/shared/src/index.ts`: Add `IdempotencyKeyHeaderSchema`.
   - SQL migration `V003__idempotency.sql`: Create `idempotency_keys(key VARCHAR(255) PRIMARY KEY, contract_id VARCHAR(255), response_json JSONB NOT NULL, status_code INT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL)`.
   - `apps/api-gateway`: Add idempotency middleware wrapping mutating gateway endpoints (`initialize`, `lock`, `generate-tests`, `escrow`, `settle`). Replaying a key returns cached response JSON + status code without re-executing business logic or creating duplicate ledger entries.
2. **Sprint 6.3 — Single-fire settlement**:
   - SQL migration `V004__settlements.sql`: Create `settlements(contract_id VARCHAR(255) PRIMARY KEY, status VARCHAR(50) NOT NULL, transfer_id VARCHAR(255), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`.
   - `apps/settlement-worker/src/worker.ts`: Perform `INSERT INTO settlements ... ON CONFLICT DO NOTHING`. Gate on 5-signal oracle inside same transaction as `INVOICE` ledger append. Prevent concurrent double payouts.
3. **Sprint 6.4 — Ledger verification endpoint + tamper test**:
   - `packages/ledger-client/src/index.ts`: Enhance `verifyChain` to recalculate SHA-256 hash across sequence.
   - `apps/api-gateway/src/server.ts`: Add route `GET /api/contracts/:contractId/verify` returning HTTP 200 `{ contractId, valid: true }` when valid, or HTTP 409 `{ contractId, valid: false }` when tampered.
   - Red-team test asserting tampered `merkle_ledger.current_hash` yields HTTP 409 `{ valid: false }`.

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Run build and unit tests for modified components to confirm everything compiles and passes cleanly. Send your completion report via send_message to parent.
</USER_REQUEST>
