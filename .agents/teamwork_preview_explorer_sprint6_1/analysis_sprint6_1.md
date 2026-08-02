# Sprint 6.1 & Sprint 6.3 Architectural Analysis and Implementation Strategy

## 1. Executive Summary

This report presents a thorough investigation of **Sprint 6.1 (Idempotency Keys End-to-End)** and **Sprint 6.3 (Provably Single-Fire Settlement)** in the AssureCode repository (`C:\Users\hp\AssureCode`).

AssureCode is a zero-trust, event-driven multi-agent freelance contract ecosystem built on Node.js/TypeScript (Fastify, PostgreSQL, Redis, Vitest) and Python (FastAPI). To prevent duplicate side-effects (such as duplicate contract creation, duplicate test generation calls to LLM/S3, duplicate escrow initialization, and double payment transfers to freelancers), two major resilience mechanisms are required:
1. **Sprint 6.1**: End-to-end idempotency key caching on all 5 mutating gateway endpoints (`initialize`, `lock`, `generate-tests`, `escrow`, `settle`) backed by PostgreSQL persistence.
2. **Sprint 6.3**: Provably single-fire payment settlement guarded by a PostgreSQL `settlements` table (`ON CONFLICT DO NOTHING`) and an atomic transaction linking the Stripe transfer result with the `INVOICE` Merkle ledger append.

---

## 2. Codebase Audit & Current State Mapping

### 2.1 File & Module Inventory

| File / Component Path | Current State / Role | Sprint 6 Target Changes |
|---|---|---|
| `packages/shared/src/index.ts` | Shared domain types and Zod schemas | Add `IdempotencyKeySchema` and `IdempotencyHeaderSchema` |
| `infra/migrations/postgres/` | Contains `V001__init.sql` and `V002__ledger.sql` | Create `V003__idempotency.sql` and `V004__settlements.sql` |
| `tools/migrate.ts` | Idempotent migration runner reading `.sql` files in `infra/migrations/postgres/` | Automatically runs new migrations in alphabetical order |
| `apps/api-gateway/src/server.ts` | Fastify REST API server exposing 5 mutating endpoints | Add Fastify idempotency middleware / wrapper to cache and return response on replayed keys |
| `apps/settlement-worker/src/worker.ts` | Background worker listening for `SETTLEMENT_REQUESTED` and evaluating 5-signal oracle | Integrate `settlements` guard table, `ON CONFLICT DO NOTHING` check, and single-transaction ledger append |
| `packages/ledger-client/src/index.ts` | Client wrapping `append_ledger` stored procedure | Provides `append` and `appendWith` supporting external DB transactions |

### 2.2 Detailed Inspection Findings

1. **`packages/shared/src/index.ts`**:
   - Currently exports event topics, event envelopes, contract DTOs, audit schemas, and settlement events.
   - Lacks Zod schemas for validating `Idempotency-Key` or `x-idempotency-key` HTTP request headers.

2. **Database Migrations (`infra/migrations/postgres/`)**:
   - `V001__init.sql`: Creates `contracts`, `rag_embeddings`, `escrow`, `audit_results`.
   - `V002__ledger.sql`: Creates `merkle_ledger` table and `append_ledger(p_contract_id, p_action_type, p_payload)` PL/pgSQL function.
   - `tools/migrate.ts` executes migration files sorted by filename and tracks applied files in `_migrations`.
   - No idempotency table or settlement guard table exists in the database schema currently.

3. **API Gateway (`apps/api-gateway/src/server.ts`)**:
   - Lines 98–124: `POST /api/contracts/initialize` — Creates a contract ID, publishes `CONTRACT_INITIALIZED`, returns HTTP 201. Currently has no idempotency check.
   - Lines 135–213: `POST /api/contracts/:contractId/generate-tests` — Calls `ai-service`, appends `TESTS_GENERATED` to ledger, publishes `TESTS_GENERATED` event. Replaying will re-trigger AI calls and create duplicate ledger entries.
   - Lines 215–266: `POST /api/contracts/:contractId/lock` — Appends `CONTRACT_LOCKED` to ledger, publishes event, ingests RAG text. Replaying will create duplicate ledger rows with different hashes.
   - Lines 268–306: `POST /api/contracts/:contractId/escrow` — Creates Stripe PaymentIntent, appends `ESCROW_CREATED` to ledger. Replaying creates multiple PaymentIntents.
   - Lines 308–339: `POST /api/contracts/:contractId/settle` — Performs basic check on existing `INVOICE` entry in chain, but lacks header-based HTTP request idempotency.

4. **Settlement Worker (`apps/settlement-worker/src/worker.ts`)**:
   - Lines 97–162: Handles `SETTLEMENT_REQUESTED` event.
   - Currently evaluates in-memory 5-signal oracle state (`astPassed`, `testsPassed`, `securityPassed`, `scopePassed`, `videoPassed`).
   - If approved, immediately calls `escrowAdapter.transferToFreelancer(...)` and then calls `ledgerClient.append(contractId, 'INVOICE', invoicePayload)`.
   - **Vulnerability**: If multiple `SETTLEMENT_REQUESTED` events arrive concurrently or on event re-delivery, `transferToFreelancer` is invoked multiple times before the first ledger entry is committed. There is no database lock or guard table protecting the transfer step.

---

## 3. Sprint 6.1 — Idempotency Keys End-to-End Implementation Strategy

### 3.1 Architecture Overview

```
Client Request with 'Idempotency-Key: <key>'
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ Fastify Idempotency Middleware / Route Wrapper             │
├─────────────────────────────────────────────────────────────┤
│ 1. Check idempotency_keys DB table for (key)                │
│    ├── EXISTS & NOT EXPIRED: Return cached HTTP response  │
│    └── NOT FOUND: Proceed to handler                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Target Mutating Endpoint Handler                            │
│ (initialize, lock, generate-tests, escrow, settle)           │
│                                                             │
│ Performs domain logic, external API calls, DB / Ledger writes│
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Post-Handler Caching                                        │
│ Save (key, contract_id, response_json, status_code) to DB    │
│ Return HTTP response to client                              │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Step-by-Step Implementation Steps

#### Step 1: Update `packages/shared/src/index.ts`
Add header validation schemas:
```ts
// ── Idempotency Key DTO ──────────────────────────────────────────
export const IdempotencyKeyHeaderSchema = z.object({
  'idempotency-key': z.string().min(1).max(255).optional(),
  'x-idempotency-key': z.string().min(1).max(255).optional(),
}).passthrough();

export type IdempotencyKeyHeader = z.infer<typeof IdempotencyKeyHeaderSchema>;
```

#### Step 2: Database Migration `infra/migrations/postgres/V003__idempotency.sql`
Create the `idempotency_keys` table:
```sql
-- =============================================================================
-- V003__idempotency.sql — Gateway Idempotency Keys Persistence
-- =============================================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key           TEXT        PRIMARY KEY,
    contract_id   TEXT        NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
    response_json JSONB       NOT NULL,
    status_code   INTEGER     NOT NULL DEFAULT 200,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_contract ON idempotency_keys(contract_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys(expires_at);
```

#### Step 3: Implement Gateway Idempotency Helper in `apps/api-gateway/src/services/idempotency.ts` (or inline in `server.ts`)
```ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import pg from 'pg';

export async function withIdempotency<T>(
  pool: pg.Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  handler: () => Promise<{ statusCode: number; body: T; contractId?: string }>
): Promise<FastifyReply> {
  const key = (request.headers['idempotency-key'] || request.headers['x-idempotency-key']) as string | undefined;

  if (!key) {
    const result = await handler();
    return reply.status(result.statusCode).send(result.body);
  }

  // 1. Check cache
  const cached = await pool.query(
    'SELECT response_json, status_code FROM idempotency_keys WHERE key = $1 AND expires_at > now()',
    [key]
  );

  if (cached.rowCount && cached.rowCount > 0) {
    const row = cached.rows[0];
    return reply.status(row.status_code).send(row.response_json);
  }

  // 2. Execute handler
  const result = await handler();

  // 3. Cache result idempotently
  await pool.query(
    `INSERT INTO idempotency_keys (key, contract_id, response_json, status_code)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (key) DO NOTHING`,
    [key, result.contractId || null, JSON.stringify(result.body), result.statusCode]
  );

  return reply.status(result.statusCode).send(result.body);
}
```

#### Step 4: Wrap Mutating Endpoints in `apps/api-gateway/src/server.ts`
Wrap `/api/contracts/initialize`, `/api/contracts/:contractId/lock`, `/api/contracts/:contractId/generate-tests`, `/api/contracts/:contractId/escrow`, and `/api/contracts/:contractId/settle` using `withIdempotency`.

---

## 4. Sprint 6.3 — Provably Single-Fire Settlement Implementation Strategy

### 4.1 Architecture Overview

```
SETTLEMENT_REQUESTED Event Received
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 5-Signal Oracle Verification                                │
│ (astPassed && testsPassed && securityPassed && scopePassed && videoPassed)
└──────────────────────────┬──────────────────────────────────┘
                           │ Approved
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Database Guard Check (Atomic Row Locking)                   │
│ INSERT INTO settlements (contract_id, status) VALUES ($1, 'PROCESSING')
│ ON CONFLICT (contract_id) DO NOTHING RETURNING contract_id   │
├─────────────────────────────────────────────────────────────┤
│ ├── 0 rows returned: DUPLICATE! Abort processing.           │
│ └── 1 row returned: FIRST FIRE. Proceed to transfer.        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Stripe Transfer Execution                                   │
│ escrowAdapter.transferToFreelancer(...)                      │
└──────────────────────────┬──────────────────────────────────┘
                           │ Success
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Atomic DB Transaction                                       │
│ BEGIN                                                       │
│ 1. append_ledger(contractId, 'INVOICE', payload)           │
│ 2. UPDATE settlements SET status = 'COMPLETED', transfer_id │
│ COMMIT                                                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Publish SETTLEMENT_COMPLETED Event                          │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Step-by-Step Implementation Steps

#### Step 1: Database Migration `infra/migrations/postgres/V004__settlements.sql`
Create the `settlements` guard table:
```sql
-- =============================================================================
-- V004__settlements.sql — Single-Fire Settlement Guard Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS settlements (
    contract_id  TEXT        PRIMARY KEY REFERENCES contracts(contract_id) ON DELETE CASCADE,
    status       TEXT        NOT NULL DEFAULT 'PROCESSING'
                 CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
    transfer_id  TEXT        NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### Step 2: Refactor `apps/settlement-worker/src/worker.ts`
1. Initialize a `pg.Pool` connection in `worker.ts`.
2. Update the `SETTLEMENT_REQUESTED` event subscriber:
```ts
eventBus.subscribe(EVENT_TOPICS.SETTLEMENT_REQUESTED, async (event: EventEnvelope) => {
  const payload = event.payload as SettlementRequested;
  const { contractId, freelancerId, amountCents } = payload;
  
  logger.info({ contractId }, 'Evaluating 5-Signal Oracle for settlement');
  const state = getState(contractId);
  
  const isApproved = 
    state.astPassed && 
    state.testsPassed && 
    state.securityPassed && 
    state.scopePassed && 
    state.videoPassed;

  const correlationId = randomUUID();

  if (!isApproved) {
    logger.warn({ contractId, state }, 'Settlement REJECTED by Oracle');
    await eventBus.publish(
      EVENT_TOPICS.SETTLEMENT_REJECTED,
      { contractId, reason: 'Oracle conditions not met', state },
      correlationId
    );
    return;
  }

  // 1. Guard check: ON CONFLICT DO NOTHING
  const guardRes = await dbPool.query(
    `INSERT INTO settlements (contract_id, status)
     VALUES ($1, 'PROCESSING')
     ON CONFLICT (contract_id) DO NOTHING
     RETURNING contract_id`,
    [contractId]
  );

  if (guardRes.rowCount === 0) {
    logger.warn({ contractId }, 'Settlement request ignored: Contract settlement already executed or in progress');
    return;
  }

  logger.info({ contractId }, 'Settlement APPROVED by Oracle & locked in DB guard. Executing transfer.');

  try {
    // 2. Stripe Transfer
    const transferRes = await escrowAdapter.transferToFreelancer({
      amountCents,
      destinationAccountId: 'acct_freelancer_123',
      contractId,
    });

    // 3. Atomic DB transaction for Ledger Append + Settlements status update
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      const invoicePayload = {
        amountCents,
        freelancerId,
        transferId: transferRes.transferId,
        oracleState: state,
        settledAt: new Date().toISOString(),
      };
      
      await ledgerClient.append(contractId, 'INVOICE', invoicePayload, client);
      
      await client.query(
        `UPDATE settlements
         SET status = 'COMPLETED', transfer_id = $1, updated_at = now()
         WHERE contract_id = $2`,
        [transferRes.transferId, contractId]
      );
      
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      await dbPool.query(
        `UPDATE settlements SET status = 'FAILED', updated_at = now() WHERE contract_id = $1`,
        [contractId]
      );
      throw txErr;
    } finally {
      client.release();
    }

    // 4. Publish Event
    await eventBus.publish(
      EVENT_TOPICS.SETTLEMENT_COMPLETED,
      {
        contractId,
        amountCents,
        transferId: transferRes.transferId,
        completedAt: new Date().toISOString(),
      },
      correlationId
    );

    logger.info({ contractId, transferId: transferRes.transferId }, 'Settlement complete');
  } catch (err: any) {
    logger.error({ contractId, err: err.message }, 'Settlement execution failed');
    await eventBus.publish(
      EVENT_TOPICS.SETTLEMENT_REJECTED,
      { contractId, reason: `Transfer failed: ${err.message}` },
      correlationId
    );
  }
});
```

---

## 5. Verification & Acceptance Testing Procedures

### 5.1 Sprint 6.1 Acceptance Tests

1. **Replay Test for Gateway Endpoints**:
   - Send `POST /api/contracts/initialize` with `Idempotency-Key: test-key-101`. Note `contractId_1`.
   - Re-send exact same `POST /api/contracts/initialize` with `Idempotency-Key: test-key-101`.
   - **Expected**: Returned `contractId` MUST match `contractId_1` exactly. No duplicate contracts in database.
   - Send `POST /api/contracts/AC-TEST/lock` twice with `Idempotency-Key: test-key-102`.
   - **Expected**: Returns identical response JSON and Merkle hash. Inspection of `merkle_ledger` table shows **exactly one** `CONTRACT_LOCKED` row for `AC-TEST`.

2. **Automated Vitest Test Case**:
   - Add integration test file `apps/api-gateway/test/idempotency.test.ts` executing parallel requests with identical idempotency headers.

### 5.2 Sprint 6.3 Acceptance Tests

1. **Concurrent Settlement Request Test**:
   - Simulate 5 concurrent calls to `/api/contracts/AC-SETTLE-TEST/settle` with oracle state fully passed.
   - **Expected**:
     - `settlement-worker` receives 5 events.
     - `settlements` table has exactly 1 row with `status = 'COMPLETED'`.
     - Stripe fake adapter receives **exactly 1** `transferToFreelancer` call.
     - `merkle_ledger` contains **exactly 1** `INVOICE` entry.
     - Merkle chain verification (`ledgerClient.verifyChain('AC-SETTLE-TEST')`) returns `true`.

---

## 6. Summary of Action Items for Implementer Agent

| Step # | File | Action |
|---|---|---|
| 1 | `packages/shared/src/index.ts` | Export `IdempotencyKeyHeaderSchema` |
| 2 | `infra/migrations/postgres/V003__idempotency.sql` | Create `idempotency_keys` migration |
| 3 | `infra/migrations/postgres/V004__settlements.sql` | Create `settlements` guard table migration |
| 4 | `apps/api-gateway/src/server.ts` | Apply idempotency caching wrapper to `initialize`, `lock`, `generate-tests`, `escrow`, `settle` |
| 5 | `apps/settlement-worker/src/worker.ts` | Integrate `settlements` table `ON CONFLICT DO NOTHING` and transaction-bound ledger append |
| 6 | `apps/api-gateway/test/idempotency.test.ts` | Add unit/integration tests verifying duplicate request suppression |
| 7 | `apps/settlement-worker/test/settlement.test.ts` | Add concurrency test asserting single Stripe transfer on duplicate settlement requests |
