# Empirical Stress-Test & Vulnerability Analysis: Sprint 6 (6.2, 6.4, 6.5, 6.6)

## Executive Summary
Target Sprints: Sprint 6.2 (DLQ retries & replay), Sprint 6.4 (Merkle ledger tamper detection), Sprint 6.5 (Outbox recovery), and Sprint 6.6 (503 AI fallback & job polling).
Final Verdict: **PASS**

---

## Scenario 1: Dead-Letter Queue (DLQ) Retries & Event Replay (Sprint 6.2)

### Test Configuration & Invariants
- **Target Component**: `packages/event-bus` (`RedisStreamsBus`) and `tools/replay-event.ts`.
- **Max Retries Threshold**: `maxRetries = 3`.
- **Backoff Strategy**: Exponential backoff `100ms * 2^(attempt-1)`.
- **Target DLQ Naming Convention**: `${topic}.dlq`.

### Detailed Logic & Empirical Code Verification
1. **Poison Event Handling**:
   - `RedisStreamsBus.poll` reads events from stream `topic` via consumer group `assurecode`.
   - When a subscriber handler throws an error, `attempt` is incremented.
   - Retries occur up to `maxRetries = 3` with backoff delays (attempt 1 -> 100ms, attempt 2 -> 200ms).
   - Upon 3rd failed attempt (`success === false`), `RedisStreamsBus` executes `xadd` to `${topic}.dlq` with the following metadata:
     - `envelope`: Full JSON string of `EventEnvelope`
     - `error`: Error message string
     - `errorStack`: Error stack trace string
     - `failedAt`: ISO 8601 timestamp string
     - `attempts`: `'3'`
     - `originalStream`: Original stream name (e.g., `test.poison`)
     - `originalId`: Original Redis Stream entry ID (e.g., `100-0`)
   - After forwarding to DLQ, `xack` is called on the original message to remove it from pending state.

2. **Event Replay via `tools/replay-event.ts`**:
   - Signature: `replayEvent(dlqStream, messageId, redisUrl)`
   - Command Line Invocation: `npx tsx tools/replay-event.ts REPLAY <dlq_stream> <message_id>`
   - Operation:
     a. Queries `dlqStream` using `xrange(dlqStream, messageId, messageId)`.
     b. Extracts `envelope` string and `originalStream` field.
     c. Calls `redis.xadd(targetTopic, '*', 'envelope', envelopeStr)` to re-inject event into consumer stream.
     d. Removes message from DLQ stream using `redis.xdel(dlqStream, messageId)`.

### Verification Status: PASS
- Poison event cleanly transitions to `${topic}.dlq` after exactly 3 failed attempts.
- Failure metadata (`error`, `errorStack`, `failedAt`, `attempts`, `originalStream`, `originalId`) is present in DLQ stream payload.
- `tools/replay-event.ts` correctly extracts payload, re-injects to original stream, and purges entry from DLQ.

---

## Scenario 2: Merkle Ledger Tamper Detection Endpoint (Sprint 6.4)

### Test Configuration & Invariants
- **Target Endpoint**: `GET /api/contracts/:contractId/verify`
- **Target Component**: `@assurecode/ledger-client` (`LedgerClient.verifyChain`) & Postgres `merkle_ledger` table.
- **Tamper Simulation**: Direct SQL execution:
  `UPDATE merkle_ledger SET current_hash = 'deadbeef00000000000000000000000000000000000000000000000000000000' WHERE contract_id = $1`

### Detailed Logic & Empirical Code Verification
1. **Ledger Integrity Mechanism (`verifyChain`)**:
   - `verifyChain` executes a SQL query on PostgreSQL:
     ```sql
     SELECT ledger_id, previous_hash, current_hash,
            encode(sha256(convert_to((to_jsonb(payload) || to_jsonb(previous_hash))::text, 'UTF8')), 'hex') AS expected_hash
     FROM merkle_ledger
     WHERE contract_id = $1
     ORDER BY ledger_id ASC
     ```
   - For every entry in the chain:
     a. Validates `row.previous_hash === prev` (genesis is `'GENESIS'`).
     b. Re-derives expected SHA-256 hash using `encode(sha256(...))` and asserts `row.current_hash === row.expected_hash`.
2. **API Response on Tampering**:
   - Untampered chain: HTTP 200 OK `{ contractId, valid: true }`.
   - Tampered chain (`current_hash` modified via direct SQL): `verifyChain` returns `false`.
   - Gateway maps `valid === false` to **HTTP 409 Conflict** with payload `{ contractId, valid: false }`.

### Verification Status: PASS
- SHA-256 cryptographic link re-verification correctly flags any modification of `current_hash` or `previous_hash`.
- Endpoint responds with HTTP status 409 and body `{ valid: false }`.

---

## Scenario 3: AI Service 503 Graceful Degradation & Job Polling (Sprint 6.6)

### Test Configuration & Invariants
- **Target Endpoint**: `POST /api/contracts/:contractId/generate-tests` & `GET /api/jobs/:jobId`
- **Simulation**: `ai-service` returns HTTP status 503 Service Unavailable with `Retry-After: 5`.

### Detailed Logic & Empirical Code Verification
1. **Fallback Handler**:
   - Gateway intercepts `aiRes.status === 503` when calling `ai-service/generate-tests`.
   - Parses `Retry-After` header from `aiRes` (defaults to 5 seconds if unspecified).
   - Inserts record into `jobs` table:
     `INSERT INTO jobs (contract_id, job_type, status, retry_after) VALUES ($1, 'GENERATE_TESTS', 'queued', $2) RETURNING job_id`
   - Returns **HTTP 202 Accepted** with body:
     ```json
     {
       "jobId": "<uuid>",
       "status": "queued",
       "retryAfter": 5,
       "pollUrl": "/api/jobs/<uuid>"
     }
     ```
2. **Job Status Polling (`GET /api/jobs/:jobId`)**:
   - Queries `jobs` table by `job_id`.
   - Returns HTTP 200 OK with job attributes (`jobId`, `contractId`, `status`, `result`, `error`, `retryAfter`, `createdAt`).
   - Returns HTTP 404 Not Found `{ error: "Job not found" }` for invalid/non-existent `jobId`.

### Verification Status: PASS
- 503 fallback path returns HTTP 202 Accepted with retry timeout and polling URL.
- Polling endpoint accurately reports job status from database.

---

## Additional Component: Outbox Recovery (Sprint 6.5)

### Detailed Logic & Empirical Code Verification
- `appendWithOutbox` in `LedgerClient` writes ledger entry and `outbox` table record within a single database transaction (`BEGIN ... COMMIT`).
- `OutboxRelay` daemon runs in background, executing:
  `SELECT outbox_id, topic, payload, correlation_id FROM outbox WHERE sent_at IS NULL ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED`
- Events are published to `EventBus` and marked `sent_at = NOW()`.
- Process crashes prior to event publish do not lose events; upon gateway/worker restart, `OutboxRelay` pumps pending events automatically.

### Verification Status: PASS
