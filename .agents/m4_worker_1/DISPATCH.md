## 2026-07-29T00:52:08Z
<USER_REQUEST>
You are Worker subagent 1 for Milestone M4 (Final Integration & Verification Execution).
Your metadata directory is: `C:\Users\hp\AssureCode\.agents\m4_worker_1`
Target project root: `C:\Users\hp\AssureCode`
Web app root: `C:\Users\hp\AssureCode\apps\web`

Requirements to read: `C:\Users\hp\AssureCode\.agents\ORIGINAL_REQUEST.md` and `C:\Users\hp\AssureCode\PROJECT.md`.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Tasks:
1. Run `node scripts/delete-ts.js` using `run_command` (Cwd: `C:\Users\hp\AssureCode`, WaitMsBeforeAsync: 8000) or run Node file unlinking script to ensure all 17 `.ts`/`.tsx` files (`App.tsx`, `main.tsx`, components `.tsx`, UI primitives `.tsx`, types `.ts`, `vite.config.ts`) are physically deleted from disk.
2. Verify using `find_by_name` or `Get-ChildItem` that 0 `.ts` or `.tsx` files exist in `apps/web/src` or `apps/web/vite.config.ts`.
3. Run `node scripts/verify-web.js` using `run_command` (Cwd: `C:\Users\hp\AssureCode`, WaitMsBeforeAsync: 8000).
4. Run `npm run build:web` using `run_command` (Cwd: `C:\Users\hp\AssureCode`, WaitMsBeforeAsync: 8000).
5. Document all output logs, exit codes, and verification status in `changes.md` and `handoff.md` in `C:\Users\hp\AssureCode\.agents\m4_worker_1`.
6. Send a message to parent when done referencing `handoff.md`.
</USER_REQUEST>
