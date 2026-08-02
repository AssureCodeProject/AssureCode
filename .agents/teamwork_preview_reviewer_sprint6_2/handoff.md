# Independent Review & Verification Report: Sprint 6.2, 6.5, and 6.6

## 1. Observation

### Sprint 6.2: Bounded Retries + DLQ & Event Replay Tool
- **File**: `packages/event-bus/src/index.ts` (lines 78-200)
  - `RedisStreamsBus` sets `maxRetries = 3` and `initialBackoffMs = 100`.
  - In `poll()` (lines 149-166), handler failures trigger a retry loop:
    ```typescript
    while (attempt < this.maxRetries) {
      attempt++;
      try {
        await handler(envelope);
        success = true;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          const backoff = this.initialBackoffMs * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    ```
  - When all 3 attempts fail (`!success`), line 169 publishes failure metadata to `${topic}.dlq` via `xadd`: fields `envelope`, `error`, `errorStack`, `failedAt`, `attempts`, `originalStream`, `originalId`.
  - Line 199 executes `await this.client.xack(topic, this.groupName, id)` so poison messages do not indefinitely block stream processing.
- **File**: `tools/replay-event.ts` (lines 11-79)
  - CLI script exports `replayEvent(dlqStream, messageId, redisUrl)`.
  - Queries `dlqStream` via `xrange`, extracts `envelope` and `originalStream`, re-publishes to active `targetTopic` via `xadd`, and deletes message from `dlqStream` via `xdel`.
  - Supports CLI invocations: `npx tsx tools/replay-event.ts REPLAY <dlq_stream> <message_id>` and `<dlq_stream> <message_id>`.

### Sprint 6.5: Transactional Outbox
- **File**: `infra/migrations/postgres/V005__outbox.sql`
  - Defines `outbox` table with `outbox_id`, `topic`, `payload`, `correlation_id`, `created_at`, `sent_at`.
  - Partial index `idx_outbox_unsent` on `outbox(created_at ASC) WHERE sent_at IS NULL`.
  - Defines PL/pgSQL stored procedure `append_ledger_and_outbox(...)` performing atomic ledger append and outbox staging within a single transaction.
- **File**: `infra/migrations/postgres/V006__jobs.sql`
  - Defines `jobs` table for gateway async job queueing: `job_id`, `contract_id`, `job_type`, `status`, `result`, `error`, `retry_after`, `created_at`, `updated_at`. Indexes on `status` and `contract_id`.
- **File**: `packages/event-bus/src/outbox-relay.ts` (lines 16-108)
  - `OutboxRelay` daemon polls unsent rows using:
    ```sql
    SELECT outbox_id, topic, payload, correlation_id
    FROM outbox
    WHERE sent_at IS NULL
    ORDER BY created_at ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
    ```
  - Publishes events to `EventBus` and updates `sent_at = NOW()`.
- **File**: `packages/ledger-client/src/index.ts`
  - `appendWithOutbox(...)` (lines 82-124) calls stored procedure `append_ledger_and_outbox`, with atomic transaction fallback if procedure is absent.
  - **Defect Found (Line 56)**:
    ```typescript
    async append(
      contractId: string,
      actionType: string,
      payload: Record<string, unknown>,
      client?: PoolClient,
    ): Promise<LedgerRow> {
      const run = async (c: PoolClient) => {
        const result = await c.query(
          'SELECT append_ledger($1, $2, $3::jsonb) AS row',
          [contractId, actionType, JSON.stringify(payload)],
        );
        return normalizeRow(result.rows[0].row as Record<string, unknown>);
      };
      if (client) return run(client);
      return run(await this.pool.connect()).finally(() => client || undefined);
    }
    ```
    `run(await this.pool.connect()).finally(() => client || undefined)` does **NOT** release the pool connection when `client` is undefined. The connection `c` is acquired via `this.pool.connect()`, but `.finally(...)` evaluates `client || undefined` (which is `undefined`). `c.release()` is never invoked!
- **File**: `apps/api-gateway/src/server.ts`
  - Initializes `OutboxRelay` and starts background daemon (`outboxRelay.start()`).
  - Calls `ledgerClient.appendWithOutbox(...)` in `/api/contracts/:contractId/generate-tests` and `/api/contracts/:contractId/lock`.
  - Shut down cleanly in `SIGTERM`/`SIGINT` handlers via `await outboxRelay.close()`.
  - **Defect Found (Lines 504-517 & 564-581)**:
    `GET /api/contracts/:contractId/verify` route handler is registered **twice** in `server.ts`.

### Sprint 6.6: LLM 503 / S3 Fallback
- **File**: `apps/ai-service/app/routes/test_gen.py` & `app/ports/llm_client.py`
  - Raises `HTTPException(status_code=503, detail=..., headers={"Retry-After": "5"})` when `LlmUnavailableError` occurs.
- **File**: `apps/ai-service/app/ports/artifact_store.py`
  - `LocalFileArtifactStore`: Disk volume fallback saving artifacts to `./storage_fallback` and returning `file://...` URLs.
  - `S3ArtifactStore`: Retries S3 put operations up to 3 times with exponential backoff before delegating to `LocalFileArtifactStore`.
- **File**: `apps/api-gateway/src/server.ts` (lines 173-199 & lines 522-562)
  - Intercepts HTTP 503 response from `ai-service /generate-tests`, extracts `Retry-After` header, creates job entry in PostgreSQL `jobs` table (`status='queued'`), and returns HTTP 202 Accepted with polling URL (`/api/jobs/:jobId`).
  - Exposes `GET /api/jobs/:jobId` polling endpoint querying PostgreSQL `jobs` table.

---

## 2. Logic Chain

1. **Sprint 6.2 Logic**:
   - `RedisStreamsBus.poll()` accurately implements bounded retries (`maxRetries = 3`) with exponential backoff (`100 * 2^(attempt-1)` ms).
   - Poison messages that exceed 3 attempts are safely routed to `${topic}.dlq` with complete failure metadata, and acknowledged (`xack`) from the original stream.
   - `tools/replay-event.ts` correctly extracts the envelope, target topic, and reinstates the event in Redis Streams while removing the DLQ entry.

2. **Sprint 6.5 Logic**:
   - `V005__outbox.sql` stored procedure `append_ledger_and_outbox` guarantees dual atomic write to `merkle_ledger` and `outbox`.
   - `OutboxRelay` uses `FOR UPDATE SKIP LOCKED` for reliable, lock-free concurrent polling.
   - **However**, in `packages/ledger-client/src/index.ts`, `LedgerClient.append(...)` leaks PostgreSQL client connections because `c.release()` is omitted when `client` is undefined. Since `max` pool size is 5, making 5 direct `append()` calls will exhaust the connection pool and hang all future database queries in the process.

3. **Sprint 6.6 Logic**:
   - `apps/ai-service` correctly returns 503 with `Retry-After: 5` header when LLM service is overloaded/unavailable.
   - `S3ArtifactStore` cleanly falls back to `LocalFileArtifactStore` disk persistence when S3/LocalStack is unreachable.
   - `api-gateway` handles 503 by inserting a record into `jobs` table and returning HTTP 202 with `pollUrl`, and `/api/jobs/:jobId` provides standard job polling.

4. **Integrity Check Logic**:
   - No hardcoded test results, facade implementations, or fake logic were detected. The retry mechanism, outbox polling daemon, fallback artifact store, and job queue are genuine implementations.

---

## 3. Caveats

- Interactive test execution (`npm test`, `pytest`) was interrupted due to shell permission prompt timeouts in the automated environment. Verification was performed via rigorous static analysis and manual code path tracing.
- `tools/replay-event.ts` is implemented and functional, though direct unit test coverage for `replayEvent` function in `packages/event-bus/test` could be extended.

---

## 4. Conclusion

**Verdict: FAIL (REQUEST_CHANGES)**

While the architectural design, integrity, and core feature implementations of Sprints 6.2, 6.5, and 6.6 are correct and robust, the implementation contains one **Major Defect** that will cause system degradation/deadlock in production:

1. **[MAJOR DEFECT] Connection Leak in `LedgerClient.append()`** (`packages/ledger-client/src/index.ts` line 56):
   `return run(await this.pool.connect()).finally(() => client || undefined);` fails to release the acquired `PoolClient` `c`.
   *Required Fix*:
   ```typescript
   const c = await this.pool.connect();
   try {
     return await run(c);
   } finally {
     c.release();
   }
   ```

2. **[MINOR DEFECT] Duplicate Route Registration** (`apps/api-gateway/src/server.ts` lines 564-581):
   `GET /api/contracts/:contractId/verify` is defined twice in `server.ts`.
   *Required Fix*: Remove lines 564-581.

---

## 5. Verification Method

1. **Verify Connection Leak Fix**:
   - Inspect `packages/ledger-client/src/index.ts` line 56.
   - Execute 10 consecutive calls to `ledgerClient.append(...)` without passing a `client` parameter and verify that connection pool does not exhaust.
2. **Verify Retries & DLQ**:
   - Run `npx vitest packages/event-bus/test/event-bus.test.ts` to confirm bounded retries, exponential backoff, and DLQ forwarding.
3. **Verify Replay Tool**:
   - Run `npx tsx tools/replay-event.ts REPLAY <dlq_stream> <message_id>`.
4. **Verify AI 503 & Job Queue**:
   - Run `pytest apps/ai-service/tests/test_gen.py` to confirm 503 Retry-After behavior and `LocalFileArtifactStore` fallback.
