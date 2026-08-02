# Architecture Overview Review & Handoff Report

**Reviewer Identity**: `teamwork_preview_reviewer_sprint7_2`  
**Target File**: `C:\Users\hp\AssureCode\architecture_overview.md`  
**Verdict**: **APPROVE**  

---

## 1. Observation

### 1.1 Document Overview
The architectural document `C:\Users\hp\AssureCode\architecture_overview.md` consists of 721 lines detailing:
- High-Level System Architecture & Topology (ASCII diagram & principles).
- High-Level System Architecture Mermaid Diagram (`graph TB`).
- 5 Microservices Breakdown (`apps/api-gateway`, `apps/ci-worker`, `apps/settlement-worker`, `apps/webhook-ingest`, `apps/ai-service`).
- 5 Shared Package Breakdowns (`packages/event-bus`, `packages/ledger-client`, `packages/stripe-adapter`, `packages/shared`, `packages/config` & `packages/telemetry`).
- 5-Signal Settlement Process Flow (AST, Tests, Security, Scope, Video).
- 5-Signal Settlement Sequence Diagram (Mermaid `sequenceDiagram`).
- Cryptographic Ledger Integrity, Single-Fire Locks, and Stripe 2-Phase Mechanics.
- Complete File Index.

### 1.2 Focus Area Verification Against Source Code

1. **EventBus Architecture (`packages/event-bus`)**:
   - `packages/event-bus/src/index.ts`: Lines 119–297 implement `RedisStreamsBus` using `ioredis`. Consumer groups register via `this.client.xgroup('CREATE', topic, this.groupName, '$', 'MKSTREAM')` (line 156) and read via `xreadgroup` (line 181).
   - DLQ & Retries: `maxRetries = 3` (line 124) with exponential backoff (`initialBackoffMs * Math.pow(2, attempt - 1)` at line 238). On failure, messages are published to `${topic}.dlq` (line 251), `metrics.dlqDepth` is incremented (line 257), and the message is acknowledged via `xack` (line 283).
   - `KafkaBus`: Lines 301–420 implement `KafkaBus` using `kafkajs` with partition key set to `correlationId` (`key: cid` at line 343) and consumer groups named `assurecode-${topic}` (line 357).
   - `OutboxRelay` (`packages/event-bus/src/outbox-relay.ts`): Lines 67–73 execute:
     ```sql
     SELECT outbox_id, topic, payload, correlation_id
     FROM outbox
     WHERE sent_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED
     ```
     Published events update `sent_at = NOW()` atomically (line 83).

2. **Merkle Ledger Client (`packages/ledger-client` & `infra/migrations/postgres`)**:
   - PostgreSQL procedure `append_ledger` (`infra/migrations/postgres/V002__ledger.sql`): Lines 54 & 86 use `PERFORM pg_advisory_lock(hashtext(p_contract_id))` and `pg_advisory_unlock` to serialize concurrent writes. Line 70 derives hash using `encode(sha256(convert_to((SELECT to_jsonb(p_payload) || to_jsonb(v_previous_hash))::text, 'UTF8')), 'hex')`.
   - `append_ledger_and_outbox` (`infra/migrations/postgres/V005__outbox.sql`): Lines 35–39 combine `append_ledger` and `INSERT INTO outbox` in a single transaction.
   - `verifyChain` (`packages/ledger-client/src/index.ts`): Lines 180–215 re-verify every link in the chain using SQL digest recalculation (`encode(digest(...), 'hex')`) with JS `calculateSha256` fallback loop.

3. **2-Phase Stripe Escrow Lifecycle (`packages/stripe-adapter`)**:
   - `packages/stripe-adapter/src/index.ts`: Lines 39–62 define `EscrowPort`.
   - Phase 1: Line 163 calls `stripe.paymentIntents.create({ ..., capture_method: 'manual' })` to hold buyer funds.
   - Phase 2: Line 176 calls `stripe.paymentIntents.capture` on approval, line 187 calls `stripe.paymentIntents.cancel` on rejection, and line 223 calls `stripe.transfers.create` to send payout to freelancer Connect account (`destinationAccountId`).
   - Seam & Fallback: Line 76 instantiates `FakeEscrowAdapter` when `secretKey` is missing or in test mode.

4. **5-Signal Settlement Engine & Single-Fire Lock (`apps/settlement-worker`)**:
   - `apps/settlement-worker/src/worker.ts`: Lines 56–90 compute 5 signals:
     - `astPassed`: `Number(payload.auditResults.maintainability) >= 10`
     - `testsPassed`: `passedTests === totalTests && totalTests > 0`
     - `securityPassed`: `vulnerabilities === 0`
     - `scopePassed`: `allowed === true`
     - `videoPassed`: `videoPassed === true`
   - Line 101 evaluates strict Boolean AND: `isApproved = state.astPassed && state.testsPassed && state.securityPassed && state.scopePassed && state.videoPassed`.
   - Single-Fire Lock (Lines 123–128):
     ```sql
     INSERT INTO settlements (contract_id, status)
     VALUES ($1, 'PROCESSING')
     ON CONFLICT (contract_id) DO NOTHING
     RETURNING contract_id
     ```
     Checks `guardRes.rowCount === 1`.
   - Concurrency Test: `apps/settlement-worker/test/settlement-concurrency.test.ts` fires 5 concurrent `INSERT INTO settlements ... ON CONFLICT DO NOTHING` requests. Empirically verifies `successfulInserts.length === 1` and `blockedInserts.length === 4`.

5. **Mermaid Diagrams**:
   - High-Level Architecture Diagram (Section 2, lines 69–147): Syntax is valid `graph TB` with 6 subgraphs. Accurately maps REST/WS calls, Webhook ingress, EventBus dispatch, Worker execution, PostgreSQL outbox polling, and S3 artifact storage.
   - 5-Signal Settlement Sequence Diagram (Section 6, lines 514–583): Syntax is valid `sequenceDiagram` with `autonumber`. Correctly models event topics (`code.push.received`, `audit.completed`, `scope.checked`, `video.verified`, `settlement.requested`, `settlement.completed`), database guard locks, and Stripe Connect transfers.

---

## 2. Logic Chain

1. **Observation**: `architecture_overview.md` describes a 5-microservice, 5-package zero-trust code escrow architecture with Redis Streams consumer groups, Kafka fallback, Transactional Outbox, SHA-256 Merkle chain, 2-phase Stripe escrow, and 5-signal single-fire oracle settlement.
2. **Verification Step 1 (EventBus)**: Inspection of `packages/event-bus/src/index.ts` and `outbox-relay.ts` confirms exact alignment with documented consumer group naming (`assurecode`), retry limit (`3`), DLQ topic format (`${topic}.dlq`), OpenTelemetry context injection, and `FOR UPDATE SKIP LOCKED` outbox querying.
3. **Verification Step 2 (Merkle Ledger)**: Inspection of `V002__ledger.sql`, `V005__outbox.sql`, and `packages/ledger-client/src/index.ts` confirms stored procedures use `pg_advisory_lock` for contract-level serialization, SHA-256 digest hashing, atomic outbox staging, and link-by-link integrity validation via `verifyChain`.
4. **Verification Step 3 (Stripe Escrow)**: Inspection of `packages/stripe-adapter/src/index.ts` confirms `capture_method: 'manual'` for PaymentIntent holds, Connect transfers for payouts, and `FakeEscrowAdapter` fallback for offline/test environments.
5. **Verification Step 4 (5-Signal Settlement)**: Inspection of `apps/settlement-worker/src/worker.ts` and `settlement-concurrency.test.ts` confirms strict Boolean AND evaluation over 5 distinct signals and single-fire lock acquisition via PostgreSQL `ON CONFLICT (contract_id) DO NOTHING`.
6. **Verification Step 5 (Diagrams & Integrity)**: Both Mermaid diagrams were parsed and verified for syntactic validity and accuracy. No dummy implementations, facade bypasses, or integrity violations were detected.
7. **Conclusion**: The document provides an exceptionally accurate, technically deep, and complete description of the system architecture.

---

## 3. Caveats

- **Docker Sandbox Fallback**: In local non-Docker container environments, `apps/ci-worker/src/sandbox-runner.ts` falls back to an isolated process runner if the Docker daemon is unreachable.
- **Node Test Runner vs Vitest**: Workspace test suites use Vitest (`npx vitest run`). Running tests with `node --test` will throw errors because test files directly import Vitest assertion primitives.

---

## 4. Conclusion

**Verdict**: **APPROVE**

The architectural overview `C:\Users\hp\AssureCode\architecture_overview.md` is approved without reservations. It accurately reflects the production code, enforces zero-trust event-driven principles, correctly details cryptographic ledger and single-fire lock mechanics, and contains precise Mermaid diagrams.

---

## 5. Verification Method

To independently verify this review:
1. Inspect `C:\Users\hp\AssureCode\architecture_overview.md`.
2. Inspect source files:
   - `packages/event-bus/src/index.ts` & `outbox-relay.ts`
   - `packages/ledger-client/src/index.ts` & `infra/migrations/postgres/V002__ledger.sql`
   - `packages/stripe-adapter/src/index.ts`
   - `apps/settlement-worker/src/worker.ts`
3. Execute Vitest test suites:
   ```bash
   npx vitest run
   ```
4. Verify single-fire lock test:
   ```bash
   npx vitest run apps/settlement-worker/test/settlement-concurrency.test.ts
   ```
