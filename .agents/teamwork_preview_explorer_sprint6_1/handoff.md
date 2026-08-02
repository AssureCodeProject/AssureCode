# Handoff Report: Sprint 6.1 & Sprint 6.3 Investigation

## 1. Observation

- **`packages/shared/src/index.ts`** (Lines 40–153): Contains contract DTOs, event envelope schemas, and settlement event types (`SettlementRequestedSchema`, `SettlementCompletedSchema`). Does not contain any `IdempotencyKey` or header validation schema.
- **`infra/migrations/postgres/`**: Contains `V001__init.sql` (core tables + `vector` extension) and `V002__ledger.sql` (`merkle_ledger` table and `append_ledger` function). No migration files for idempotency keys (`V003__idempotency.sql`) or settlements guard table (`V004__settlements.sql`) exist.
- **`tools/migrate.ts`** (Lines 61–87): Reads all `.sql` files from `infra/migrations/postgres/`, sorts them lexicographically by filename, and applies any file not listed in `_migrations`.
- **`apps/api-gateway/src/server.ts`**:
  - `POST /api/contracts/initialize` (Lines 98–124)
  - `POST /api/contracts/:contractId/generate-tests` (Lines 135–213)
  - `POST /api/contracts/:contractId/lock` (Lines 215–266)
  - `POST /api/contracts/:contractId/escrow` (Lines 268–306)
  - `POST /api/contracts/:contractId/settle` (Lines 308–339)
  - None of these 5 mutating endpoints check for `Idempotency-Key` or `x-idempotency-key` headers or query a database cache for replayed requests.
- **`apps/settlement-worker/src/worker.ts`**:
  - `eventBus.subscribe(EVENT_TOPICS.SETTLEMENT_REQUESTED, ...)` (Lines 97–162): Evaluates in-memory 5-signal oracle state (`astPassed`, `testsPassed`, `securityPassed`, `scopePassed`, `videoPassed`).
  - Upon approval, calls `escrowAdapter.transferToFreelancer(...)` directly (Lines 127–131) before calling `ledgerClient.append(contractId, 'INVOICE', ...)` (Line 140).
  - Does not query or lock a `settlements` database guard table. Multiple concurrent `SETTLEMENT_REQUESTED` events will cause duplicate Stripe transfers.

---

## 2. Logic Chain

1. **Observed**: Mutating gateway endpoints directly execute business logic, external AI service calls, Stripe payment intent creations, and Merkle ledger appends on every HTTP request without checking for an idempotency key.
   - **Reasoning**: Without a persistent idempotency table and Fastify middleware/wrapper checking incoming `Idempotency-Key` headers, replayed network requests (e.g. retries after network timeouts) result in duplicate database entries, duplicate ledger hashes, and duplicate external API calls.
   - **Target Fix**: Implement `IdempotencyKeyHeaderSchema` in `@assurecode/shared`, create migration `V003__idempotency.sql` (`idempotency_keys` table), and wrap mutating gateway endpoints with a response caching lookup in `apps/api-gateway/src/server.ts`.

2. **Observed**: `settlement-worker` receives `SETTLEMENT_REQUESTED` events and executes `escrowAdapter.transferToFreelancer` before any database locking occurs.
   - **Reasoning**: If 5 concurrent `SETTLEMENT_REQUESTED` events are received, all 5 pass the oracle check in parallel and invoke `transferToFreelancer`, executing 5 separate Stripe payouts for the same contract.
   - **Target Fix**: Create migration `V004__settlements.sql` (`settlements` guard table with `contract_id` PRIMARY KEY). In `settlement-worker`, execute `INSERT INTO settlements (contract_id, status) VALUES ($1, 'PROCESSING') ON CONFLICT (contract_id) DO NOTHING RETURNING contract_id`. If 0 rows return, abort settlement processing immediately.

3. **Observed**: `settlement-worker` appends `INVOICE` to `merkle_ledger` outside of a database transaction linked to the settlement record.
   - **Reasoning**: If a process crash occurs between Stripe transfer and ledger append, the transfer is executed but the ledger chain lacks the `INVOICE` entry.
   - **Target Fix**: Bind the ledger append and the `settlements` status update (`UPDATE settlements SET status = 'COMPLETED', transfer_id = $1`) inside a single PostgreSQL transaction (`BEGIN ... COMMIT`).

---

## 3. Caveats

- **Network Mode Constraints**: The analysis was conducted in `CODE_ONLY` mode. External internet connectivity and live Stripe API credentials were not tested; all Stripe operations were evaluated against `@assurecode/stripe-adapter` (using `FakeEscrowAdapter` fallback when `STRIPE_SECRET_KEY` is not present).
- **Concurrency Scope**: While `ON CONFLICT DO NOTHING` guarantees single-row insertion in PostgreSQL for concurrent worker threads/instances, in-memory oracle state (`oracleStore = new Map()`) is local to a single worker process instance. In a multi-replica settlement worker setup, event propagation relies on Redis event bus.

---

## 4. Conclusion

The current codebase does not meet the requirements for Sprint 6.1 (Idempotency keys end-to-end) or Sprint 6.3 (Provably single-fire settlement). Implementer action is required to:
1. Create `V003__idempotency.sql` and `V004__settlements.sql` in `infra/migrations/postgres/`.
2. Add `IdempotencyKeyHeaderSchema` to `packages/shared/src/index.ts`.
3. Wrap mutating endpoints in `apps/api-gateway/src/server.ts` with idempotency caching.
4. Refactor `apps/settlement-worker/src/worker.ts` to use `INSERT INTO settlements ... ON CONFLICT DO NOTHING` and transactional ledger appends.

A detailed implementation report has been written to `analysis_sprint6_1.md` in this directory.

---

## 5. Verification Method

To independently verify the findings and the future implementation:

1. **Migration Verification**:
   - Command: `npm run migrate`
   - Inspection: Check that `V003__idempotency.sql` and `V004__settlements.sql` are applied and present in PostgreSQL `_migrations` table.

2. **Sprint 6.1 Idempotency Verification**:
   - Command: `npx vitest run apps/api-gateway`
   - Manual Test:
     ```bash
     # Call lock twice with same Idempotency-Key
     curl -X POST http://localhost:4000/api/contracts/AC-TEST-1/lock \
       -H "Content-Type: application/json" \
       -H "Idempotency-Key: idempotency-test-key-1" \
       -d '{"title":"Test","requirements":"Reqs","budgetCents":10000,"deadline":"2026-12-31"}'
     ```
   - Invalidation Condition: If calling the endpoint a second time with the same header returns a new hash or appends a second row to `merkle_ledger`, idempotency is broken.

3. **Sprint 6.3 Single-Fire Settlement Verification**:
   - Command: `npx vitest run apps/settlement-worker`
   - Inspection: Query database table `settlements` after publishing 5 identical `SETTLEMENT_REQUESTED` events.
   - Invalidation Condition: `SELECT count(*) FROM settlements WHERE contract_id = 'AC-TEST-1'` must equal 1, and `SELECT count(*) FROM merkle_ledger WHERE contract_id = 'AC-TEST-1' AND action_type = 'INVOICE'` must equal 1.
