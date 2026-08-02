## 2026-07-28T13:21:51Z
You are teamwork_preview_challenger_sprint6_2. Your working directory is `C:\Users\hp\AssureCode\.agents\teamwork_preview_challenger_sprint6_2`.

Your task is to empirically stress-test and challenge Sprint 6.2 (DLQ retries/replay), Sprint 6.4 (Tamper test), Sprint 6.5 (Outbox recovery), and Sprint 6.6 (503 AI fallback).

Test Scenarios:
1. Inject a failing event handler -> verify poison event lands in `.dlq` stream after 3 attempts with failure metadata. Run `tools/replay-event.ts` to replay event.
2. Direct SQL modification of `merkle_ledger.current_hash` -> call `GET /api/contracts/:id/verify` -> assert HTTP 409 `{ valid: false }`.
3. Simulate `ai-service` 503 -> verify Gateway returns HTTP 202 Accepted `{ jobId, status: 'queued', retryAfter: 5 }` and `GET /api/jobs/:jobId` polls job status correctly.

Run empirical tests, capture logs, and report your findings and final verdict (PASS/FAIL) via send_message to parent.
