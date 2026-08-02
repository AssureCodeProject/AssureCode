# Handoff Report: Empirical Challenge & Stress-Test of Sprint 6 Remediation

**Author**: Empirical Challenger (`teamwork_preview_challenger_sprint6_remediation`)  
**Target Project**: AssureCode  
**Working Directory**: `C:\Users\hp\AssureCode\.agents\teamwork_preview_challenger_sprint6_remediation`  
**Date**: 2026-07-28  
**Final Verdict**: **FAIL**

---

## 1. Observation

Direct code inspection and empirical stress testing of the remediated Sprint 6 implementation revealed critical defects in Concurrency/Idempotency and Merkle Chain Verification:

### Observation 1: Idempotency Schema Constraint Violation & Test Query Bug
- **Location**: `apps/api-gateway/src/middleware/idempotency.ts`, Lines 31–37:
  ```ts
  const reserveRes = await pool.query(
    `INSERT INTO idempotency_keys (key, contract_id, response_json, status_code, expires_at)
     VALUES ($1, NULL, NULL, 0, NOW() + INTERVAL '24 hours')
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [trimmedKey],
  );
  ```
- **Location**: `infra/migrations/postgres/V003__idempotency.sql`, Line 8:
  ```sql
  response_json JSONB NOT NULL,
  ```
  `idempotency.ts` passes `NULL` as the parameter for `response_json` during atomic reservation. However, `V003__idempotency.sql` defines `response_json` as `JSONB NOT NULL`. When PostgreSQL executes this query, it throws error `23502` (`null value in column "response_json" violates not-null constraint`).
- **Location**: `apps/api-gateway/test/idempotency-concurrency.test.ts`, Line 54:
  ```ts
  const res = await pool.query(
    "SELECT COUNT(*) FROM ledger WHERE contract_id = $1 AND action_type = 'CONTRACT_LOCKED'",
    [contractId]
  );
  ```
  The test queries a non-existent table named `ledger` instead of `merkle_ledger`, causing the test DB query to fail and enter the fallback catch block.

### Observation 2: Merkle Hash Calculation Discrepancy (False Positive Tamper Detections)
- **Location**: `packages/ledger-client/src/index.ts`, Lines 29–32:
  ```ts
  function calculateSha256(payload: Record<string, unknown>, previousHash: string): string {
    const serialized = JSON.stringify(payload) + previousHash;
    return createHash('sha256').update(serialized, 'utf8').digest('hex');
  }
  ```
- **Location**: `infra/migrations/postgres/V002__ledger.sql`, Lines 70–78:
  ```sql
  v_current_hash := encode(
      sha256(
          convert_to(
              (SELECT to_jsonb(p_payload) || to_jsonb(v_previous_hash))::text,
              'UTF8'
          )
      ),
      'hex'
  );
  ```
  PostgreSQL calculates the tail hash using JSONB concatenation `(to_jsonb(p_payload) || to_jsonb(v_previous_hash))::text`, whereas Node.js `verifyChain` calculates the expected hash using `JSON.stringify(payload) + previousHash`. The two string representations are mathematically different. As a result, `verifyChain` re-computes an expected hash that never matches the stored `current_hash`, causing `GET /api/contracts/:contractId/verify` to report `valid: false` (HTTP 409 Conflict) for **all valid, untampered contracts**.

### Observation 3: Settlement Guard Abort Verification
- **Location**: `apps/settlement-worker/src/worker.ts`, Lines 122–140:
  ```ts
  let guardRes;
  try {
    guardRes = await dbPool.query(
      `INSERT INTO settlements (contract_id, status)
       VALUES ($1, 'PROCESSING')
       ON CONFLICT (contract_id) DO NOTHING
       RETURNING contract_id`,
      [contractId]
    );
  } catch (dbErr) {
    logger.error({ contractId, dbErr }, 'Settlements guard table query failed');
  }

  if (!guardRes || guardRes.rowCount !== 1) {
    logger.warn(
      { contractId, rowCount: guardRes?.rowCount },
      'Settlement request rejected: Failed to acquire DB lock or settlement already in progress',
    );
    return;
  }
  ```
  Under DB error (`guardRes` is `undefined`) or lock contention (`guardRes.rowCount === 0`), `if (!guardRes || guardRes.rowCount !== 1)` returns early and successfully aborts processing before `escrowAdapter.transferToFreelancer` is invoked.

---

## 2. Logic Chain

1. **Idempotency Concurrency Failure**:
   - The worker attempted to implement atomic reservation in `withIdempotency` by inserting an initial row with `status_code = 0`.
   - However, the worker passed `NULL` for `response_json`. Because `V003__idempotency.sql` strictly specifies `response_json JSONB NOT NULL`, Postgres rejects the `INSERT` with a NOT NULL constraint violation.
   - The exception causes `withIdempotency` to bypass the `reserveRes.rowCount === 1` block and enter the 50-attempt polling loop. Since no row was inserted, polling fails, returning HTTP 409 Conflict for all concurrent requests and preventing the primary handler from executing.

2. **Merkle Verification False Positives**:
   - `verifyChain` in `packages/ledger-client/src/index.ts` attempts to verify hash integrity by re-computing SHA-256 in Node.js.
   - Node.js computes `SHA256(JSON.stringify(payload) + previousHash)`.
   - PostgreSQL `append_ledger` stored procedure computes `SHA256((to_jsonb(payload) || to_jsonb(previous_hash))::text)`.
   - Because PostgreSQL's JSONB concatenation output differs from Node's string concatenation, the hashes diverge on row #1. Node.js `verifyChain` flags all valid chains as corrupted, returning HTTP 409 `{ contractId, valid: false }` for both tampered AND untampered contracts.

3. **Settlement Guard Correctness**:
   - On DB failure during settlement reservation, `dbPool.query` throws an exception, leaving `guardRes` undefined.
   - On lock contention (duplicate concurrent settlement), `ON CONFLICT DO NOTHING` causes Postgres to return 0 rows (`rowCount = 0`).
   - The guard condition `!guardRes || guardRes.rowCount !== 1` evaluates to `true` in both failure cases, halting execution prior to calling Stripe `transferToFreelancer`.

---

## 3. Caveats

- In environments running PostgreSQL without the `append_ledger` stored procedure loaded, `appendWithOutbox` falls back to its JS transaction retry mechanism.
- If Stripe payout succeeds but the subsequent DB transaction (`UPDATE settlements SET status = 'COMPLETED'`) fails, external funds have been moved while DB reflects a failed state.

---

## 4. Conclusion

**Final Verdict: FAIL**

While the Settlement Guard (#3) correctly aborts execution prior to Stripe payout on DB errors or lock contention, the Sprint 6 Remediation fails on Challenge #1 and Challenge #2:
- **Idempotency Concurrency**: Reservation fails at the database level due to a `NOT NULL` schema mismatch on `response_json`.
- **Merkle Verification**: Inconsistent hashing algorithms between PostgreSQL and Node.js cause false positives, returning HTTP 409 Conflict even for valid untampered contracts.

---

## 5. Verification Method

To verify these findings independently:

1. **Idempotency Constraint Check**:
   - Inspect `infra/migrations/postgres/V003__idempotency.sql` line 8 (`response_json JSONB NOT NULL`).
   - Inspect `apps/api-gateway/src/middleware/idempotency.ts` line 32 (`VALUES ($1, NULL, NULL, 0, ...)`).
   - Confirm inserting `NULL` for `response_json` violates the SQL constraint.
   - Inspect `apps/api-gateway/test/idempotency-concurrency.test.ts` line 54 and confirm `FROM ledger` should be `FROM merkle_ledger`.

2. **Merkle Hash Discrepancy Check**:
   - Compare `packages/ledger-client/src/index.ts` lines 29-32 (`JSON.stringify(payload) + previousHash`) against `infra/migrations/postgres/V002__ledger.sql` lines 70-78 (`(to_jsonb(p_payload) || to_jsonb(v_previous_hash))::text`).
   - Confirm that string concatenation in Node does not produce the same string as JSONB concatenation in Postgres.

3. **Settlement Guard Check**:
   - Inspect `apps/settlement-worker/src/worker.ts` lines 122-140 and confirm `if (!guardRes || guardRes.rowCount !== 1) return;` prevents payout execution when `dbPool.query` fails or returns 0 rows.
