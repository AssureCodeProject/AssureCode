## 2026-07-28T18:44:11Z
You are teamwork_preview_worker_sprint6_b. Your working directory is `C:\Users\hp\AssureCode\.agents\teamwork_preview_worker_sprint6_b`.

Your task is to implement Sprint 6.2, Sprint 6.5, and Sprint 6.6 according to the Explorer analysis reports (`C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint6_2\analysis_sprint6_2.md` and `C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint6_3\analysis_sprint6_3.md`).

Key Deliverables:
1. **Sprint 6.2 — Bounded retries + dead-letter stream**:
   - `packages/event-bus/src/index.ts`: In `RedisStreamsBus.poll()`, implement `maxRetries = 3` with exponential backoff (`100ms * 2^(attempt-1)`). Forward poison messages to `${topic}.dlq` with failure metadata before issuing `xack()`.
   - `tools/replay-event.ts`: Create CLI tool supporting `REPLAY <dlq_stream> <message_id>` to re-publish poison events back to target stream.
   - `packages/event-bus/test/event-bus.test.ts`: Add test asserting 3 failed retries land in `*.dlq`.
2. **Sprint 6.5 — Transactional outbox**:
   - SQL migration `V005__outbox.sql`: Create `outbox(outbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), topic VARCHAR(255) NOT NULL, payload JSONB NOT NULL, correlation_id VARCHAR(255), created_at TIMESTAMPTZ DEFAULT NOW(), sent_at TIMESTAMPTZ)`.
   - `packages/event-bus/src/outbox-relay.ts`: Implement `OutboxRelay` background daemon polling unsent outbox rows, publishing to `RedisStreamsBus`, and updating `sent_at`.
   - `packages/ledger-client/src/index.ts`: Add `appendWithOutbox(...)` method.
   - `apps/api-gateway/src/server.ts`: Integrate `appendWithOutbox(...)` on mutating endpoints and start `OutboxRelay`.
3. **Sprint 6.6 — Graceful degradation (LLM 503 & S3 fallback)**:
   - `apps/ai-service`: Raise FastAPI `HTTPException(status_code=503, headers={"Retry-After": "5"}, detail=...)` when LLM is unavailable.
   - SQL migration `V006__jobs.sql`: Create `jobs` table schema.
   - `apps/api-gateway`: Intercept 503 from `ai-service`, queue job in `jobs` table, return HTTP 202 Accepted `{ jobId, status: 'queued', retryAfter: 5, pollUrl: '/api/jobs/:jobId' }`, and implement `GET /api/jobs/:jobId` polling endpoint.
   - `apps/ai-service`: Implement `S3_FALLBACK_DIR` disk storage fallback (`LocalFileArtifactStore`) and 3-attempt exponential backoff retry loop in `S3ArtifactStore.upload()`.
