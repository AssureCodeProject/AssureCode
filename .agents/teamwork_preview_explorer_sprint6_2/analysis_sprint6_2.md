# Technical Analysis & Implementation Strategy: Sprint 6.2 & Sprint 6.5

**Author:** `teamwork_preview_explorer_sprint6_2`  
**Date:** 2026-07-28  
**Repository:** `AssureCode` (Trust-Code 2.0)  
**Status:** Completed Investigation  

---

## 1. Executive Summary

This document provides a comprehensive technical investigation and step-by-step implementation strategy for:
- **Sprint 6.2: Bounded Retries & Dead-Letter Stream (`*.dlq`)** in `packages/event-bus` (specifically `RedisStreamsBus`), accompanied by the `tools/replay-event.ts` helper tool.
- **Sprint 6.5: Transactional Outbox for Cross-Service Writes**, introducing an `outbox` PostgreSQL table, atomic ledger + outbox writes, and a reliable relay pump to `RedisStreams`.

Both features address critical resilience and zero-loss event guarantees in the AssureCode ecosystem.

---

## 2. Codebase Inspection Findings

### 2.1 Event Bus (`packages/event-bus`)
- **Location:** `packages/event-bus/src/index.ts`
- **Current Behavior in `RedisStreamsBus` (Lines 114–155):**
  ```typescript
  // Line 142-147 in packages/event-bus/src/index.ts
  try {
    await handler(envelope);
  } catch (err) {
    console.error(`[event-bus] handler error on ${topic}:`, err);
  }
  await this.client.xack(topic, this.groupName, id);
  ```
  - **Critical Flaw:** Any exception thrown by an event subscriber is caught, logged, and immediately acknowledged via `xack()`.
  - There is **no retry attempt**, **no exponential backoff**, and **no dead-letter stream** (`*.dlq`).
  - Failed messages (poison messages) are acknowledged and discarded silently, causing silent data loss across background workers.

### 2.2 Tooling (`tools/`)
- **Location:** `tools/`
- **Current State:** Contains `migrate.ts`, `seed-neo4j.ts`, and `package.json`.
- **Missing Asset:** `tools/replay-event.ts` does **not exist**. Operability demands a CLI utility to inspect and replay DLQ messages back into their active target stream.

### 2.3 Database Schema & Migrations (`infra/migrations/postgres/`)
- **Existing Migrations:**
  - `V001__init.sql` (Contracts, RAG embeddings, Escrow, Audit Results)
  - `V002__ledger.sql` (Merkle ledger table + `append_ledger` PL/pgSQL function using `pg_advisory_lock`)
- **Current State:** No `outbox` table or `sent_at` state tracking exists in PostgreSQL.

### 2.4 Event Publishing in Application Services
- **Locations Inspected:**
  - `apps/api-gateway/src/server.ts` (Lines 187-205, 223-255, 293-297, 326-331)
  - `apps/settlement-worker/src/worker.ts` (Lines 140-151)
- **Current Pattern:**
  Services execute DB operations (`ledgerClient.append(...)`) and immediately invoke `eventBus.publish(...)` in separate, non-transactional in-memory steps:
  ```typescript
  // Example from api-gateway/src/server.ts:223-255
  const ledgerRow = await ledgerClient.append(contractId, 'CONTRACT_LOCKED', ...);
  // CRASH RISK: If process dies here, DB has committed but Redis event is never published!
  await eventBus.publish(EVENT_TOPICS.CONTRACT_LOCKED, lockedPayload, correlationId);
  ```
  - **Vulnerability:** Process crashes, network partition, or Redis failure immediately after DB commit drops events permanently, breaking downstream worker consumers.

---

## 3. Detailed Requirements & Gap Analysis

| Feature | Requirement | Current Implementation State | Gap / Needed Action |
|---|---|---|---|
| **6.2 Retry Limit** | `MAX_RETRIES=3` attempts per message failure | 0 retries (fails on 1st attempt, ACKed immediately) | Wrap subscriber execution in loop up to `MAX_RETRIES` (3 total attempts). |
| **6.2 Backoff Strategy** | Exponential backoff between retries (e.g. 100ms, 200ms, 400ms) | No backoff | Introduce asynchronous `setTimeout` backoff calculation based on attempt index. |
| **6.2 Dead-Letter Stream** | Move poison messages to `${topic}.dlq` after 3 failed attempts | No DLQ stream | Write `xadd` to `${topic}.dlq` with envelope, failure metadata, attempt count, and error stack before `xack`. |
| **6.2 DLQ Replay Helper** | `REPLAY <stream> <id>` via `tools/replay-event.ts` | File missing | Implement CLI script `tools/replay-event.ts` using `ioredis` to move DLQ messages back to main stream. |
| **6.5 Outbox Schema** | `outbox(id, topic, payload, correlation_id, created_at, sent_at)` | No outbox table in Postgres | Add migration `V004__outbox.sql` with partial index on `sent_at IS NULL`. |
| **6.5 Atomic Outbox Writes** | Single DB transaction for ledger append + outbox insert | Application level non-atomic calls | Create PL/pgSQL function `append_ledger_and_outbox` or wrap in `LedgerClient.appendWithOutbox(...)`. |
| **6.5 Outbox Relay Pump** | Background daemon pumping `outbox -> RedisStreams` | No outbox relay daemon | Implement `OutboxRelay` class in `@assurecode/event-bus` (or standalone worker) using `SKIP LOCKED`. |

---

## 4. Step-by-Step Implementation Strategy

### Step 1: Add Migration `infra/migrations/postgres/V004__outbox.sql`
Create `infra/migrations/postgres/V004__outbox.sql`:

```sql
-- =============================================================================
-- V004__outbox.sql — Transactional Outbox table + Stored Procedure
-- =============================================================================

CREATE TABLE IF NOT EXISTS outbox (
    outbox_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    topic          TEXT        NOT NULL,
    payload        JSONB       NOT NULL,
    correlation_id TEXT        NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at        TIMESTAMPTZ NULL
);

-- Partial index for fast relay polling of unsent events
CREATE INDEX IF NOT EXISTS idx_outbox_unsent 
    ON outbox(created_at ASC) 
    WHERE sent_at IS NULL;

-- Atomic transaction helper function
CREATE OR REPLACE FUNCTION append_ledger_and_outbox(
    p_contract_id    TEXT,
    p_action_type    TEXT,
    p_ledger_payload JSONB,
    p_topic          TEXT,
    p_event_payload  JSONB,
    p_correlation_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_ledger_row JSONB;
BEGIN
    -- 1. Append to merkle_ledger with advisory lock
    v_ledger_row := append_ledger(p_contract_id, p_action_type, p_ledger_payload);

    -- 2. Stage event in outbox within the EXACT same transaction
    INSERT INTO outbox (topic, payload, correlation_id)
    VALUES (p_topic, p_event_payload, p_correlation_id);

    RETURN v_ledger_row;
END;
$$;
```

---

### Step 2: Extend `packages/event-bus/src/index.ts` (Sprint 6.2)

Update `RedisStreamsBus.poll()` in `packages/event-bus/src/index.ts` (around line 114):

```typescript
export class RedisStreamsBus implements EventBus {
  private client: InstanceType<typeof Redis>;
  private subscribers: Array<{ topic: string; consumer: string; stop: boolean }> = [];
  private groupName = 'assurecode';
  private groupNameEnsured = new Set<string>();
  private readonly maxRetries = 3;
  private readonly initialBackoffMs = 100;

  // ... existing constructor and publish methods ...

  private async poll(
    topic: string,
    consumer: string,
    handler: EventHandler,
    sub: { stop: boolean },
  ): Promise<void> {
    while (!sub.stop) {
      try {
        const res = (await this.client.xreadgroup(
          'GROUP',
          this.groupName,
          consumer,
          'COUNT',
          10,
          'BLOCK',
          2000,
          'STREAMS',
          topic,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!res) continue;

        for (const [, messages] of res) {
          for (const [id, fields] of messages) {
            const idx = fields.indexOf('envelope');
            if (idx === -1) continue;
            const envelope = JSON.parse(fields[idx + 1]) as EventEnvelope;

            let attempt = 0;
            let success = false;
            let lastError: unknown = null;

            while (attempt < this.maxRetries) {
              attempt++;
              try {
                await handler(envelope);
                success = true;
                break;
              } catch (err) {
                lastError = err;
                console.error(
                  `[event-bus] handler error on ${topic} (attempt ${attempt}/${this.maxRetries}):`,
                  err,
                );
                if (attempt < this.maxRetries) {
                  const backoff = this.initialBackoffMs * Math.pow(2, attempt - 1);
                  await new Promise((r) => setTimeout(r, backoff));
                }
              }
            }

            if (!success) {
              const dlqTopic = `${topic}.dlq`;
              const errorMessage =
                lastError instanceof Error ? lastError.message : String(lastError);
              const errorStack =
                lastError instanceof Error ? lastError.stack : '';

              console.error(
                `[event-bus] Message ${id} failed after ${this.maxRetries} attempts on ${topic}. Forwarding to ${dlqTopic}`,
              );

              // Route poison message to DLQ stream
              await this.client.xadd(
                dlqTopic,
                '*',
                'envelope', JSON.stringify(envelope),
                'error', errorMessage,
                'errorStack', errorStack || '',
                'failedAt', new Date().toISOString(),
                'attempts', String(attempt),
                'originalStream', topic,
                'originalId', id,
              );
            }

            // Acknowledge original message so stream consumer group advances
            await this.client.xack(topic, this.groupName, id);
          }
        }
      } catch (err) {
        if (!sub.stop) console.error(`[event-bus] poll error on ${topic}:`, err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
```

---

### Step 3: Implement `tools/replay-event.ts` (Sprint 6.2 Helper Script)

Create new file `tools/replay-event.ts`:

```typescript
/**
 * tools/replay-event.ts — Replay a dead-lettered event from a *.dlq stream back into the main stream.
 *
 * Usage:
 *   npx tsx tools/replay-event.ts <dlq_stream> <message_id>
 * Example:
 *   npx tsx tools/replay-event.ts audit.completed.dlq 1722170000000-0
 */
import { Redis } from 'ioredis';
import { loadConfig } from '@assurecode/config';

const config = loadConfig();
const redisUrl = config.REDIS_URL || 'redis://localhost:6379';

async function main() {
  const args = process.argv.slice(2);
  let dlqStream = args[0];
  let messageId = args[1];

  // Also support syntax: REPLAY <stream> <id>
  if (dlqStream?.toUpperCase() === 'REPLAY') {
    dlqStream = args[1];
    messageId = args[2];
  }

  if (!dlqStream || !messageId) {
    console.error('Usage: npx tsx tools/replay-event.ts <dlq_stream> <message_id>');
    console.error('  or: npx tsx tools/replay-event.ts REPLAY <dlq_stream> <message_id>');
    process.exit(1);
  }

  const redis = new Redis(redisUrl);

  try {
    // Read the message from DLQ stream
    const entries = (await redis.xrange(dlqStream, messageId, messageId)) as Array<
      [string, string[]]
    >;

    if (!entries || entries.length === 0) {
      console.error(`Message ${messageId} not found in stream ${dlqStream}`);
      process.exit(1);
    }

    const [id, fields] = entries[0];
    const envIdx = fields.indexOf('envelope');
    if (envIdx === -1) {
      console.error(`Message ${id} in ${dlqStream} does not contain an 'envelope' field.`);
      process.exit(1);
    }

    const envelopeStr = fields[envIdx + 1];
    
    // Determine target topic stream (strip .dlq suffix or check originalStream)
    const origStreamIdx = fields.indexOf('originalStream');
    const targetTopic =
      origStreamIdx !== -1
        ? fields[origStreamIdx + 1]
        : dlqStream.replace(/\.dlq$/, '');

    // Re-publish envelope to target topic stream
    const newId = await redis.xadd(targetTopic, '*', 'envelope', envelopeStr);

    console.log(
      `[replay] Successfully replayed event ${id} from ${dlqStream} -> stream ${targetTopic} (new message ID: ${newId})`,
    );

    // Optional cleanup: remove from DLQ stream
    await redis.xdel(dlqStream, id);
    console.log(`[replay] Removed event ${id} from ${dlqStream}`);
  } catch (err) {
    console.error('[replay] Error replaying event:', err);
    process.exit(1);
  } finally {
    await redis.quit();
  }
}

main();
```

---

### Step 4: Implement Outbox Relay Daemon (`packages/event-bus/src/outbox-relay.ts`) (Sprint 6.5)

Create file `packages/event-bus/src/outbox-relay.ts`:

```typescript
import pg from 'pg';
import type { EventBus } from './index.js';

export interface OutboxRelayOptions {
  databaseUrl: string;
  eventBus: EventBus;
  pollIntervalMs?: number;
  batchSize?: number;
}

export class OutboxRelay {
  private pool: pg.Pool;
  private eventBus: EventBus;
  private pollIntervalMs: number;
  private batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(options: OutboxRelayOptions) {
    this.pool = new pg.Pool({ connectionString: options.databaseUrl });
    this.eventBus = options.eventBus;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.batchSize = options.batchSize ?? 50;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNext();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => void this.pump(), this.pollIntervalMs);
  }

  public async pump(): Promise<number> {
    const client = await this.pool.connect();
    let processed = 0;
    try {
      await client.query('BEGIN');

      // Lock unsent outbox rows safely using FOR UPDATE SKIP LOCKED
      const res = await client.query<{
        outbox_id: string;
        topic: string;
        payload: Record<string, unknown>;
        correlation_id: string | null;
      }>(
        `SELECT outbox_id, topic, payload, correlation_id
         FROM outbox
         WHERE sent_at IS NULL
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );

      for (const row of res.rows) {
        // Publish outbox event to EventBus (RedisStreams)
        await this.eventBus.publish(
          row.topic,
          row.payload,
          row.correlation_id || undefined,
        );

        // Mark sent in PostgreSQL
        await client.query(
          `UPDATE outbox SET sent_at = now() WHERE outbox_id = $1`,
          [row.outbox_id],
        );
        processed++;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[outbox-relay] Error pumping outbox events:', err);
    } finally {
      client.release();
      this.scheduleNext();
    }
    return processed;
  }

  public async close(): Promise<void> {
    this.stop();
    await this.pool.end();
  }
}
```

---

### Step 5: Update `LedgerClient` (`packages/ledger-client/src/index.ts`) (Sprint 6.5)

Add atomic outbox helper to `LedgerClient`:

```typescript
  /** Append to Merkle chain AND stage event in outbox table atomically. */
  async appendWithOutbox(
    contractId: string,
    actionType: string,
    ledgerPayload: Record<string, unknown>,
    eventTopic: string,
    eventPayload: Record<string, unknown>,
    correlationId?: string,
  ): Promise<LedgerRow> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT append_ledger_and_outbox($1, $2, $3::jsonb, $4, $5::jsonb, $6) AS row',
        [
          contractId,
          actionType,
          JSON.stringify(ledgerPayload),
          eventTopic,
          JSON.stringify(eventPayload),
          correlationId || null,
        ],
      );
      return normalizeRow(result.rows[0].row as Record<string, unknown>);
    } finally {
      client.release();
    }
  }
```

---

### Step 6: Update Application Handlers (`apps/api-gateway/src/server.ts` & `apps/settlement-worker/src/worker.ts`)

In `apps/api-gateway/src/server.ts`:
- Replace separate calls:
  `ledgerClient.append(...)` + `eventBus.publish(...)`
- With atomic call:
  `ledgerClient.appendWithOutbox(contractId, 'CONTRACT_LOCKED', lockedPayload, EVENT_TOPICS.CONTRACT_LOCKED, lockedPayload, correlationId)`
- Initialize and start `OutboxRelay` upon server boot.

---

## 5. Verification & Acceptance Testing Procedures

### 5.1 Sprint 6.2 Acceptance Test (Bounded Retries & DLQ)
1. **Setup Test Case:**
   - Create a test handler in `packages/event-bus/test/event-bus.test.ts` that throws an error every time it is invoked (`attempts++`, `throw new Error('Poison message simulation')`).
2. **Execute Test:**
   - Subscribe handler to topic `audit.completed`.
   - Publish event to `audit.completed`.
   - Wait for poll loop execution.
3. **Assertions:**
   - Confirm handler is invoked exactly **3 times** (Initial attempt + 2 exponential retries).
   - Check Redis stream `audit.completed.dlq` using `xlen('audit.completed.dlq')`.
   - Verify 1 entry exists in `audit.completed.dlq` containing `envelope`, `attempts: "3"`, `originalStream: "audit.completed"`.
4. **Replay Test:**
   - Execute `npx tsx tools/replay-event.ts audit.completed.dlq <message_id>`.
   - Verify event is re-published to `audit.completed` and deleted from `audit.completed.dlq`.

### 5.2 Sprint 6.5 Acceptance Test (Transactional Outbox)
1. **Setup Test Case:**
   - Run `tools/migrate.ts` to apply `V004__outbox.sql`.
2. **Execute Test:**
   - Invoke `ledgerClient.appendWithOutbox(...)`.
   - Check PostgreSQL:
     - `SELECT count(*) FROM merkle_ledger WHERE contract_id = 'c_test';` -> returns 1.
     - `SELECT count(*) FROM outbox WHERE sent_at IS NULL;` -> returns 1.
3. **Process Crash Simulation:**
   - Simulate process termination before Redis publish occurs.
   - Start `OutboxRelay`.
   - Trigger `outboxRelay.pump()`.
4. **Assertions:**
   - Event arrives in `RedisStreamsBus`.
   - `SELECT count(*) FROM outbox WHERE sent_at IS NOT NULL;` -> returns 1.
   - Zero events lost.

---

## 6. Summary of Touched Files & Line References

| Target File | Changes Required | Sprint |
|---|---|---|
| `infra/migrations/postgres/V004__outbox.sql` | Create `outbox` table, index, and `append_ledger_and_outbox` PL/pgSQL function | 6.5 |
| `packages/event-bus/src/index.ts` | Update `RedisStreamsBus.poll()` with retry counter, exponential backoff, and `.dlq` stream forwarding | 6.2 |
| `packages/event-bus/src/outbox-relay.ts` | Create background outbox relay class using PostgreSQL `FOR UPDATE SKIP LOCKED` | 6.5 |
| `tools/replay-event.ts` | Create CLI helper script for replaying DLQ messages back to active streams | 6.2 |
| `packages/ledger-client/src/index.ts` | Add `appendWithOutbox()` atomic wrapper method | 6.5 |
| `apps/api-gateway/src/server.ts` | Wire mutating endpoints to `appendWithOutbox()` and initialize `OutboxRelay` | 6.5 |
| `packages/event-bus/test/event-bus.test.ts` | Add Vitest suite testing `MAX_RETRIES=3`, backoff, DLQ forwarding, and replay | 6.2 & 6.5 |
