## 2026-07-29T15:21:47Z
You are teamwork_preview_explorer_sprint7_3.
Your working directory is: C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint7_3

Objective:
Trace and document the complete 5-Signal Settlement process across the entire codebase (apps/ and packages/).

5 Signals to trace:
1. AST Signal (Abstract Syntax Tree / code quality / linting / structure)
2. Tests Signal (Test coverage / pass rate / unit & integration results)
3. Security Signal (Vulnerability scan / dependency audit / security checks)
4. Scope Signal (PR/commit diff scope vs task requirements / scope compliance)
5. Video Signal (Screen recording / AI verification of demo / video analysis)

Tasks:
1. Locate where each of the 5 signals is computed, ingested, verified, or published.
2. Trace the step-by-step lifecycle from initial trigger (PR event / Webhook Ingest / CI Worker / API call), through signal generation, AI Service evaluation, aggregation in Settlement Worker, ledger entry creation, and final Stripe payout / escrow release.
3. Identify event names, payload structures, thresholds, formulas/weights, and state transitions for all 5 signals.
4. Write a comprehensive, highly detailed handoff report in your working directory at `C:\Users\hp\AssureCode\.agents\teamwork_preview_explorer_sprint7_3\handoff.md`.
5. Include exact file paths, line numbers, function names, event names, and data flow steps.
6. Notify the orchestrator via send_message when complete.
