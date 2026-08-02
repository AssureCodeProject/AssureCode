## 2026-07-28T13:35:36Z
You are teamwork_preview_worker_sprint6_iteration3. Your working directory is `C:\Users\hp\AssureCode\.agents\teamwork_preview_worker_sprint6_iteration3`.

Your task is to implement 2 targeted bugfixes for Sprint 6:

1. **Idempotency JSONB Constraint Fix (`apps/api-gateway/src/middleware/idempotency.ts`)**:
   - In `withIdempotency` in-flight reservation query: `INSERT INTO idempotency_keys (key, contract_id, response_json, status_code, expires_at) VALUES ($1, $2, '{}'::jsonb, 0, NOW() + INTERVAL '24 hours') ON CONFLICT (key) DO NOTHING RETURNING key`, pass `'{}'::jsonb` instead of `NULL` for `response_json` to prevent Postgres error 23502 (`null value in column "response_json" violates not-null constraint`).
   - In `apps/api-gateway/test/idempotency-concurrency.test.ts`: Fix query at line 54 to query table `merkle_ledger` instead of `ledger`.

2. **Merkle Hash Verification Parity Fix (`packages/ledger-client/src/index.ts`)**:
   - Update `verifyChain(contractId)` to compute the expected SHA-256 hash using PostgreSQL's exact digest formula:
     `SELECT sequence_number, contract_id, previous_hash, current_hash, payload, encode(digest((to_jsonb(payload) || to_jsonb(previous_hash))::text, 'sha256'), 'hex') AS computed_hash FROM merkle_ledger WHERE contract_id = $1 ORDER BY sequence_number ASC`
   - Compare `row.current_hash === row.computed_hash` and `row.previous_hash === prev_hash`. This ensures Node verification matches PostgreSQL `append_ledger` hash generation with 100% mathematical parity.

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results or create facade implementations.

Run build (`npm run build`) and test suites (`npm test` in `apps/api-gateway` and `packages/ledger-client`) to verify all tests pass cleanly. Send completion report via send_message to parent.
