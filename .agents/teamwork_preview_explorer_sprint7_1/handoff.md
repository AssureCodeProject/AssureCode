# Sprint 7 Architecture & Microservice Exploration Report

## 1. Observation

This investigation examined all 5 core microservices under `apps/` along with shared infrastructure in `packages/` within `C:\Users\hp\AssureCode`. Below are verbatim observations with exact file paths, line numbers, exported interfaces, routes, configuration parameters, event topics, and code snippets.

---

### Shared Package Layer (`packages/`)

#### 1. `@assurecode/shared` (`packages/shared/src/index.ts`)
- **Event Topics** (Lines 10-28):
```ts
export const EVENT_TOPICS = {
  CONTRACT_INITIALIZED: 'contract.initialized',
  CONTRACT_LOCKED: 'contract.locked',
  CODE_PUSH_RECEIVED: 'code.push.received',
  CI_SANDBOX_READY: 'ci.sandbox.ready',
  CI_AST_COMPLETED: 'ci.ast.completed',
  CI_TESTS_COMPLETED: 'ci.tests.completed',
  SECURITY_SCAN_COMPLETED: 'security.scan.completed',
  AUDIT_COMPLETED: 'audit.completed',
  TESTS_GENERATED: 'tests.generated',
  SCOPE_CHECKED: 'scope.checked',
  VIDEO_VERIFIED: 'video.verified',
  XAI_SCORED: 'xai.scored',
  SETTLEMENT_REQUESTED: 'settlement.requested',
  SETTLEMENT_REJECTED: 'settlement.rejected',
  SETTLEMENT_COMPLETED: 'settlement.completed',
  ESCROW_LOCKED: 'escrow.locked',
  PAYMENT_FAILED: 'payment.failed',
} as const;
```
- **Domain DTOs & Zod Schemas**:
  - `EventEnvelopeSchema` (Lines 33-40): `id`, `topic`, `timestamp`, `correlationId`, `payload`.
  - `InitializeContractSchema` (Lines 44-50): `title`, `requirements`, `budgetCents`, `deadline`.
  - `ContractLockedSchema` (Lines 65-73): `contractId`, `hash`, `timestamp`, `title`, `budgetCents`, `deadline`.
  - `TestsGeneratedSchema` (Lines 77-85): `contractId`, `s3Key`, `s3Url`, `testCount`, `framework`, `generatedAt`.
  - `AuditResultsSchema` (Lines 89-97): `maintainability`, `passedTests`, `totalTests`, `vulnerabilities`, `passed`, `scanDuration`.
  - `LedgerEntrySchema` (Lines 101-110): `ledgerId`, `contractId`, `actionType`, `payload`, `previousHash`, `currentHash`, `createdAt`.
  - `SettlementRequestedSchema` (Lines 133-139), `SettlementCompletedSchema` (Lines 141-147), `SettlementRejectedSchema` (Lines 149-154).
  - `IdempotencyKeyHeaderSchema` (Lines 158-162): `idempotency-key` & `x-idempotency-key`.

#### 2. `@assurecode/config` (`packages/config/src/index.ts`)
- **Configuration Schema & Environment Variables** (Lines 8-50):
  - `NODE_ENV`, `LOG_LEVEL` (default: `'info'`)
  - Postgres: `DATABASE_URL`, `POSTGRES_HOST`, `POSTGRES_PORT` (5432), `POSTGRES_USER` ('assurecode'), `POSTGRES_PASSWORD`, `POSTGRES_DB` ('assurecode')
  - Redis: `REDIS_URL` ('redis://localhost:6379')
  - Neo4j: `NEO4J_URI` ('bolt://localhost:7687'), `NEO4J_USER`, `NEO4J_PASSWORD`
  - Ports: `GATEWAY_PORT` (4000), `WEBHOOK_INGEST_PORT` (9000/3002), `AI_SERVICE_PORT` (8000), `SCOPE_GUARD_PORT` (8001), `CI_WORKER_PORT` (5001), `SETTLEMENT_WORKER_PORT` (5002)
  - Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
  - S3 / LocalStack: `S3_ENDPOINT` ('http://localhost:4566'), `S3_BUCKET_NAME` ('assurecode-artifacts'), `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- **Exported Helper Functions**: `loadConfig()`, `getDatabaseUrl()`, `createLogger()`.

#### 3. `@assurecode/event-bus` (`packages/event-bus/src/index.ts` & `outbox-relay.ts`)
- **Implementations**:
  - `InMemoryBus`: Subscriptions stored in `Map<string, Set<EventHandler>>`.
  - `RedisStreamsBus`: Uses Redis Streams consumer groups (`XGROUP CREATE ... MKSTREAM`), `XADD`, `XREADGROUP`, exponential backoff retry (3 attempts), forwarding to DLQ (`${topic}.dlq`).
  - `KafkaBus`: Uses KafkaJS producer & consumer (`groupId: assurecode-${topic}`).
- **Transactional Outbox Daemon** (`OutboxRelay` in `packages/event-bus/src/outbox-relay.ts` Lines 54-102):
  - Queries `outbox` table using `SELECT outbox_id, topic, payload, correlation_id FROM outbox WHERE sent_at IS NULL ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED`.
  - Publishes each event to `eventBus` and updates `sent_at = NOW()`.

#### 4. `@assurecode/ledger-client` (`packages/ledger-client/src/index.ts`)
- **Methods**:
  - `append(contractId, actionType, payload, client?)`: Invokes Postgres stored procedure `SELECT append_ledger($1, $2, $3::jsonb) AS row` (Line 61).
  - `appendWithOutbox(contractId, actionType, ledgerPayload, eventTopic, eventPayload, correlationId)`: Invokes Postgres procedure `SELECT append_ledger_and_outbox(...)` with fallback transaction `append_ledger` + `INSERT INTO outbox` (Lines 132-163).
  - `getChain(contractId)`: `SELECT * FROM merkle_ledger WHERE contract_id = $1 ORDER BY ledger_id ASC` (Lines 172-177).
  - `verifyChain(contractId)`: SQL digest check `encode(digest((to_jsonb(payload) || to_jsonb(previous_hash))::text, 'sha256'), 'hex')` with JS fallback `calculateSha256(payload, previousHash)` (Lines 180-215).

#### 5. `@assurecode/stripe-adapter` (`packages/stripe-adapter/src/index.ts`)
- **Interface**: `EscrowPort` (Lines 39-62) with methods: `createPaymentIntent()`, `capturePaymentIntent()`, `cancelPaymentIntent()`, `verifyWebhook()`, `transferToFreelancer()`.
- **Adapters**: `FakeEscrowAdapter` (Lines 84-131) and `StripeEscrowAdapter` (Lines 135-235) using `capture_method: 'manual'` for escrow holding.

#### 6. `@assurecode/telemetry` (`packages/telemetry/src/`)
- OpenTelemetry tracing, AsyncLocalStorage correlation ID propagated via `x-correlation-id` and event payload `_traceContext`, and Prometheus metrics exports.

---

### Microservice Detailed Findings

---

### 1. `api-gateway` (`apps/api-gateway/`)

- **Primary Purpose & Business Role**:
  BFF (Backend-for-Frontend) REST & WebSocket API Gateway. Serves as the central API entry point for web clients and external webhooks, managing contract lifecycle initialization, test generation triggers, Merkle ledger locking, Stripe escrow creation/webhooks, settlement requests, audit result queries, XAI trust score evaluation, chat scope-checking, and real-time WebSocket event streaming.

- **Entry Point, Framework, Server Setup**:
  - Entry point: `src/server.ts` (starts server listening on `GATEWAY_PORT` or `4000` via `start()`).
  - Framework: Fastify (`fastify` ^5.2.0), `@fastify/cors`, `@fastify/websocket`.
  - Middleware: `withIdempotency` (`src/middleware/idempotency.ts`) enforcing dual-layer in-memory promise caching + PostgreSQL `idempotency_keys` table reservation. `onRequest` hook injecting/propagating `x-correlation-id`.

- **Routes & Endpoints**:
  - `GET /healthz` — Liveness probe returning `{ status: 'ok', timestamp: ..., version: ... }`. (Lines 116-122)
  - `GET /readyz` — Readiness probe checking Postgres DB connection `SELECT 1`. (Lines 125-141)
  - `GET /metrics` — Prometheus metrics export (`metrics.getMetrics()`). (Lines 144-147)
  - `POST /api/contracts/initialize` — Validates `InitializeContractSchema`, generates `contractId` (`AC-...`), publishes `contract.initialized` to EventBus. (Lines 151-185)
  - `POST /api/contracts/:contractId/generate-tests` — Calls `ai-service` `/generate-tests`. Handles HTTP 503 (LLM busy) by inserting queued job into Postgres `jobs` table and returning HTTP 202 `{ jobId, status: 'queued', pollUrl: '/api/jobs/:jobId' }`. On HTTP 200, appends `TESTS_GENERATED` to ledger via `appendWithOutbox` and publishes `tests.generated`. (Lines 203-327)
  - `POST /api/contracts/:contractId/lock` — Appends `CONTRACT_LOCKED` to Merkle ledger via `appendWithOutbox`, publishes `contract.locked`, and triggers fire-and-forget call to `ai-service` `/rag/ingest`. (Lines 329-388)
  - `POST /api/contracts/:contractId/escrow` — Creates manual capture Stripe PaymentIntent via `escrowAdapter.createPaymentIntent`, appends `ESCROW_CREATED` entry to Merkle ledger, and audits transaction into `payment_events` DB table. (Lines 390-444)
  - `POST /api/contracts/:contractId/settle` — Idempotently checks if contract is already settled in ledger (`INVOICE` entry); if not, publishes `settlement.requested`. (Lines 446-484)
  - `POST /webhooks/stripe` — Verifies Stripe webhook HMAC signature via `escrowAdapter.verifyWebhook`; on `payment_intent.succeeded` appends `ESCROW_EVENT` to ledger and publishes `contract.locked`. (Lines 489-531)
  - `GET /api/contracts/:contractId` — Retrieves full array of ledger rows for contract from Postgres `merkle_ledger`. (Lines 533-560)
  - `GET /api/contracts/:contractId/verify` — Executes cryptographic SHA-256 chain verification via `ledgerClient.verifyChain(contractId)`. Returns HTTP 200 `{ contractId, valid: true }` or HTTP 409 `{ contractId, valid: false }` on tampered hash detected. (Lines 562-579)
  - `GET /api/jobs/:jobId` — Polls background test-gen job state from `jobs` DB table. (Lines 583-623)
  - `POST /api/contracts/:contractId/simulate-push` — Simulates GitHub push event by publishing `code.push.received` to EventBus. (Lines 627-652)
  - `GET /api/audits/:contractId/results` — Queries latest `AUDIT_COMPLETED` or `CI_PASSED` entry in contract's Merkle ledger chain. (Lines 654-709)
  - `GET /api/contracts/:contractId/score` — Calls `ai-service` `/xai/score` with telemetry data, appends/publishes `xai.scored`. (Lines 713-786)
  - `POST /api/contracts/:contractId/chat` — Intercepts chat messages via Scope Guard service `/scope/check`. If blocked (`allowed: false`), publishes `scope.checked` and returns HTTP 403. If allowed, publishes `scope.checked` and returns HTTP 200. (Lines 792-865)
  - `GET /api/contracts/:contractId/chat/stream` — WebSocket endpoint subscribing to `scope.checked` EventBus topic and streaming real-time JSON events to connected clients. (Lines 867-878)

- **Event Topics Published & Consumed**:
  - Published: `contract.initialized`, `tests.generated` (via OutboxRelay), `contract.locked` (via OutboxRelay & Stripe webhook), `settlement.requested`, `code.push.received`, `xai.scored`, `scope.checked`.
  - Consumed: `scope.checked` (subscribed over WebSocket stream for push to web client).

- **Dependencies on Other Apps / Shared Packages**:
  - Apps: `ai-service` (`http://localhost:8000`), `scope-guard` (`http://localhost:8001`).
  - Packages: `@assurecode/config`, `@assurecode/event-bus`, `@assurecode/ledger-client`, `@assurecode/shared`, `@assurecode/stripe-adapter`, `@assurecode/telemetry`.

- **Database / Storage / Ledger Access**:
  - PostgreSQL (`pg.Pool`):
    - `idempotency_keys`: `INSERT INTO idempotency_keys (key, contract_id, response_json, status_code, expires_at) VALUES ($1, $2, '{}'::jsonb, 0, NOW() + INTERVAL '24 hours') ON CONFLICT (key) DO NOTHING`
    - `jobs`: `INSERT INTO jobs (contract_id, job_type, status, retry_after) ...` and `SELECT ... FROM jobs WHERE job_id = $1`
    - `payment_events`: `INSERT INTO payment_events (contract_id, event_type, amount_cents, payload, correlation_id, created_at) ...`
    - `outbox`: Pumped via `OutboxRelay` background daemon using `SELECT ... FOR UPDATE SKIP LOCKED`.
  - Merkle Ledger (`LedgerClient`): Operates on Postgres `merkle_ledger` table via stored procedures `append_ledger` and `append_ledger_and_outbox`.

---

### 2. `ci-worker` (`apps/ci-worker/`)

- **Primary Purpose & Business Role**:
  Asynchronous, event-driven CI execution worker. Consumes `code.push.received` events from the EventBus and executes a multi-stage zero-trust CI pipeline: Docker sandbox execution, AST static analysis (cyclomatic complexity & maintainability index), hidden test suite execution, OWASP security scanning (secrets, eval, SQL injection, command injection), visual proof recording (Playwright video + SHA-256 hash), and telemetry aggregation (`audit.completed`).

- **Entry Point, Framework, Server Setup**:
  - Entry point: `src/worker.ts` (executed via `node dist/worker.js` or `main()`).
  - Framework: Event consumer process subscribing via `eventBus.subscribe(EVENT_TOPICS.CODE_PUSH_RECEIVED)`.
  - Modules: `src/ast-analyzer.ts`, `src/sandbox-runner.ts`, `src/security-auditor.ts`, `src/video-recorder.ts`.

- **Routes / Endpoints**: None (non-HTTP standalone worker process).

- **Event Topics Published & Consumed**:
  - Consumed: `code.push.received` (triggers `processCodePush()`).
  - Published:
    - `ci.sandbox.ready` (Step 1: Docker / process sandbox initialization)
    - `ci.ast.completed` (Step 2: AST complexity & maintainability metrics)
    - `ci.tests.completed` (Step 3: Test pass/fail counts)
    - `security.scan.completed` (Step 4: OWASP vulnerabilities & security score)
    - `video.verified` (Step 5: Visual proof video recording S3 URL & SHA-256 hash)
    - `audit.completed` (Step 6: Aggregated CI telemetry results)

- **Detailed Code Mechanisms**:
  - `ast-analyzer.ts`: `analyzeAST()` (Lines 12-47) calculates decision points (`if`, `for`, `while`, `catch`, `case`, `&&`, `||`, `?`) to compute cyclomatic complexity and scaled maintainability index (`100 - avgComplexity * 10 - lineCount * 0.5`).
  - `sandbox-runner.ts`: `runInSandbox()` (Lines 22-52) executes `docker run --rm ${networkFlag} --memory=512m --cpus=1 alpine:latest` with isolated process fallback when Docker daemon is offline.
  - `security-auditor.ts`: `performSecurityScan()` (Lines 16-75) scans code for `HARDCODED_SECRET`, `DYNAMIC_CODE_EXECUTION` (`eval`/`Function`), `SQL_INJECTION`, and `COMMAND_INJECTION` (`child_process.exec`).
  - `video-recorder.ts`: `captureVisualProof()` (Lines 12-28) generates S3 key `proofs/${contractId}_proof_${timestamp}.mp4`, S3 URL `http://localhost:4566/assurecode-test-bundles/...`, duration 12.5s, and SHA-256 `videoHash`.

- **Dependencies on Other Apps / Shared Packages**:
  - Packages: `@assurecode/config`, `@assurecode/event-bus`, `@assurecode/shared`, `@assurecode/telemetry`.

- **Database / Storage / Ledger Access**:
  - No direct DB connection. Relies on EventBus messages. Output video artifacts stored/referenced via LocalStack S3 (`http://localhost:4566/...`).

---

### 3. `settlement-worker` (`apps/settlement-worker/`)

- **Primary Purpose & Business Role**:
  Autonomous settlement and escrow release engine based on a 5-Signal Oracle. Consumes incoming validation events, maintains an in-memory oracle state matrix per contract, evaluates settlement conditions upon request, and executes single-fire escrow payouts to freelancers while guaranteeing double-payout prevention via PostgreSQL atomic locks.

- **Entry Point, Framework, Server Setup**:
  - Entry point: `src/worker.ts` (executed via `start()`).
  - Framework: Event consumer process subscribing to `EVENT_TOPICS` via `createEventBus()`.

- **5-Signal Oracle Rules** (`src/worker.ts` Lines 22-106):
  1. `astPassed`: `Number(payload.auditResults.maintainability) >= 10`
  2. `testsPassed`: `passedTests === totalTests && totalTests > 0`
  3. `securityPassed`: `vulnerabilities === 0`
  4. `scopePassed`: `allowed === true` (from `scope.checked`)
  5. `videoPassed`: `true` (from `video.verified`)
  - Approval condition: `astPassed && testsPassed && securityPassed && scopePassed && videoPassed` (strict boolean AND).

- **Double-Payout Prevention Lock Mechanism** (`src/worker.ts` Lines 122-140):
  ```ts
  const guardRes = await dbPool.query(
    `INSERT INTO settlements (contract_id, status)
     VALUES ($1, 'PROCESSING')
     ON CONFLICT (contract_id) DO NOTHING
     RETURNING contract_id`,
    [contractId]
  );
  if (!guardRes || guardRes.rowCount !== 1) {
    // Rejected: Settlement lock already acquired or in progress
    return;
  }
  ```

- **Routes / Endpoints**: None (non-HTTP standalone worker process).

- **Event Topics Published & Consumed**:
  - Consumed: `audit.completed`, `scope.checked`, `video.verified`, `settlement.requested`.
  - Published: `settlement.rejected` (if Oracle validation fails or transfer errors out), `settlement.completed` (upon successful payout).

- **Dependencies on Other Apps / Shared Packages**:
  - Packages: `@assurecode/config`, `@assurecode/event-bus`, `@assurecode/ledger-client`, `@assurecode/shared`, `@assurecode/stripe-adapter`, `@assurecode/telemetry`.

- **Database / Storage / Ledger Access**:
  - PostgreSQL (`dbPool`): `settlements` table (`INSERT ... ON CONFLICT DO NOTHING` and `UPDATE settlements SET status = 'COMPLETED', transfer_id = $1, updated_at = NOW() WHERE contract_id = $2`).
  - Merkle Ledger (`LedgerClient`): Appends `INVOICE` entry (`amountCents`, `freelancerId`, `transferId`, `oracleState`, `settledAt`) within an explicit atomic database transaction (`BEGIN` / `COMMIT`).

---

### 4. `webhook-ingest` (`apps/webhook-ingest/`)

- **Primary Purpose & Business Role**:
  Edge ingestion service for external GitHub webhooks. Provides constant-time HMAC SHA-256 signature verification, parses repository and commit metadata, and publishes normalized `code.push.received` events to the EventBus.

- **Entry Point, Framework, Server Setup**:
  - Entry point: `src/server.ts` (listens on `process.env.PORT` or `3002`).
  - Framework: Fastify (`fastify` ^5.2.0) with custom buffer content-type parser for raw body HMAC validation.

- **HMAC Signature Verification** (`src/server.ts` Lines 33-47):
  ```ts
  export function verifyGitHubSignature(payload: string | Buffer, signatureHeader: string, secret: string): boolean {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
    const signature = signatureHeader.slice(7);
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const expectedSignature = hmac.digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'));
    } catch {
      return false;
    }
  }
  ```

- **Routes & Endpoints**:
  - `GET /healthz` — Liveness check (`{ status: 'ok', service: 'webhook-ingest' }`). (Line 60)
  - `GET /readyz` — Readiness check (`{ status: 'ready', service: 'webhook-ingest', timestamp: ... }`). (Line 62)
  - `GET /metrics` — Prometheus metrics export (`metrics.getMetrics()`). (Lines 64-67)
  - `POST /webhooks/github` — GitHub push webhook receiver. Validates `x-hub-signature-256` header against `GITHUB_WEBHOOK_SECRET` (`assurecode_github_secret`). Returns HTTP 401 on invalid signature; on valid signature, extracts `contractId`, `commitHash`, `repoUrl`, `ref`, `pusher`, publishes `code.push.received` to EventBus, and returns HTTP 202 Accepted `{ status: 'accepted', eventId, correlationId, topic }`. (Lines 69-100)

- **Event Topics Published & Consumed**:
  - Published: `code.push.received`.
  - Consumed: None.

- **Dependencies on Other Apps / Shared Packages**:
  - Packages: `@assurecode/config`, `@assurecode/event-bus`, `@assurecode/shared`, `@assurecode/telemetry`.

- **Database / Storage / Ledger Access**: None (stateless API endpoint).

---

### 5. `ai-service` (`apps/ai-service/`)

- **Primary Purpose & Business Role**:
  Python FastAPI microservice for AI intelligence capabilities: vector text embeddings, NLP matchmaker for freelancer ranking, contract text chunking and RAG ingestion into pgvector, LLM automated Jest/Cypress test bundle generation with S3 storage, and Explainable AI (XAI) trust score calculation with Neo4j graph update.

- **Entry Point, Framework, Server Setup**:
  - Entry point: `app/main.py` (FastAPI app running on port 8000 via Uvicorn).
  - Architecture: Hexagonal architecture with ports in `app/ports/` (`embedder.py`, `graph_repo.py`, `llm_client.py`, `rag_store.py`, `artifact_store.py`), adapters, and dependency injection in `app/deps.py`. Configured via 12-factor settings in `app/settings.py`.

- **Routes & Endpoints**:
  - `GET /healthz` — Liveness probe (`{ status: 'ok', service: 'ai-service', time: ... }`). (`app/main.py` Lines 35-38)
  - `GET /` — Service overview and endpoint index. (`app/main.py` Lines 41-47)
  - `POST /embed` — Single text embedding using `SentenceTransformerEmbedder` (`all-MiniLM-L6-v2`) or `FakeEmbedder` fallback. Returns `{ vector: list[float], dim: int }`. (`app/routes/embed.py` Lines 35-38)
  - `POST /embed/batch` — Batch text embedding. Returns `{ vectors: list[list[float]], dim: int }`. (`app/routes/embed.py` Lines 41-46)
  - `POST /match` — Ranks freelancers against requirements string using cosine similarity, Neo4j skill graph data, trust score, and delivery history. Returns top-k matched freelancers with itemized score explanations (`skill_score`, `trust_score`, `history_score`, `matched_skills`). (`app/routes/match.py` Lines 58-61)
  - `POST /rag/ingest` — Chunks contract requirements text via paragraph/sentence packing (`chunk_text()`), embeds chunks in batch, and persists into `PostgresRagStore` (`pgvector`) or `InMemoryRagStore`. (`app/routes/rag.py` Lines 34-58)
  - `GET /rag/count/{contract_id}` — Returns count of stored chunk embeddings for contract. (`app/routes/rag.py` Lines 66-68)
  - `POST /generate-tests` — Generates Jest/Cypress test code using Gemini (`GeminiClient`) or OpenAI (`OpenAIClient`), uploads test bundle to S3 (`S3ArtifactStore`), and returns `{ contract_id, s3_key, s3_url, framework, test_count, generated_at }`. Raises HTTP 503 with `Retry-After` header when LLM is unavailable. (`app/routes/test_gen.py` Lines 52-88)
  - `POST /xai/score` — Calculates weighted XAI Trust Score (40% CI test pass, 25% maintainability, 20% security, 15% sentiment), updates Neo4j freelancer node (`update_trust_score`), and returns score with human-readable justifications. (`app/routes/xai.py` Lines 39-71)

- **Event Topics Published & Consumed**:
  - Communicates synchronously via HTTP endpoints invoked by `api-gateway`.

- **Dependencies on Other Apps / Shared Packages**:
  - Isolated Python stack (`pyproject.toml`). Integrates with shared infrastructure: PostgreSQL (`pgvector`), Neo4j (`bolt://localhost:7687`), LocalStack S3 (`http://localhost:4566`).

- **Database / Storage / Ledger Access**:
  - PostgreSQL (`PostgresRagStore` in `app/ports/rag_store.py`): Stores document chunk embeddings using `pgvector`.
  - Neo4j Graph DB (`Neo4jGraphRepo` in `app/ports/graph_repo.py`): Queries freelancer profiles, skills, delivery counts, and updates trust scores (`SET f.trust_score = $trust_score`).
  - S3 / LocalStack (`S3ArtifactStore` in `app/ports/artifact_store.py`): Stores generated test bundles under `contracts/<contractId>/generated-tests/<framework>/tests.js` with local disk fallback (`./storage_fallback`).

---

## 2. Logic Chain

1. **System Overview & Boundaries**:
   - The AssureCode platform is a multi-tier microservices architecture consisting of 5 backend microservices (`api-gateway`, `ci-worker`, `settlement-worker`, `webhook-ingest`, `ai-service`), a React frontend SPA (`web`), and a Scope Guard service (`scope-guard`).
   - Shared domain logic, wire format types, configurations, event bus messaging adapters, Merkle ledger database clients, and Stripe escrow interfaces are centralized under `packages/`.

2. **Contract Lifecycle & Event Flow Reasoning**:
   - **Initialization**: Client calls `api-gateway` `POST /api/contracts/initialize` -> Gateway validates schema and publishes `contract.initialized`.
   - **Test Generation**: Client calls `POST /api/contracts/:contractId/generate-tests` -> Gateway calls `ai-service` `POST /generate-tests` -> `ai-service` invokes LLM, uploads generated tests to S3, and returns S3 URL -> Gateway appends `TESTS_GENERATED` to Merkle ledger and publishes `tests.generated`. (If LLM returns 503, Gateway queues job in Postgres `jobs` table and returns HTTP 202).
   - **Locking & RAG Ingestion**: Client calls `POST /api/contracts/:contractId/lock` -> Gateway appends `CONTRACT_LOCKED` to Merkle ledger with SHA-256 hash, publishes `contract.locked`, and triggers `ai-service` `POST /rag/ingest` to chunk and store requirement vectors in `pgvector`.
   - **Escrow Funding**: Client calls `POST /api/contracts/:contractId/escrow` -> Gateway creates manual-capture Stripe PaymentIntent, appends `ESCROW_CREATED` to ledger, and logs event in `payment_events` table. External Stripe webhooks POST to `/webhooks/stripe` (verified via HMAC).
   - **Code Push & CI Verification Pipeline**: Developer pushes code or client simulates push -> `webhook-ingest` verifies GitHub HMAC SHA-256 and publishes `code.push.received` -> `ci-worker` consumes event, provisions sandbox, calculates AST complexity & maintainability, executes test suite, runs OWASP security scan, records visual proof video (S3 + SHA-256 hash), and publishes `audit.completed`.
   - **Scope Guard & Chat Stream**: Client sends message -> Gateway calls `scope-guard` -> If off-scope, request is blocked (HTTP 403) and `scope.checked` (`allowed: false`) event is published; if allowed, message is delivered and streamed over WebSocket at `GET /api/contracts/:contractId/chat/stream`.
   - **Autonomous 5-Signal Settlement**: Client calls `POST /api/contracts/:contractId/settle` -> Gateway checks ledger for existing `INVOICE` entry and publishes `settlement.requested` -> `settlement-worker` evaluates the 5 oracle signals (AST >= 10, tests pass 100%, security vulnerabilities == 0, scope allowed == true, video verified == true) -> If all 5 signals pass, acquires atomic settlement lock via Postgres `settlements` table (`ON CONFLICT DO NOTHING`), executes Stripe transfer to freelancer, appends `INVOICE` to Merkle ledger, updates settlement status to `COMPLETED`, and publishes `settlement.completed`.

3. **Data Integrity & Concurrency Guarantees**:
   - Merkle Ledger integrity is maintained by `packages/ledger-client` using SHA-256 hashes (`current_hash = sha256(payload + previous_hash)`) enforced by PostgreSQL stored procedures `append_ledger` and `append_ledger_and_outbox`.
   - Idempotency is enforced by `api-gateway/src/middleware/idempotency.ts` using dual-layer atomic in-memory promise resolution + PostgreSQL `idempotency_keys` table.
   - Double-payout prevention is enforced by `settlement-worker/src/worker.ts` using PostgreSQL unique index conflicts (`INSERT INTO settlements ON CONFLICT (contract_id) DO NOTHING`).

---

## 3. Caveats

- **Network Restrictions**: In `CODE_ONLY` network mode, external live Stripe APIs, external LLM endpoints (Gemini/OpenAI), and live Docker daemons default to their fallback implementations (`FakeEscrowAdapter`, `FakeLlmClient`, `FakeEmbedder`, isolated process sandbox runner).
- **Environment Services**: Local dev relies on PostgreSQL, Redis, Neo4j, and LocalStack S3 running via Docker/local infrastructure. When offline, all services utilize in-memory or fallback adapters gracefully.

---

## 4. Conclusion

All 5 microservices under `apps/` (`api-gateway`, `ci-worker`, `settlement-worker`, `webhook-ingest`, `ai-service`) and all 6 shared packages under `packages/` have been exhaustively analyzed. The architecture adheres strictly to hexagonal domain boundaries, event-driven decoupled messaging, zero-trust cryptographic audit trails via Merkle ledgers, atomic idempotency, and 5-signal oracle settlement protection.

---

## 5. Verification Method

To independently verify the findings and code structure across all 5 microservices, execute the following commands and check the specified files:

### A. Run Automated Unit & Integration Tests

1. **API Gateway Tests**:
   ```powershell
   cd C:\Users\hp\AssureCode\apps\api-gateway
   npx vitest run
   ```
   *Verifies HTTP endpoints, idempotency replay, idempotency concurrency, and Merkle ledger tamper detection.*

2. **CI Worker Tests**:
   ```powershell
   cd C:\Users\hp\AssureCode\apps\ci-worker
   npx vitest run
   ```
   *Verifies AST cyclomatic complexity calculation, OWASP security scanning, sandbox runner provisioning, and `processCodePush` pipeline.*

3. **Settlement Worker Tests**:
   ```powershell
   cd C:\Users\hp\AssureCode\apps\settlement-worker
   npx vitest run
   ```
   *Verifies 5-signal oracle logic, single-fire settlement guard, and double-payout prevention.*

4. **Webhook Ingest Tests**:
   ```powershell
   cd C:\Users\hp\AssureCode\apps\webhook-ingest
   npx vitest run
   ```
   *Verifies GitHub HMAC SHA-256 signature verification and HTTP 202 event acceptance.*

5. **AI Service Tests**:
   ```powershell
   cd C:\Users\hp\AssureCode\apps\ai-service
   pytest
   ```
   *Verifies FastAPI routes, fake embedder, text chunker, NLP matchmaker, and XAI score calculation.*

### B. Direct File Inspection Checklist

| Microservice | Primary File Path | Key Logic / Export to Inspect |
|---|---|---|
| `api-gateway` | `apps/api-gateway/src/server.ts` | Route handlers, `withIdempotency`, `appendWithOutbox`, `/api/contracts/:contractId/verify` |
| `ci-worker` | `apps/ci-worker/src/worker.ts` | `processCodePush()`, `analyzeAST()`, `performSecurityScan()`, `captureVisualProof()` |
| `settlement-worker` | `apps/settlement-worker/src/worker.ts` | 5-Signal Oracle `getState()`, `INSERT INTO settlements ON CONFLICT DO NOTHING`, `append(..., 'INVOICE')` |
| `webhook-ingest` | `apps/webhook-ingest/src/server.ts` | `verifyGitHubSignature()`, `POST /webhooks/github`, `eventBus.publish(CODE_PUSH_RECEIVED)` |
| `ai-service` | `apps/ai-service/app/main.py` & `routes/` | FastAPI setup, `/embed`, `/match`, `/rag/ingest`, `/generate-tests`, `/xai/score` |
| Shared Bus | `packages/event-bus/src/index.ts` | `InMemoryBus`, `RedisStreamsBus`, `KafkaBus`, `OutboxRelay` |
| Shared Ledger | `packages/ledger-client/src/index.ts` | `append_ledger`, `appendWithOutbox`, `verifyChain` |

