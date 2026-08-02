# Handoff Report — Shared Packages & Microservice Integration Analysis

## 1. Observation

All 6 shared packages under `C:\Users\hp\AssureCode\packages\` and their consumption in `C:\Users\hp\AssureCode\apps\` were directly inspected and verified.

### Summary of Shared Packages

| Package Directory | Package Name | Primary Role & Core Exports | Key Dependencies |
|-------------------|--------------|-----------------------------|------------------|
| `packages/config` | `@assurecode/config` | Environment validation (`AppConfigSchema`, `loadConfig`), database URL generation (`getDatabaseUrl`), Pino structured logging (`createLogger` with correlation ID). Re-exports telemetry. | `zod`, `pino`, `@assurecode/telemetry` |
| `packages/event-bus` | `@assurecode/event-bus` | Pub/Sub abstraction (`EventBus` interface), implementations (`InMemoryBus`, `RedisStreamsBus`, `KafkaBus`), `OutboxRelay` transactional daemon, retry/DLQ handling (`*.dlq`), OpenTelemetry propagation (`_traceContext`). | `ioredis`, `kafkajs`, `@opentelemetry/api`, `@assurecode/config`, `@assurecode/shared`, `@assurecode/telemetry` |
| `packages/ledger-client` | `@assurecode/ledger-client` | Client for immutable Merkle ledger stored procedure (`append_ledger`, `append_ledger_and_outbox`). SHA-256 chain recalculation & integrity verification (`verifyChain`). | `pg`, `@assurecode/shared`, `@assurecode/telemetry` |
| `packages/stripe-adapter` | `@assurecode/stripe-adapter` | Escrow payment port (`EscrowPort`), factory (`createEscrowAdapter`), real Stripe SDK implementation (`StripeEscrowAdapter`), deterministic mock implementation (`FakeEscrowAdapter`). | `stripe`, `@assurecode/telemetry` |
| `packages/shared` | `@assurecode/shared` | Single source of truth for 17 `EVENT_TOPICS`, domain DTOs, and Zod schemas (`EventEnvelopeSchema`, `ContractSchema`, `LedgerEntrySchema`, `SettlementRequestedSchema`, etc.). | `zod` |
| `packages/telemetry` | `@assurecode/telemetry` | OpenTelemetry SDK setup (`initTelemetry`, `initTracing`), Prometheus metrics registry (`metricsRegistry`, `metrics`), `AsyncLocalStorage` correlation store (`getCorrelationId`, `runWithCorrelationId`). | `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-grpc`, `prom-client` |

---

### Detailed Package Inspection

#### 1. `packages/event-bus`
- **File**: `C:\Users\hp\AssureCode\packages\event-bus\src\index.ts`
- **Transport Mechanisms**:
  - **Redis Streams** (`RedisStreamsBus`): Uses `XADD` for publishing and `XREADGROUP` (`GROUP assurecode`) with `BLOCK 2000` for consumer groups. Auto-creates stream groups via `XGROUP CREATE ... MKSTREAM`.
  - **Kafka** (`KafkaBus`): Uses `kafkajs` Producer/Consumer with `groupId: assurecode-${topic}` and partition key set to `correlationId`.
  - **InMemory** (`InMemoryBus`): Set-based event handler map for unit testing and local development.
- **Event Envelope & Trace Propagation**:
  - `buildEnvelope(topic, payload, correlationId)` constructs:
    ```typescript
    export interface EventEnvelope {
      id: string; // randomUUID()
      topic: string;
      timestamp: string; // ISO 8601
      correlationId: string;
      payload: Record<string, unknown>; // includes _traceContext injected via W3C propagation
    }
    ```
- **Retry Logic & Dead Letter Queue (DLQ)**:
  - Inside `RedisStreamsBus.poll()`:
    - Retries failing event handlers up to `maxRetries = 3` with exponential backoff (`initialBackoffMs = 100ms`, doubling per attempt: 100ms, 200ms).
    - If all 3 attempts fail, forwards envelope to Dead Letter Queue stream `${topic}.dlq` with error details (`error`, `errorStack`, `failedAt`, `attempts`, `originalStream`, `originalId`).
    - Increments Prometheus metric `metrics.dlqDepth.inc({ stream: dlqTopic })`.
    - ACKs the message on the main stream (`XACK`) to prevent stream blocking.
- **Transactional Outbox Daemon**:
  - **File**: `C:\Users\hp\AssureCode\packages\event-bus\src\outbox-relay.ts`
  - `OutboxRelay` class polls PostgreSQL table `outbox` using `SELECT outbox_id, topic, payload, correlation_id FROM outbox WHERE sent_at IS NULL ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED`.
  - Publishes each item to the `EventBus` and updates `sent_at = NOW()` inside a single SQL transaction.

---

#### 2. `packages/ledger-client`
- **File**: `C:\Users\hp\AssureCode\packages\ledger-client\src\index.ts`
- **Immutability Guarantees & State Storage**:
  - State stored in PostgreSQL table `merkle_ledger` (`ledger_id`, `contract_id`, `action_type`, `payload`, `previous_hash`, `current_hash`, `created_at`).
  - Immutability enforced by PostgreSQL append-only stored procedure `append_ledger(contract_id, action_type, payload)` which fetches the previous hash (`GENESIS` if first entry) and computes:
    $$\text{current\_hash} = \text{SHA256}(\text{JSON.stringify(payload)} + \text{previous\_hash})$$
- **Cryptographic Hashing & Verification**:
  - `calculateSha256(payload, previousHash)` helper in JS/TS mirroring PostgreSQL procedure:
    ```typescript
    function calculateSha256(payload: Record<string, unknown>, previousHash: string): string {
      const serialized = JSON.stringify(payload) + previousHash;
      return createHash('sha256').update(serialized, 'utf8').digest('hex');
    }
    ```
  - `verifyChain(contractId: string): Promise<boolean>`:
    - Queries `merkle_ledger` ordered by `sequence_number ASC`.
    - Iterates over rows, validating that `row.previous_hash === prev_hash` and `row.current_hash === computed_hash`.
    - If any link in the chain is modified, deleted, or out of sequence, verification fails (`returns false`).
- **Core Method Signatures**:
  - `append(contractId, actionType, payload, client?): Promise<LedgerRow>`
  - `appendWith(contractId, actionType, payload, fn): Promise<T>`
  - `appendWithOutbox(contractId, actionType, ledgerPayload, eventTopic, eventPayload, correlationId?): Promise<LedgerRow>`
    - Uses stored procedure `append_ledger_and_outbox` or atomic JS transaction fallback to insert into both `merkle_ledger` and `outbox`.
  - `getChain(contractId): Promise<LedgerRow[]>`
  - `verifyChain(contractId): Promise<boolean>`

---

#### 3. `packages/stripe-adapter`
- **File**: `C:\Users\hp\AssureCode\packages\stripe-adapter\src\index.ts`
- **Escrow Port Interface (`EscrowPort`)**:
  ```typescript
  export interface EscrowPort {
    createPaymentIntent(params: { amountCents: number; contractId: string; metadata?: Record<string, string> }): Promise<PaymentIntentResult>;
    capturePaymentIntent(paymentIntentId: string): Promise<PaymentIntentResult>;
    cancelPaymentIntent(paymentIntentId: string): Promise<{ canceled: boolean; paymentIntentId: string }>;
    verifyWebhook(payload: string | Buffer, signature: string): Promise<WebhookVerificationResult>;
    transferToFreelancer(params: { amountCents: number; destinationAccountId: string; contractId: string }): Promise<{ transferId: string; amountCents: number }>;
  }
  ```
- **Escrow Lifecycle & PaymentIntent Management**:
  - `createPaymentIntent`: Uses Stripe API `stripe.paymentIntents.create` with `capture_method: 'manual'` (holding funds in escrow without immediate capture).
  - `capturePaymentIntent`: Calls `stripe.paymentIntents.capture(paymentIntentId)` upon contract completion / settlement approval.
  - `cancelPaymentIntent`: Calls `stripe.paymentIntents.cancel(paymentIntentId)` upon contract rejection / cancellation.
  - `transferToFreelancer`: Calls `stripe.transfers.create` targeting destination Stripe Connect account (`destinationAccountId`).
- **Factory & Fake Adapter**:
  - `createEscrowAdapter(config: EscrowConfig)` checks if `secretKey` is absent, invalid, or `isTest === true`. Returns `FakeEscrowAdapter` for testing/offline environments, avoiding external API calls.

---

#### 4. `packages/shared`
- **File**: `C:\Users\hp\AssureCode\packages\shared\src\index.ts`
- **Pub/Sub Topics (`EVENT_TOPICS`)**:
  - `CONTRACT_INITIALIZED`: `'contract.initialized'`
  - `CONTRACT_LOCKED`: `'contract.locked'`
  - `CODE_PUSH_RECEIVED`: `'code.push.received'`
  - `CI_SANDBOX_READY`: `'ci.sandbox.ready'`
  - `CI_AST_COMPLETED`: `'ci.ast.completed'`
  - `CI_TESTS_COMPLETED`: `'ci.tests.completed'`
  - `SECURITY_SCAN_COMPLETED`: `'security.scan.completed'`
  - `AUDIT_COMPLETED`: `'audit.completed'`
  - `TESTS_GENERATED`: `'tests.generated'`
  - `SCOPE_CHECKED`: `'scope.checked'`
  - `VIDEO_VERIFIED`: `'video.verified'`
  - `XAI_SCORED`: `'xai.scored'`
  - `SETTLEMENT_REQUESTED`: `'settlement.requested'`
  - `SETTLEMENT_REJECTED`: `'settlement.rejected'`
  - `SETTLEMENT_COMPLETED`: `'settlement.completed'`
  - `ESCROW_LOCKED`: `'escrow.locked'`
  - `PAYMENT_FAILED`: `'payment.failed'`
- **Zod Schemas**: Provides runtime validations for `InitializeContractSchema`, `ContractSchema`, `ContractLockedSchema`, `TestsGeneratedSchema`, `AuditResultsSchema`, `LedgerEntrySchema`, `PipelineStepSchema`, `ScopeCheckResultSchema`, `SettlementRequestedSchema`, `SettlementCompletedSchema`, `SettlementRejectedSchema`, `IdempotencyKeyHeaderSchema`.

---

#### 5. `packages/config`
- **File**: `C:\Users\hp\AssureCode\packages\config\src\index.ts`
- **Environment Schema (`AppConfigSchema`)**:
  - Validates `NODE_ENV`, `LOG_LEVEL`, `POSTGRES_*`, `REDIS_URL`, `NEO4J_*`, service ports (`GATEWAY_PORT: 4000`, `WEBHOOK_INGEST_PORT: 9000`, `AI_SERVICE_PORT: 8000`, `SCOPE_GUARD_PORT: 8001`, `CI_WORKER_PORT: 5001`, `SETTLEMENT_WORKER_PORT: 5002`), LLM keys, Stripe keys, and S3 credentials.
- **Pino Logger (`createLogger`)**:
  - Automatically mixes `correlationId` into log outputs by querying `@assurecode/telemetry` / `AsyncLocalStorage`.

---

#### 6. `packages/telemetry`
- **Files**: `packages/telemetry/src/index.ts`, `metrics.ts`, `telemetry.ts`, `correlation.ts`
- **Prometheus Metrics Registry**:
  - `assurecode_ledger_appends_total` (Counter): Merkle appends by `action_type` & `contract_id`.
  - `assurecode_event_bus_lag_seconds` (Histogram): Event bus processing lag.
  - `assurecode_settlement_amount_cents_total` (Counter): Total settled cents.
  - `assurecode_dlq_depth` (Gauge): Dead Letter Queue depth by stream topic.
  - `assurecode_ci_sandbox_duration_seconds` (Histogram): CI execution duration.
  - `assurecode_llm_request_duration_seconds` (Histogram): LLM request duration.
- **OpenTelemetry SDK**:
  - Configures `NodeSDK` with `OTLPTraceExporter` (`http://localhost:4317`) auto-instrumenting Fastify, HTTP, Postgres, and Redis.

---

### Microservice Import & Usage Matrix

| Microservice App | Imported Shared Packages | Usage Description |
|------------------|--------------------------|-------------------|
| `apps/api-gateway` | `@assurecode/config`<br>`@assurecode/event-bus`<br>`@assurecode/ledger-client`<br>`@assurecode/shared`<br>`@assurecode/stripe-adapter`<br>`@assurecode/telemetry` | REST/WebSocket Gateway. Validates API requests via `shared` Zod schemas, initiates escrow via `stripe-adapter`, records contract initialization/lock via `ledger-client.appendWithOutbox`, runs `OutboxRelay` background daemon, streams status updates over WebSocket via `event-bus`, and exports metrics on `/metrics`. |
| `apps/ci-worker` | `@assurecode/config`<br>`@assurecode/event-bus`<br>`@assurecode/shared`<br>`@assurecode/telemetry` | CI execution engine. Consumes `code.push.received` from `event-bus`, runs Docker sandbox, AST analysis, security auditor, and test suite, emitting `ci.sandbox.ready`, `ci.ast.completed`, `ci.tests.completed`, and `audit.completed` events. |
| `apps/settlement-worker` | `@assurecode/config`<br>`@assurecode/event-bus`<br>`@assurecode/ledger-client`<br>`@assurecode/shared`<br>`@assurecode/stripe-adapter`<br>`@assurecode/telemetry` | 5-Signal Oracle Settlement Engine. Listens for `settlement.requested` and oracle signal events (`audit.completed`, `scope.checked`, `video.verified`). Verifies Merkle chain via `ledgerClient.verifyChain`, executes payout via `escrowAdapter.transferToFreelancer`, and records settlement state atomically in `merkle_ledger` via `appendWithOutbox`. |
| `apps/webhook-ingest` | `@assurecode/config`<br>`@assurecode/event-bus`<br>`@assurecode/shared`<br>`@assurecode/telemetry` | External Webhook Gateway. Validates GitHub HMAC SHA-256 signatures, binds correlation ID using `runWithCorrelationId`, and publishes `code.push.received` to `event-bus`. |
| `apps/web` | `@assurecode/shared` | Next.js/React frontend dashboard. Uses DTO types and schemas for API requests, WebSocket step state, and contract validation. |
| `apps/ai-service` | *(Python FastAPI Service)* | Uses Python HTTP endpoints (`/generate-tests`, `/audit-code`, `/explain-score`). Integrated with TypeScript ecosystem via HTTP requests from `api-gateway` and `ci-worker`. |
| `apps/scope-guard` | *(Python FastAPI Service)* | Vector embedding scope checker (`/check-scope`). Interacts via HTTP requests originating from gateway and workers. |

---

## 2. Logic Chain

1. **Package Discovery & Directory Structure**:
   - Examination of `C:\Users\hp\AssureCode\packages\` identified 6 distinct packages: `config`, `event-bus`, `ledger-client`, `shared`, `stripe-adapter`, `telemetry`.
   - Each package follows standard TypeScript ESM module structure (`type: module`, exporting `./src/index.ts`).

2. **Domain Contracts & Event System**:
   - `packages/shared` serves as the central type foundation, defining `EVENT_TOPICS` (17 topics) and Zod payload validation schemas.
   - `packages/event-bus` consumes `@assurecode/shared` to enforce standard `EventEnvelope` structures containing `id`, `topic`, `timestamp`, `correlationId`, and W3C trace context.
   - The bus abstraction allows transparent switching between `InMemoryBus` (testing), `RedisStreamsBus` (Redis Streams consumer groups with 3 retries and DLQ forwarding), and `KafkaBus` (KafkaJS partition key correlation).

3. **Ledger & Settlement Security**:
   - `packages/ledger-client` interfaces directly with PostgreSQL stored procedure `append_ledger`. Each entry embeds SHA-256 digest of `JSON.stringify(payload) + previous_hash`.
   - `verifyChain` provides tamper-evident integrity checks by re-running SHA-256 recalculation over every sequential row from genesis.
   - `appendWithOutbox` guarantees transactional consistency: an entry appended to `merkle_ledger` is staged into `outbox` within the same database transaction. `OutboxRelay` in `packages/event-bus` subsequently pumps outbox events to Redis/Kafka.

4. **Stripe Adapter Escrow Seam**:
   - `packages/stripe-adapter` exposes `EscrowPort` defining two-phase payment intents (`createPaymentIntent` with `capture_method: 'manual'`, `capturePaymentIntent`) and payouts (`transferToFreelancer`).
   - `createEscrowAdapter` automatically falls back to `FakeEscrowAdapter` when `STRIPE_SECRET_KEY` is not present, allowing offline development and testing.

5. **Microservice Integration Alignment**:
   - Microservices in `apps/` (`api-gateway`, `ci-worker`, `settlement-worker`, `webhook-ingest`, `web`) import these shared packages using workspace specifiers (`"@assurecode/*": "*"`).
   - This decouples business logic from infrastructure implementations (e.g. swapping Redis for Kafka or real Stripe for Fake Stripe requires zero changes in microservices).

---

## 3. Caveats

1. **Kafka Bus Driver**: `KafkaBus` uses a dynamic `require('kafkajs')` inside try-catch. If `kafkajs` is not installed in the execution environment, `KafkaBus` gracefully returns no-op subscriptions.
2. **Database Stored Procedures**: `LedgerClient` assumes the presence of PostgreSQL functions `append_ledger` and `append_ledger_and_outbox` in the connected database schema. Fallback logic exists in `appendWithOutbox` for raw SQL `BEGIN`/`COMMIT` transactions if stored procedures are unavailable.
3. **Python Services**: `apps/ai-service` and `apps/scope-guard` are written in Python (FastAPI) and do not import npm packages directly; they communicate via HTTP/JSON conforming to `@assurecode/shared` schemas.

---

## 4. Conclusion

The shared package architecture in `AssureCode` provides a robust, decoupled foundation:
- `@assurecode/shared` establishes a unified schema protocol.
- `@assurecode/event-bus` ensures reliable, trace-propagated asynchronous messaging with exponential retries and DLQ protection.
- `@assurecode/ledger-client` provides tamper-evident cryptographic state recording.
- `@assurecode/stripe-adapter` isolates payment processor integration via hexagonal ports and adapters.
- `@assurecode/config` and `@assurecode/telemetry` supply standardized environment management, Pino logging with correlation context, and OpenTelemetry / Prometheus monitoring across all microservices.

---

## 5. Verification Method

To independently verify the shared packages and their tests:

1. **Type Checking & Vitest Unit Tests**:
   - Run type checks across shared packages:
     ```powershell
     npm run typecheck
     ```
   - Run unit tests for `event-bus`, `stripe-adapter`, `ledger-client`, and `shared`:
     ```powershell
     npx vitest run packages/event-bus/test/event-bus.test.ts
     npx vitest run packages/stripe-adapter/test/stripe-adapter.test.ts
     ```

2. **File Inspection Verification**:
   - `packages/config/src/index.ts`
   - `packages/event-bus/src/index.ts`
   - `packages/event-bus/src/outbox-relay.ts`
   - `packages/ledger-client/src/index.ts`
   - `packages/stripe-adapter/src/index.ts`
   - `packages/shared/src/index.ts`
   - `packages/telemetry/src/metrics.ts`
   - `apps/api-gateway/src/server.ts`
   - `apps/settlement-worker/src/worker.ts`
   - `apps/ci-worker/src/worker.ts`
   - `apps/webhook-ingest/src/server.ts`

3. **Invalidation Conditions**:
   - Any modification to `EventEnvelope` structure in `@assurecode/shared` that omits `correlationId` or `_traceContext` invalidates telemetry tracing in `@assurecode/event-bus`.
   - Modifying SHA-256 calculation logic in `packages/ledger-client/src/index.ts` without updating the PostgreSQL `append_ledger` stored procedure breaks `verifyChain()` validation.
