## 2026-07-29T20:56:32Z
<USER_REQUEST>
You are teamwork_preview_worker_sprint7.
Your working directory is: C:\Users\hp\AssureCode\.agents\teamwork_preview_worker_sprint7

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Objective:
Read the 3 Explorer handoff reports and synthesize a comprehensive, production-grade architectural overview document saved to:
`C:\Users\hp\AssureCode\architecture_overview.md`

Input Sources to Read (via view_file):
1. `C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint7_1\handoff.md` (Apps microservices)
2. `C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint7_2\handoff.md` (Packages shared libraries)
3. `C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint7_3\handoff.md` (5-Signal Settlement Data Flow)

Document Content Requirements (`C:\Users\hp\AssureCode\architecture_overview.md`):
- High-level system overview & architectural topology.
- Mermaid.js diagram showing high-level system architecture (web, api-gateway, webhook-ingest, ci-worker, settlement-worker, ai-service, EventBus, Postgres/pgvector, Redis, Stripe, S3, Neo4j).
- Explicit, detailed breakdown of all 5 microservices under `apps/`:
  - `api-gateway`
  - `ci-worker`
  - `settlement-worker`
  - `webhook-ingest`
  - `ai-service`
  - Explaining their responsibilities, routes/handlers, event consumers/producers, and how they interact via Kafka/Redis EventBus.
- Explicit, detailed breakdown of all shared packages under `packages/`:
  - `packages/event-bus` (EventBus interface, RedisStreamsBus consumer groups & DLQ, KafkaBus, OutboxRelay daemon with FOR UPDATE SKIP LOCKED)
  - `packages/ledger-client` (Postgres stored procedure `append_ledger`, `append_ledger_and_outbox`, SHA-256 Merkle chain recalculation & integrity verification `verifyChain`)
  - `packages/stripe-adapter` (Hexagonal `EscrowPort`, 2-phase payment intents, Stripe webhooks, `FakeEscrowAdapter`)
  - `packages/shared` (17 domain event topics in `EVENT_TOPICS`, Zod schemas for all DTOs and envelopes)
  - `packages/config` & `packages/telemetry` (Zod config, Pino logging with AsyncLocalStorage correlation, OpenTelemetry, Prometheus metrics)
- Detailed data flow for the core workflows, focusing on the 5-Signal Settlement process (AST, Tests, Security, Scope, Video). Explain each signal's generation, evaluation, aggregation, and threshold/weighting logic.
- Mermaid.js diagram mapping out the 5-signal settlement process from initial webhook/PR trigger to final ledger invoice entry and Stripe escrow capture/payout.
- Ledger integrity guarantees, single-fire settlement lock (`settlements` table ON CONFLICT DO NOTHING), and Stripe payment intent capture/cancel escrow flow.

Make sure the file `C:\Users\hp\AssureCode\architecture_overview.md` is thoroughly written, well-formatted markdown, highly detailed, precise with exact file paths, event names, and code structures.

When completed, write a handoff report to `C:\Users\hp\AssureCode\.agents\teamwork_preview_worker_sprint7\handoff.md` and notify the orchestrator via send_message.
</USER_REQUEST>
