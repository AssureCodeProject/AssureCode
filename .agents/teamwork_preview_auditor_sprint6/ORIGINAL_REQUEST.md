## 2026-07-28T13:21:51Z
You are teamwork_preview_auditor_sprint6. Your working directory is `C:\Users\hp\AssureCode\.agents\teamwork_preview_auditor_sprint6`.

Your task is to perform an independent forensic integrity audit of all Sprint 6 changes (Sprints 6.1 to 6.6).

Audit Scope:
- `packages/shared/src/index.ts`
- `packages/event-bus/src/index.ts` & `src/outbox-relay.ts`
- `packages/ledger-client/src/index.ts`
- `apps/api-gateway/src/server.ts` & `src/middleware/idempotency.ts`
- `apps/settlement-worker/src/worker.ts`
- `apps/ai-service` (LLM 503 & S3 local fallback)
- `infra/migrations/postgres` (`V003` - `V006`)
- `tools/replay-event.ts`

Integrity Checks:
1. Verify genuine logic implementations (no fake mocks, no hardcoded outputs, no short-circuiting logic).
2. Verify true cryptographic verification in `verifyChain` (SHA-256 hash recalculation across Merkle ledger rows).
3. Verify true transactional outbox and single-fire settlement guards (`INSERT ... ON CONFLICT DO NOTHING`).
4. Verify dead-letter stream retry counter and message replayer.

Deliver an unambiguous binary audit verdict: `CLEAN` or `INTEGRITY VIOLATION`. Include detailed evidence for every finding. Send report via send_message to parent.
