# Analysis Report: Sprint 6.4 & Sprint 6.6 Architecture & Strategy

**Agent**: teamwork_preview_explorer_sprint6_3  
**Working Directory**: `C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint6_3`  
**Date**: 2026-07-28  

---

## 1. Executive Summary

This investigation analyzes two critical resilience and security capabilities of the AssureCode workspace:
1. **Sprint 6.4 — Ledger Verification Endpoint & Tamper Test**:
   - **Goal**: Expose `GET /api/contracts/:id/verify` to validate Merkle hash chain integrity using `LedgerClient.verifyChain`.
   - **Tamper Resilience**: Implement a red-team test that modifies `merkle_ledger.current_hash` and verifies that `GET /api/contracts/:id/verify` returns HTTP `409 { valid: false }`.
2. **Sprint 6.6 — Graceful Degradation for LLM & S3 Services**:
   - **Goal**: Ensure continuous operation when upstream services (`ai-service`, LLM provider, or S3/LocalStack) are overloaded or unavailable.
   - **AI Service 503**: `ai-service` returns HTTP `503 Service Unavailable` with a `Retry-After` header when overloaded or when LLM providers fail.
   - **Gateway Job Queue & Polling**: The API Gateway maps HTTP 503 responses to a user-visible `"test generation queued"` state (HTTP 202 Accepted) and tracks job progress in a `jobs` PostgreSQL table polled via `GET /api/jobs/:jobId`.
   - **S3 Persistence Fallback**: S3 artifact uploads retry with exponential backoff and fall back to local disk storage under `S3_FALLBACK_DIR`.

---

## 2. Current State vs Requirements Assessment Matrix

| Target Feature | Feature Requirement | Current Codebase State | Gap Analysis / Action Required |
|---|---|---|---|
| **6.4 Verification Endpoint** | `GET /api/contracts/:id/verify` calls `LedgerClient.verifyChain` | Missing in `apps/api-gateway/src/server.ts` | Add route `GET /api/contracts/:contractId/verify` returning 200 `{ contractId, valid: true }` or 409 `{ contractId, valid: false }`. |
| **6.4 Chain Verification** | `LedgerClient.verifyChain` re-derives/verifies Merkle SHA-256 hashes | Lines 91–104 in `packages/ledger-client/src/index.ts` only check link sequence `row.previousHash === prev` | Enhance `verifyChain` to re-derive/validate SHA-256 hashes against stored `current_hash` so single-row and tail tampering are detected. |
| **6.4 Tamper Test** | Red-team test updates `merkle_ledger.current_hash` and asserts 409 response | No tamper test exists | Write integration test `apps/api-gateway/test/ledger-tamper.test.ts` executing DB update and asserting 409 response. |
| **6.6 AI Service 503** | `ai-service` returns 503 + `Retry-After` header on LLM overload/unavailability | LLM adapters in `apps/ai-service/app/ports/llm_client.py` fallback silently to `FakeLlmClient`; `test_gen.py` doesn't raise 503 | Add `LlmUnavailableError` exception, custom 503 handler, and `Retry-After` header in `apps/ai-service/app/routes/test_gen.py`. |
| **6.6 Gateway Job Queue** | Gateway maps 503 to queued state & `jobs` table polling | `POST /api/contracts/:contractId/generate-tests` (lines 143-163) returns 502 on non-200 | Create `jobs` table (`V005__jobs.sql`), map 503 to HTTP 202 queued response, and add `GET /api/jobs/:jobId` polling route. |
| **6.6 S3 Backoff & Fallback** | S3 writes retry with exponential backoff and fall back to `S3_FALLBACK_DIR` local volume | `S3ArtifactStore` in `apps/ai-service/app/ports/artifact_store.py` (lines 86-96) falls back immediately to in-memory store | Add retry loop with exponential backoff in `upload()`, add `S3_FALLBACK_DIR` setting, and create `LocalFileArtifactStore`. |

---

## 3. Sprint 6.4 — Detailed Findings & Implementation Strategy

### 3.1 Ledger Verification Route (`GET /api/contracts/:contractId/verify`)
- **File to Edit**: `apps/api-gateway/src/server.ts`
- **Location**: Insert after line 414 (following `GET /api/contracts/:contractId`).
- **Proposed Implementation**:
  ```typescript
  server.get<{
    Params: { contractId: string };
    Reply: { contractId: string; valid: boolean } | { error: string };
  }>('/api/contracts/:contractId/verify', async (request, reply) => {
    const { contractId } = request.params;
    const chain = await ledgerClient.getChain(contractId);
    if (chain.length === 0) {
      return reply.status(404).send({ error: 'Contract not found' });
    }

    const isValid = await ledgerClient.verifyChain(contractId);
    if (!isValid) {
      return reply.status(409).send({ contractId, valid: false });
    }

    return reply.status(200).send({ contractId, valid: true });
  });
  ```

### 3.2 Robust Chain Verification (`LedgerClient.verifyChain`)
- **File to Edit**: `packages/ledger-client/src/index.ts`
- **Current Behavior** (lines 91–104):
  `verifyChain` iterates over rows checking `if (row.previousHash !== prev) return false;`. If an attacker updates `current_hash` on a 1-row chain or the last row of a multi-row chain, linkage checks alone will pass.
- **Enhanced Verification Logic**:
  In addition to link matching (`row.previousHash === prev`), execute a database integrity query or compute the expected SHA-256 hash:
  `encode(sha256(convert_to((to_jsonb(payload) || to_jsonb(previous_hash))::text, 'UTF8')), 'hex')`.
  If `row.currentHash !== expectedHash` or `row.previousHash !== prev`, return `false`.
  ```typescript
  async verifyChain(contractId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT ledger_id, previous_hash, current_hash,
                encode(sha256(convert_to((to_jsonb(payload) || to_jsonb(previous_hash))::text, 'UTF8')), 'hex') AS expected_hash
         FROM merkle_ledger
         WHERE contract_id = $1
         ORDER BY ledger_id ASC`,
        [contractId]
      );
      if (res.rows.length === 0) return true;
      let prev = 'GENESIS';
      for (const row of res.rows) {
        if (row.previous_hash !== prev) return false;
        if (row.current_hash !== row.expected_hash) return false;
        prev = row.current_hash;
      }
      return true;
    } finally {
      client.release();
    }
  }
  ```

### 3.3 Red-Team Tamper Test Specification
- **File to Create**: `apps/api-gateway/test/ledger-tamper.test.ts`
- **Test Steps**:
  1. Initialize and lock contract `AC-TAMPER-TEST` via `POST /api/contracts/initialize` and `POST /api/contracts/AC-TAMPER-TEST/lock`.
  2. Verify initial integrity: `GET /api/contracts/AC-TAMPER-TEST/verify` -> returns `200 { valid: true }`.
  3. Red-team attack: Execute raw SQL:
     `UPDATE merkle_ledger SET current_hash = 'deadbeef00000000000000000000000000000000000000000000000000000000' WHERE contract_id = 'AC-TAMPER-TEST';`
  4. Query endpoint: `GET /api/contracts/AC-TAMPER-TEST/verify`.
  5. Assert response: HTTP status `409 Conflict`, body contains `{ valid: false }`.

---

## 4. Sprint 6.6 — Detailed Findings & Implementation Strategy

### 4.1 AI Service 503 & `Retry-After` Header
- **Files to Edit**:
  - `apps/ai-service/app/ports/llm_client.py`
  - `apps/ai-service/app/routes/test_gen.py`
- **Logic**:
  - In `app/ports/llm_client.py`: Define `LlmUnavailableError(message, retry_after=5)`. When LLM call fails, times out, or when `LLM_SERVICE_AVAILABLE=false` is set (circuit breaker open), raise `LlmUnavailableError`.
  - In `app/routes/test_gen.py`:
    ```python
    @router.post("", response_model=GenerateTestsResponse)
    def generate_tests(
        req: GenerateTestsRequest,
        llm: LlmClient = Depends(get_llm_client),
        store: ArtifactStore = Depends(get_artifact_store),
    ) -> GenerateTestsResponse:
        try:
            prompt = PROMPT_TEMPLATE.format(...)
            test_code = llm.generate(prompt, max_tokens=2048)
        except LlmUnavailableError as err:
            raise HTTPException(
                status_code=503,
                detail=str(err),
                headers={"Retry-After": str(err.retry_after)},
            )
    ```

### 4.2 Gateway Job Queue, Queued State, and `GET /api/jobs/:jobId`
- **Files to Edit / Create**:
  - Migration: `infra/migrations/postgres/V005__jobs.sql`
  - Route handler: `apps/api-gateway/src/server.ts`
- **Database Schema (`V005__jobs.sql`)**:
  ```sql
  CREATE TABLE IF NOT EXISTS jobs (
      job_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id  TEXT NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
      job_type     TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'queued', -- queued, processing, completed, failed
      result       JSONB,
      error        TEXT,
      retry_after  INT DEFAULT 5,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ```
- **Gateway Mapping (`POST /api/contracts/:contractId/generate-tests`)**:
  - When `aiRes.status === 503`:
    1. Read `Retry-After` header from `aiRes` (parse as int, default 5).
    2. Insert record into `jobs`: `INSERT INTO jobs (contract_id, job_type, status, retry_after) VALUES ($1, 'GENERATE_TESTS', 'queued', $2) RETURNING job_id`.
    3. Return HTTP `202 Accepted`:
       ```json
       {
         "jobId": "<uuid>",
         "contractId": "AC-123",
         "status": "queued",
         "message": "Test generation queued due to AI service unavailability",
         "retryAfter": 5,
         "pollUrl": "/api/jobs/<uuid>"
       }
       ```
- **Polling Route (`GET /api/jobs/:jobId`)**:
  ```typescript
  server.get<{
    Params: { jobId: string };
  }>('/api/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params;
    const res = await pool.query('SELECT * FROM jobs WHERE job_id = $1', [jobId]);
    if (res.rows.length === 0) {
      return reply.status(404).send({ error: 'Job not found' });
    }
    const job = res.rows[0];
    return reply.status(200).send({
      jobId: job.job_id,
      contractId: job.contract_id,
      status: job.status,
      result: job.result,
      error: job.error,
      retryAfter: job.retry_after,
      createdAt: job.created_at,
    });
  });
  ```

### 4.3 S3 Exponential Backoff Retry & `S3_FALLBACK_DIR` Persistence
- **Files to Edit**:
  - Settings: `apps/ai-service/app/settings.py`
  - Storage Port: `apps/ai-service/app/ports/artifact_store.py`
- **Settings Addition**:
  ```python
  s3_fallback_dir: str = Field(default="./storage_fallback", alias="S3_FALLBACK_DIR")
  s3_max_retries: int = Field(default=3, alias="S3_MAX_RETRIES")
  ```
- **`LocalFileArtifactStore` Implementation**:
  ```python
  class LocalFileArtifactStore:
      """Local disk volume fallback when S3 is unavailable."""

      def __init__(self, fallback_dir: str = "./storage_fallback") -> None:
          self._fallback_dir = os.path.abspath(fallback_dir)

      def upload(self, key: str, body: str, content_type: str = "text/plain") -> str:
          file_path = os.path.join(self._fallback_dir, key)
          os.makedirs(os.path.dirname(file_path), exist_ok=True)
          with open(file_path, "w", encoding="utf-8") as f:
              f.write(body)
          return f"file://{file_path}"

      def download(self, key: str) -> str | None:
          file_path = os.path.join(self._fallback_dir, key)
          if not os.path.exists(file_path):
              return None
          with open(file_path, "r", encoding="utf-8") as f:
              return f.read()

      def exists(self, key: str) -> bool:
          file_path = os.path.join(self._fallback_dir, key)
          return os.path.exists(file_path)
  ```
- **S3 Upload Retry Loop with Exponential Backoff**:
  ```python
  def upload(self, key: str, body: str, content_type: str = "text/plain") -> str:
      if self._ensure_client():
          base_delay = 0.5
          for attempt in range(self._max_retries):
              try:
                  self._client.put_object(
                      Bucket=self._bucket, Key=key, Body=body.encode("utf-8"), ContentType=content_type
                  )
                  return f"s3://{self._bucket}/{key}"
              except Exception as exc:
                  if attempt == self._max_retries - 1:
                      break
                  time.sleep(base_delay * (2 ** attempt))
      
      return self._local_fallback.upload(key, body, content_type)
  ```

---

## 5. Step-by-Step Implementation Strategy Roadmap

1. **Step 1: Ledger Verification Endpoint & SQL Hash Check (Sprint 6.4)**
   - Update `packages/ledger-client/src/index.ts` to implement dual linkage + SHA256 hash re-derivation in `verifyChain`.
   - Add `GET /api/contracts/:contractId/verify` to `apps/api-gateway/src/server.ts`.
   - Write integration test `apps/api-gateway/test/ledger-tamper.test.ts`.

2. **Step 2: AI Service 503 Exception & `Retry-After` Header (Sprint 6.6)**
   - Add `LlmUnavailableError` to `apps/ai-service/app/ports/llm_client.py`.
   - Add HTTP 503 status code and `Retry-After: 5` response header in `apps/ai-service/app/routes/test_gen.py`.

3. **Step 3: Gateway Job Queue & Polling Endpoint (Sprint 6.6)**
   - Create migration `infra/migrations/postgres/V005__jobs.sql`.
   - In `apps/api-gateway/src/server.ts`, intercept 503 from `ai-service`, insert into `jobs`, and return 202 Accepted.
   - Implement `GET /api/jobs/:jobId` polling endpoint in `apps/api-gateway/src/server.ts`.

4. **Step 4: S3 Backoff Retry & Disk Fallback (Sprint 6.6)**
   - Add `S3_FALLBACK_DIR` and `S3_MAX_RETRIES` to `apps/ai-service/app/settings.py`.
   - Implement `LocalFileArtifactStore` and exponential backoff retry loop in `apps/ai-service/app/ports/artifact_store.py`.

---

## 6. Verification Method & Test Commands

### 6.1 Sprint 6.4 Verification
- **Run Unit/Integration Tests**:
  ```bash
  npm test --prefix apps/api-gateway
  ```
- **Manual Verification**:
  1. Lock contract: `curl -X POST http://localhost:4000/api/contracts/AC-V1/lock -H "Content-Type: application/json" -d '{"title":"Test","requirements":"reqs","budgetCents":100,"deadline":"2026-12-31"}'`
  2. Verify valid: `curl http://localhost:4000/api/contracts/AC-V1/verify` -> returns `200 {"contractId":"AC-V1","valid":true}`.
  3. Tamper row: execute psql `UPDATE merkle_ledger SET current_hash = 'bad' WHERE contract_id = 'AC-V1';`
  4. Verify invalid: `curl http://localhost:4000/api/contracts/AC-V1/verify` -> returns `409 {"contractId":"AC-V1","valid":false}`.

### 6.2 Sprint 6.6 Verification
- **Run Python pytest for ai-service**:
  ```bash
  pytest apps/ai-service/tests
  ```
- **Manual Verification**:
  1. Trigger test gen while LLM unavailable: `curl -i -X POST http://localhost:4000/api/contracts/AC-V1/generate-tests -H "Content-Type: application/json" -d '{"requirements":"test"}'`
  2. Confirm Gateway returns `202 Accepted` with `jobId` and `pollUrl`.
  3. Poll job: `curl http://localhost:4000/api/jobs/<jobId>` -> returns status `queued` / `completed`.
  4. Disconnect LocalStack/S3 and verify generated test is saved under `S3_FALLBACK_DIR` with `file://` URI.
