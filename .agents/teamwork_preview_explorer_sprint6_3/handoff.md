# Handoff Report: Sprint 6.4 & Sprint 6.6 Investigation

**Agent**: teamwork_preview_explorer_sprint6_3  
**Working Directory**: `C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint6_3`  
**Date**: 2026-07-28  

---

## 1. Observation

1. **Sprint 6.4 — Ledger Verification Route**:
   - `apps/api-gateway/src/server.ts` does **not** contain a route for `GET /api/contracts/:id/verify`.
   - `packages/ledger-client/src/index.ts` (lines 91–104) contains `verifyChain(contractId)` which only checks sequential hash linkage (`row.previousHash === prev`). Single-row chain tampering or tail hash modification is not detected if only checking linkage.

2. **Sprint 6.6 — AI Service 503 & Retry-After**:
   - `apps/ai-service/app/routes/test_gen.py` directly calls `llm.generate(prompt)`.
   - `apps/ai-service/app/ports/llm_client.py` Gemini/OpenAI clients catch errors and silently return fallback fixtures instead of throwing an unavailable exception or returning HTTP 503 with a `Retry-After` header.

3. **Sprint 6.6 — Gateway Job Queue & Polling**:
   - `apps/api-gateway/src/server.ts` (lines 143–163) handles `generate-tests` synchronously and returns 502 on non-200 responses from `ai-service`.
   - No `jobs` PostgreSQL table or `GET /api/jobs/:jobId` polling endpoint exists in the gateway.

4. **Sprint 6.6 — S3 Persistence Fallback**:
   - `apps/ai-service/app/ports/artifact_store.py` (lines 86–96) in `S3ArtifactStore.upload()` falls back immediately to `InMemoryArtifactStore` on exception without exponential backoff retry.
   - Local volume fallback to `S3_FALLBACK_DIR` is not implemented.

---

## 2. Logic Chain

1. **Sprint 6.4 Logic Chain**:
   - Without `GET /api/contracts/:id/verify`, clients cannot verify Merkle ledger integrity via HTTP.
   - Linkage-only checks in `verifyChain` pass if `current_hash` is tampered on a single-row chain or the last row because `previous_hash` of the tampered row still equals `prev`. Re-deriving SHA-256 (`encode(sha256(to_jsonb(payload) || to_jsonb(previous_hash)))`) inside Postgres ensures 100% detection of any tamper.
   - Mapping verification failures to HTTP 409 `{ valid: false }` provides an explicit status code for tamper alerts.

2. **Sprint 6.6 Logic Chain**:
   - Returning HTTP 503 + `Retry-After` header from `ai-service` signals upstream clients (API Gateway) that the LLM is temporarily unavailable/overloaded.
   - When the Gateway receives 503, creating a job in a persistent `jobs` table and returning HTTP 202 Accepted with a polling URL (`/api/jobs/:jobId`) prevents caller timeouts and provides graceful degradation ("test generation queued").
   - Implementing exponential backoff retries (3 attempts with 0.5s, 1.0s, 2.0s delays) in `S3ArtifactStore` absorbs transient S3 network glitches, and falling back to disk under `S3_FALLBACK_DIR` guarantees artifact durability even when S3 is completely down.

---

## 3. Caveats

- **Caveat 1**: The background worker/runner for processing queued jobs in the `jobs` table can be integrated into the gateway's event loop or run as a standalone worker process.
- **Caveat 2**: When artifacts are saved locally under `S3_FALLBACK_DIR`, the artifact URL format will be `file://<S3_FALLBACK_DIR>/<key>`. Consumers of the test bundle URL must handle local file URIs or local HTTP streaming routes if cross-host file access is needed in production.

---

## 4. Conclusion

- **Sprint 6.4 Solution**: Implement `GET /api/contracts/:contractId/verify` in `apps/api-gateway/src/server.ts`, upgrade `verifyChain` in `packages/ledger-client/src/index.ts` to include SQL SHA-256 hash re-derivation, and add `apps/api-gateway/test/ledger-tamper.test.ts`.
- **Sprint 6.6 Solution**:
  1. Add `LlmUnavailableError` and 503 + `Retry-After` header handling in `apps/ai-service`.
  2. Create `V005__jobs.sql`, map 503 to HTTP 202 queued response in `apps/api-gateway/src/server.ts`, and implement `GET /api/jobs/:jobId`.
  3. Add `S3_FALLBACK_DIR` setting, `LocalFileArtifactStore`, and 3-attempt exponential backoff retry loop in `apps/ai-service/app/ports/artifact_store.py`.

Full step-by-step strategy and patch guidance written to:
`C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint6_3\analysis_sprint6_3.md`

---

## 5. Verification Method

1. **Sprint 6.4 Verification**:
   - `npm test --prefix apps/api-gateway`
   - Manual test: Lock contract `AC-TEST`, query `GET /api/contracts/AC-TEST/verify` (returns 200 `{ valid: true }`), execute SQL `UPDATE merkle_ledger SET current_hash = 'tampered' WHERE contract_id = 'AC-TEST';`, query `GET /api/contracts/AC-TEST/verify` (returns 409 `{ valid: false }`).

2. **Sprint 6.6 Verification**:
   - `pytest apps/ai-service/tests`
   - Manual test: Simulate LLM 503 from `ai-service`, call `POST /api/contracts/AC-TEST/generate-tests` (returns 202 `{ jobId, status: "queued", retryAfter: 5 }`), call `GET /api/jobs/<jobId>` (returns job status).
   - Simulate S3 failure: Verify `generate_tests` writes test artifact to `./storage_fallback/contracts/AC-TEST/generated-tests/jest/tests.js`.
