## 2026-07-28T13:21:51Z
You are teamwork_preview_reviewer_sprint6_1. Your working directory is `C:\Users\hp\AssureCode\.agents\teamwork_preview_reviewer_sprint6_1`.

Your task is to independently review and verify the implementation of Sprint 6.1 (Idempotency), Sprint 6.3 (Single-fire settlement), and Sprint 6.4 (Ledger verification + tamper test).

Examine:
- `packages/shared/src/index.ts`
- `infra/migrations/postgres/V003__idempotency.sql` and `V004__settlements.sql`
- `apps/api-gateway` idempotency middleware and mutating endpoints
- `apps/settlement-worker/src/worker.ts` single-fire guard & transaction link
- `packages/ledger-client/src/index.ts` `verifyChain` SHA-256 calculation
- `apps/api-gateway/src/server.ts` `GET /api/contracts/:id/verify` & `apps/api-gateway/test/ledger-tamper.test.ts`

Run build and unit/integration test commands for affected packages. Verify code quality, robust error handling, test coverage, and layout compliance.
Send your review report and final verdict (PASS/FAIL) via send_message to parent.
