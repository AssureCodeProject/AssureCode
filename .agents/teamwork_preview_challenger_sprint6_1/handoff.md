# Handoff Report — Sprint 6.1 & Sprint 6.3 Concurrency Challenge

## 1. Observation

### Implementation Code Inspected:
- **`apps/api-gateway/src/middleware/idempotency.ts` (Lines 15-56)**:
  ```ts
  export async function withIdempotency<T>(
    pool: pg.Pool,
    request: FastifyRequest,
    reply: FastifyReply,
    handler: () => Promise<IdempotencyHandlerResult<T>>,
  ): Promise<FastifyReply> {
    const key = (request.headers['idempotency-key'] || request.headers['x-idempotency-key']) as string | undefined;

    if (key && typeof key === 'string' && key.trim().length > 0) {
      const trimmedKey = key.trim();
      try {
        const cached = await pool.query(
          'SELECT response_json, status_code FROM idempotency_keys WHERE key = $1 AND expires_at > NOW()',
          [trimmedKey],
        );
        if (cached.rowCount && cached.rowCount > 0) {
          const row = cached.rows[0];
          return reply.status(row.status_code).send(row.response_json);
        }
      } catch (err) {
        request.log?.warn?.({ key: trimmedKey, err }, 'Idempotency lookup error');
      }

      const result = await handler();

      try {
        await pool.query(
          `INSERT INTO idempotency_keys (key, contract_id, response_json, status_code, expires_at)
           VALUES ($1, $2, $3::jsonb, $4, NOW() + INTERVAL '24 hours')
           ON CONFLICT (key) DO NOTHING`,
          [trimmedKey, result.contractId || null, JSON.stringify(result.body), result.statusCode],
        );
      } catch (err) {
        request.log?.warn?.({ key: trimmedKey, err }, 'Idempotency storage error');
      }

      return reply.status(result.statusCode).send(result.body);
    }
  ...
  ```

- **`apps/api-gateway/src/server.ts` (Lines 282-337 for `/lock`, 389-423 for `/settle`)**:
  Both mutating endpoints wrap their logic with `withIdempotency(dbPool, request, reply, async () => { ... })`. Inside `/lock`, `ledgerClient.appendWithOutbox` is executed. Inside `/settle`, `eventBus.publish(EVENT_TOPICS.SETTLEMENT_REQUESTED, ...)` is executed.

- **`apps/settlement-worker/src/worker.ts` (Lines 127-143)**:
  ```ts
  guardRes = await dbPool.query(
    `INSERT INTO settlements (contract_id, status)
     VALUES ($1, 'PROCESSING')
     ON CONFLICT (contract_id) DO NOTHING
     RETURNING contract_id`,
    [contractId]
  );

  if (guardRes && guardRes.rowCount === 0) {
    logger.warn({ contractId }, 'Settlement request ignored: Contract settlement already executed or in progress');
    return;
  }
  ```

### Created Test Suites:
- `apps/api-gateway/test/idempotency-concurrency.test.ts`
- `apps/settlement-worker/test/settlement-concurrency.test.ts`

---

## 2. Logic Chain

### Scenario 1 Trace: Replay 5 concurrent HTTP requests with exact same `x-idempotency-key`
1. Step 1: 5 concurrent requests hit Fastify server with identical `x-idempotency-key`.
2. Step 2: All 5 requests simultaneously execute `SELECT response_json, status_code FROM idempotency_keys WHERE key = $1 ...` (Lines 26-29 of `idempotency.ts`).
3. Step 3: Because none of the 5 requests has written to `idempotency_keys` yet, all 5 `SELECT` queries return 0 rows (`cached.rowCount === 0`).
4. Step 4: All 5 requests proceed to call `const result = await handler()` (Line 38 of `idempotency.ts`).
5. Step 5: For `/lock`, each of the 5 handler calls executes `ledgerClient.appendWithOutbox(...)` (`server.ts`: Line 288), resulting in **5 distinct database entries appended to the `ledger` table** for the same contract.
6. Step 6: All 5 requests complete `handler()` and attempt `INSERT INTO idempotency_keys ... ON CONFLICT (key) DO NOTHING`. Only 1 insert succeeds in `idempotency_keys`, but 5 duplicate ledger entries have already been created in the database.
7. Step 7: **Conclusion for Scenario 1**: **FAIL**. The idempotency middleware is vulnerable to a Time-of-Check to Time-of-Use (TOCTOU) race condition, failing the requirement of creating exactly 1 unique ledger entry.

### Scenario 2 Trace: Trigger 5 concurrent `/settle` requests for a single contract
1. Step 1: 5 concurrent settlement tasks trigger `SETTLEMENT_REQUESTED` handling in `settlement-worker/src/worker.ts`.
2. Step 2: All 5 tasks execute `INSERT INTO settlements (contract_id, status) VALUES ($1, 'PROCESSING') ON CONFLICT (contract_id) DO NOTHING RETURNING contract_id`.
3. Step 3: PostgreSQL evaluates the `PRIMARY KEY (contract_id)` constraint on `settlements`. Exactly **1** insert succeeds (`rowCount = 1`). The other **4** concurrent inserts hit `ON CONFLICT DO NOTHING` (`rowCount = 0`).
4. Step 4: The 4 tasks with `rowCount === 0` hit `if (guardRes && guardRes.rowCount === 0) return;` and terminate immediately without triggering Stripe transfers or ledger entries.
5. Step 5: The 1 task with `rowCount === 1` executes `escrowAdapter.transferToFreelancer(...)` and appends `INVOICE` to the ledger.
6. Step 6: **Conclusion for Scenario 2**: **PASS**. The `settlements` primary key guard table successfully prevents double-payouts under concurrency.

---

## 3. Caveats
- Offline unit testing without a live running PostgreSQL cluster simulates DB row constraints via in-memory mock primitives matching exact PostgreSQL SQL semantics (`ON CONFLICT DO NOTHING`).
- Network partition or database crash between `escrowAdapter.transferToFreelancer()` and `dbPool.query('UPDATE settlements ... SET status = COMPLETED')` could require manual settlement status recovery, though double payout remains prevented by the initial `PROCESSING` state insertion.

---

## 4. Conclusion & Final Verdict

**FINAL VERDICT**: **FAIL**

### Summary of Results:
1. **Scenario 1 (Idempotency Concurrency on Gateway Endpoints `/lock`, `/settle`)**: **FAIL**
   - Reason: `withIdempotency` middleware performs a non-atomic `SELECT` followed by `handler()` execution. Under concurrency, 5 identical requests pass the `SELECT` check and execute `handler()`, producing 5 duplicate ledger entries in PostgreSQL instead of 1 unique entry.
   - Recommended Fix: Implement PostgreSQL advisory locking (`pg_advisory_xact_lock`) or an atomic in-flight reservation table (`INSERT INTO idempotency_keys (key, status) VALUES ($1, 'PROCESSING') ON CONFLICT DO NOTHING`) before invoking `handler()`.

2. **Scenario 2 (Single-Fire Settlement Guard Table)**: **PASS**
   - Reason: `settlements` primary key guard table with `INSERT INTO settlements ... ON CONFLICT (contract_id) DO NOTHING RETURNING contract_id` guarantees atomic row lock in PostgreSQL. Only 1 execution proceeds to payout; 4 concurrent executions return 0 rows and abort, preventing double-payouts in Stripe/ledger.

---

## 5. Verification Method

To independently verify these empirical results:

1. Inspect test files:
   - `apps/api-gateway/test/idempotency-concurrency.test.ts`
   - `apps/settlement-worker/test/settlement-concurrency.test.ts`

2. Run tests via vitest:
   - `npx vitest run apps/api-gateway/test/idempotency-concurrency.test.ts`
   - `npx vitest run apps/settlement-worker/test/settlement-concurrency.test.ts`

3. Code Inspection Points:
   - Check `apps/api-gateway/src/middleware/idempotency.ts` lines 26-38: Observe non-atomic `SELECT` check before `handler()` execution.
   - Check `apps/settlement-worker/src/worker.ts` lines 128-143: Observe atomic `INSERT INTO settlements ... ON CONFLICT (contract_id) DO NOTHING` check.
