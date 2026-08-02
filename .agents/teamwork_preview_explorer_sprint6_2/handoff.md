# Handoff Report: Sprint 6.2 & Sprint 6.5 Investigation

**Author:** `teamwork_preview_explorer_sprint6_2`  
**Working Directory:** `C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint6_2`  
**Date:** 2026-07-28  
**Handoff Type:** Hard (Task complete)  

---

## 1. Observation

Direct observations from inspecting the codebase:

1. **`packages/event-bus/src/index.ts` (Lines 114–155):**
   ```typescript
   // Lines 142–147:
   try {
     await handler(envelope);
   } catch (err) {
     console.error(`[event-bus] handler error on ${topic}:`, err);
   }
   await this.client.xack(topic, this.groupName, id);
   ```
   - Observed: Subscriber exceptions are caught, logged, and immediately acknowledged via `xack()`.
   - Observed: No retry loop, exponential backoff, or dead-letter queue (`*.dlq`) logic exists in `RedisStreamsBus`.

2. **`tools/` Directory:**
   - Command: `list_dir` on `C:\Users\hp\AssureCode\tools`
   - Output: `migrate.ts`, `package.json`, `seed-neo4j.ts`.
   - Observed: `tools/replay-event.ts` helper script does not exist.

3. **`infra/migrations/postgres/` Directory:**
   - Command: `find_by_name` on `infra/migrations`
   - Output: `V001__init.sql`, `V002__ledger.sql`.
   - Observed: No `outbox` table or `sent_at` column exists in the database schema.

4. **`apps/api-gateway/src/server.ts` (Lines 223–255):**
   ```typescript
   const ledgerRow = await ledgerClient.append(contractId, 'CONTRACT_LOCKED', ...);
   await eventBus.publish(EVENT_TOPICS.CONTRACT_LOCKED, lockedPayload, correlationId);
   ```
   - Observed: Database write (`ledgerClient.append`) and event publishing (`eventBus.publish`) are executed as separate application calls without an atomic database transaction or outbox staging.

---

## 2. Logic Chain

1. **Observation 1** shows that `RedisStreamsBus` acknowledges failed messages immediately on the first exception.
   - **Step 1:** Therefore, any transient error or poison message causes silent data loss without retries or DLQ isolation.
   - **Step 2:** To satisfy Sprint 6.2 requirement, `poll()` in `RedisStreamsBus` must be updated to track execution attempts up to `MAX_RETRIES = 3` with exponential backoff (`100ms * 2^(attempt-1)`), and forward poison messages failing after 3 attempts to `${topic}.dlq` stream prior to `xack()`.

2. **Observation 2** shows that `tools/replay-event.ts` is missing.
   - **Step 1:** Operational recovery requires a script to read DLQ messages and re-inject them into active streams.
   - **Step 2:** `tools/replay-event.ts` must be created to implement `REPLAY <stream> <id>` command, reading from `${topic}.dlq`, re-publishing to `${topic}`, and deleting from `.dlq`.

3. **Observations 3 & 4** show that DB writes and event publishing in `api-gateway` and workers are non-atomic.
   - **Step 1:** If the service process crashes between `ledgerClient.append` and `eventBus.publish`, the event is dropped permanently while the ledger row remains committed.
   - **Step 2:** To satisfy Sprint 6.5 requirement, migration `V004__outbox.sql` must introduce an `outbox` table and `append_ledger_and_outbox` stored procedure.
   - **Step 3:** An `OutboxRelay` daemon must be added to poll unsent outbox events using `FOR UPDATE SKIP LOCKED` and publish them to `RedisStreamsBus`, ensuring zero lost events under crashes.

---

## 3. Caveats

- **InMemoryBus Behavior:** While Sprint 6.2 targets `RedisStreamsBus`, adding in-memory DLQ tracking to `InMemoryBus` in `packages/event-bus/src/index.ts` is recommended so Vitest tests can verify retry/DLQ mechanics cleanly without requiring a live Redis server.
- **Outbox Relay Lifecycle:** The `OutboxRelay` background daemon should be started in `apps/api-gateway` and worker processes, or run as a standalone worker process depending on deployment preference.
- **Migration Sequence:** Ensure `V004__outbox.sql` is executed after `V002__ledger.sql` since it references `append_ledger()`.

---

## 4. Conclusion

- **Sprint 6.2:** Fully scoped. Requires modifications in `packages/event-bus/src/index.ts` (`RedisStreamsBus.poll()`), creation of `tools/replay-event.ts`, and Vitest tests in `packages/event-bus/test/event-bus.test.ts`.
- **Sprint 6.5:** Fully scoped. Requires creation of `infra/migrations/postgres/V004__outbox.sql`, implementation of `OutboxRelay` in `packages/event-bus/src/outbox-relay.ts`, extension of `LedgerClient` in `packages/ledger-client/src/index.ts`, and wiring in `apps/api-gateway/src/server.ts`.
- Complete step-by-step implementation guide and code snippets are documented in `analysis_sprint6_2.md`.

---

## 5. Verification Method

1. **Sprint 6.2 Verification:**
   - File: `packages/event-bus/test/event-bus.test.ts`
   - Action: Run `npm test` or `npx vitest run packages/event-bus`.
   - Expected Result: A failing subscriber handler is called exactly 3 times (with backoff), forwards the payload to `*.dlq`, and `tools/replay-event.ts` successfully moves the message back to the active topic.

2. **Sprint 6.5 Verification:**
   - File: `infra/migrations/postgres/V004__outbox.sql` & `packages/event-bus/src/outbox-relay.ts`
   - Action: Execute `npx tsx tools/migrate.ts`, call `appendWithOutbox()`, and run `outboxRelay.pump()`.
   - Expected Result: `merkle_ledger` row and `outbox` row are created atomically; `outboxRelay.pump()` publishes event to Redis and updates `sent_at = now()`.

3. **Artifact Verification:**
   - Inspect generated analysis file: `C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint6_2\analysis_sprint6_2.md`.
