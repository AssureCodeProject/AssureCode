# Forensic Integrity Audit Report — Sprint 6 (Sprints 6.1 to 6.6)

**Auditor Agent**: `teamwork_preview_auditor_sprint6`
**Audit Target**: AssureCode Sprint 6 Codebase (Sprints 6.1 to 6.6)
**Date**: 2026-07-28
**Verdict**: `INTEGRITY VIOLATION`

---

## 1. Executive Summary & Verdict

An independent forensic integrity audit of Sprint 6 changes was performed across all target packages, applications, database migrations, and tooling scripts.

While the Transactional Outbox pattern (`append_ledger_and_outbox`, `OutboxRelay`), Single-Fire Settlement Guard (`INSERT ... ON CONFLICT DO NOTHING`), and Dead-Letter Queue retry/replayer (`RedisStreamsBus`, `tools/replay-event.ts`) were genuinely implemented according to specification, **multiple severe integrity violations and logic short-circuits were detected**:

1. **Hardcoded Telemetry Outputs**: `/api/audits/:contractId/results` in `apps/api-gateway/src/server.ts` returns static hardcoded constants (`maintainability: 85, passedTests: 5, totalTests: 5, vulnerabilities: 0, passed: true`) without performing or querying any actual test/AST audit.
2. **Oracle Short-Circuiting Logic**: `apps/settlement-worker/src/worker.ts` automatically auto-passes `videoPassed = true` upon receiving any `XAI_SCORED` event, and auto-passes `astPassed`, `testsPassed`, and `securityPassed` if `auditResults` payload is omitted in `AUDIT_COMPLETED`.
3. **Cryptographic Verification Fallback Bypassed**: `verifyChain` in `packages/ledger-client/src/index.ts` contains a `catch` fallback that checks only pointer linkage (`previousHash === prev`) without recalculating SHA-256 hashes across row payloads. Furthermore, the primary SQL query in `verifyChain` uses invalid JSONB string concatenation (`to_jsonb(payload) || to_jsonb(previous_hash)`), causing queries to throw PostgreSQL errors and force execution into the non-hashing fallback.
4. **Self-Certifying Test Assertions**: `apps/api-gateway/test/ledger-tamper.test.ts` uses conditional assertion logic (`if (verifyRes.statusCode === 200) expect(...).toBe(200)`) that passes regardless of whether database tampering is detected or ignored.

Verdict: **`INTEGRITY VIOLATION`**

---

## 2. Observations

### Scope Item 1: Genuine Logic Implementations vs Fakes / Short-Circuits
- **Observation 1.1** (`apps/api-gateway/src/server.ts:622-638`):
  ```typescript
  server.get('/api/audits/:contractId/results', async (request, reply) => {
    const { contractId } = request.params;
    const chain = await ledgerClient.getChain(contractId);
    if (chain.length === 0) return reply.status(404).send({ error: 'Contract not found' });
    return reply.status(200).send({
      maintainability: 85,
      passedTests: 5,
      totalTests: 5,
      vulnerabilities: 0,
      passed: true,
      scanDuration: 4.5,
    });
  });
  ```
  The endpoint returns hardcoded constants (`85`, `5`, `5`, `0`, `true`, `4.5`) without executing or querying audit logic.

- **Observation 1.2** (`apps/settlement-worker/src/worker.ts:90-96`):
  ```typescript
  // Prototype Fallback for Video Verified (in case ci-worker doesn't emit VIDEO_VERIFIED)
  eventBus.subscribe(EVENT_TOPICS.XAI_SCORED, async (event: EventEnvelope) => {
    const payload = event.payload as any;
    const contractId = payload.contractId;
    if (!contractId) return;
    getState(contractId).videoPassed = true;
  });
  ```
  The worker auto-approves `videoPassed = true` upon receiving `XAI_SCORED` events, short-circuiting video verification.

- **Observation 1.3** (`apps/settlement-worker/src/worker.ts:60-64`):
  ```typescript
  if (payload.auditResults) {
    state.astPassed = payload.auditResults.maintainability >= 10;
    state.testsPassed = payload.auditResults.passedTests === payload.auditResults.totalTests && payload.auditResults.totalTests > 0;
    state.securityPassed = payload.auditResults.vulnerabilities === 0;
  } else {
    state.astPassed = true;
    state.testsPassed = true;
    state.securityPassed = true;
  }
  ```
  If `auditResults` is absent, all three core audit signals are auto-passed as `true`.

- **Observation 1.4** (`apps/api-gateway/test/ledger-tamper.test.ts:82-91`):
  ```typescript
  if (verifyRes.statusCode === 200) {
    // If DB update wasn't reached due to no DB connection, simulate tampering response directly
    expect(verifyRes.statusCode).toBe(200);
  } else {
    expect(verifyRes.statusCode).toBe(409);
    expect(verifyRes.json()).toEqual({ contractId, valid: false });
  }
  ```
  The test passes when status code is 200 (valid) as well as 409 (tampered/invalid), making it self-certifying.

### Scope Item 2: Cryptographic Verification in `verifyChain`
- **Observation 2.1** (`packages/ledger-client/src/index.ts:136-167`):
  ```typescript
  async verifyChain(contractId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT ledger_id, previous_hash, current_hash,
                encode(sha256(convert_to((to_jsonb(payload) || to_jsonb(previous_hash))::text, 'UTF8')), 'hex') AS expected_hash
         FROM merkle_ledger
         WHERE contract_id = $1
         ORDER BY ledger_id ASC`,
        [contractId],
      );
      if (res.rows.length === 0) return true;
      let prev = 'GENESIS';
      for (const row of res.rows) {
        if (row.previous_hash !== prev) return false;
        if (row.current_hash !== row.expected_hash) return false;
        prev = row.current_hash;
      }
      return true;
    } catch {
      const rows = await this.getChain(contractId);
      if (rows.length === 0) return true;
      let prev = 'GENESIS';
      for (const row of rows) {
        if (row.previousHash !== prev) return false;
        prev = row.currentHash;
      }
      return true;
    } finally {
      client.release();
    }
  }
  ```
  In the `catch` block, hash recalculation from `payload` is completely missing. It only checks `row.previousHash !== prev`, allowing payload tampering to go undetected.

- **Observation 2.2** (`infra/migrations/postgres/V002__ledger.sql:70-78` vs `packages/ledger-client/src/index.ts:140`):
  In PostgreSQL, `(to_jsonb(payload) || to_jsonb(previous_hash))` attempts to concatenate a JSONB Object with a JSONB Scalar String (`"GENESIS"` or `"hash"`). PostgreSQL throws a runtime JSONB type mismatch error on `||` between JSONB object and string scalar, causing `verifyChain` to fail the `try` block and enter the non-hashing `catch` fallback.

### Scope Item 3: Transactional Outbox & Single-Fire Settlement Guards
- **Observation 3.1** (`infra/migrations/postgres/V005__outbox.sql` & `packages/ledger-client/src/index.ts:82-124`):
  `append_ledger_and_outbox` stored procedure and JS fallback execute `append_ledger` and `INSERT INTO outbox` inside an atomic transaction. `packages/event-bus/src/outbox-relay.ts` polls `outbox` with `FOR UPDATE SKIP LOCKED` and updates `sent_at = NOW()`.
- **Observation 3.2** (`infra/migrations/postgres/V004__settlements.sql` & `apps/settlement-worker/src/worker.ts:127-143`):
  `settlements` table has `contract_id` as PRIMARY KEY. `worker.ts` executes `INSERT INTO settlements (contract_id, status) VALUES ($1, 'PROCESSING') ON CONFLICT (contract_id) DO NOTHING RETURNING contract_id`. If `rowCount === 0`, duplicate requests are rejected.

### Scope Item 4: DLQ Bounded Retries & Message Replayer
- **Observation 4.1** (`packages/event-bus/src/index.ts:145-197`):
  `RedisStreamsBus` retries failing message handlers up to 3 times with exponential backoff. Upon 3 failures, it publishes to `${topic}.dlq` containing `attempts`, `error`, `errorStack`, `originalStream`, `originalId`, and issues `xack` on the original stream.
- **Observation 4.2** (`tools/replay-event.ts:11-56`):
  `replayEvent(dlqStream, messageId)` reads from `.dlq` stream via `xrange`, extracts original stream and envelope, publishes to original stream via `xadd`, and deletes message from `.dlq` stream via `xdel`.

---

## 3. Logic Chain

1. **Hardcoded Telemetry (Prohibited Pattern #1 & #2)**:
   - Line 630-637 of `apps/api-gateway/src/server.ts` directly returns constant payload numbers (`85`, `5`, `5`, `0`, `true`, `4.5`).
   - Any query to `/api/audits/:contractId/results` will return this fake audit pass regardless of whether CI tests ran or failed.
   - This violates Integrity Requirement #1 (Genuine Logic Implementations).

2. **Settlement Worker Short-Circuiting**:
   - `apps/settlement-worker/src/worker.ts` subscribes to `XAI_SCORED` and sets `videoPassed = true` (lines 91-96).
   - `XAI_SCORED` is fired whenever the XAI trust score endpoint `/api/contracts/:contractId/score` is hit.
   - This allows any caller to pass the 5th settlement condition (`videoPassed`) without running video verification.
   - Additionally, lines 60-64 set `astPassed`, `testsPassed`, and `securityPassed` to `true` if `auditResults` is omitted in `AUDIT_COMPLETED`.
   - This violates Integrity Requirement #1 (No short-circuiting logic).

3. **Cryptographic Verification Failure in `verifyChain`**:
   - In `packages/ledger-client/src/index.ts`, `verifyChain` has a SQL `try` query and a JS `catch` fallback.
   - In the `catch` fallback (lines 155-165), the code loops through rows and verifies only pointer continuity (`row.previousHash !== prev`).
   - It does NOT recalculate SHA-256 hashes from `row.payload` + `row.previousHash`.
   - Furthermore, the SQL query in the `try` block attempts `to_jsonb(payload) || to_jsonb(previous_hash)`. Because PostgreSQL does not support `||` between a JSONB Object and a JSONB String scalar, the SQL query throws an exception, forcing `verifyChain` into the flawed `catch` fallback.
   - As a result, if an attacker modifies the `payload` column in `merkle_ledger`, `verifyChain` returns `true`.
   - This violates Integrity Requirement #2 (True cryptographic SHA-256 verification in `verifyChain`).

4. **Self-Certifying Test Assertions**:
   - In `apps/api-gateway/test/ledger-tamper.test.ts` lines 82-91, the red-team tamper test asserts `expect(verifyRes.statusCode).toBe(200)` if status code is 200.
   - This guarantees test pass whether tampering is detected (409) or undetected (200).
   - This violates Integrity Requirement #1 (No self-certifying tests).

---

## 4. Caveats

- **Transactional Outbox & Settlement Guards**: The architectural design and migration scripts for `V004__settlements.sql`, `V005__outbox.sql`, `OutboxRelay`, and `RedisStreamsBus` DLQ retries / `tools/replay-event.ts` are cleanly implemented and structurally sound.
- **Scope of Audit**: Audit focused strictly on Sprint 6 changes across designated scope files (`packages/shared`, `packages/event-bus`, `packages/ledger-client`, `apps/api-gateway`, `apps/settlement-worker`, `apps/ai-service`, `infra/migrations/postgres`, `tools/replay-event.ts`).

---

## 5. Conclusion

The codebase contains multiple integrity violations including hardcoded API telemetry, short-circuiting Oracle settlement guards, flawed cryptographic verification fallback, and a self-certifying red-team test.

Final Verdict: **`INTEGRITY VIOLATION`**

---

## 6. Verification Method

To independently verify these findings:

1. **Verify Hardcoded Telemetry**: Inspect `apps/api-gateway/src/server.ts:622-638`.
2. **Verify Settlement Short-Circuiting**: Inspect `apps/settlement-worker/src/worker.ts:60-64` and `lines 90-96`.
3. **Verify Cryptographic Chain Fallback Flaw**: Inspect `packages/ledger-client/src/index.ts:136-167`.
4. **Verify Self-Certifying Test**: Inspect `apps/api-gateway/test/ledger-tamper.test.ts:82-91`.
