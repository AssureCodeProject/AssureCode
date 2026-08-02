## 2026-07-28T18:02:15Z
<USER_REQUEST>
You are the Primary Implementation Worker for Milestones M1, M2, and M3 of AssureCode Frontend Upgrade.
Your metadata directory is: `C:\Users\hp\AssureCode\.agents\m1_m2_m3_worker`
Target project root: `C:\Users\hp\AssureCode`
Web app root: `C:\Users\hp\AssureCode\apps\web`

Requirements to read: `C:\Users\hp\AssureCode\.agents\ORIGINAL_REQUEST.md` and `C:\Users\hp\AssureCode\PROJECT.md`.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Tasks:

1. **Physical File Purge (M1)**:
   - Run `node scripts/delete-ts.js` using `run_command` (Cwd: `C:\Users\hp\AssureCode`, WaitMsBeforeAsync: 8000) or run Node inline file deletion script to delete all 17 `.ts`/`.tsx` files from `apps/web/src` and `apps/web/vite.config.ts`.
   - Verify on disk that `Get-ChildItem -Path apps/web/src -Recurse -Include *.ts,*.tsx` returns ZERO files.

2. **Responsive UI/UX Overhaul (M2)**:
   - Update `apps/web/src/App.jsx`:
     - Add 4-phase tab router (`'contract'`, `'verification'`, `'xai'`, `'escrow'`).
     - Make topbar responsive down to 375px mobile viewport: add mobile hamburger button and integrate `MobileDrawer.jsx` for screens under 768px (`md:hidden`).
     - On mobile screens (375px), ensure no horizontal scrollbars or overflowing elements occur (`max-w-full overflow-x-hidden`, responsive padding `p-4 sm:p-8`).

3. **Missing Dashboard Views (M3)**:
   - Create `apps/web/src/data/mockXaiData.js` and `apps/web/src/data/mockEscrowData.js` with rich, realistic telemetry data.
   - Create `apps/web/src/components/XaiTrustScoreView.jsx` (Phase 3):
     - Interactive XAI Trust Score evaluation view.
     - 0-100 radial score gauge (e.g. Score 92/100, Grade A+), recommendation status pill (`APPROVE_SETTLEMENT`), category weight breakdown (AST Security, ScopeGuard, Merkle Proof, AI OWASP), RAG ScopeGuard semantic boundary metrics, feature importance chart, and explainability audit trail.
   - Create `apps/web/src/components/EscrowSettlementView.jsx` (Phase 4):
     - Escrow & Settlement status view.
     - Vault status overview ($5,000 locked), milestone payment breakdown, 5-oracle verification signals matrix (CI/CD, OWASP, AST, ScopeGuard, Merkle), interactive Merkle block ledger viewer, dispute drawer toggle, and single-fire fund release control button.
   - Integrate both new views into `App.jsx` routing.
   - Ensure ALL new files are pure JavaScript/JSX (`.jsx`/`.js`) with ZERO TypeScript syntax (`type`, `interface`, type annotations).

4. **Verification**:
   - Run `node scripts/verify-web.js` using `run_command` (Cwd: `C:\Users\hp\AssureCode`, WaitMsBeforeAsync: 8000).
   - Run `npm run build:web` using `run_command` (Cwd: `C:\Users\hp\AssureCode`, WaitMsBeforeAsync: 8000).
   - Confirm all 4 Tiers of `verify-web.js` pass cleanly with exit code 0.

5. **Reporting**:
   - Write `changes.md` and `handoff.md` in `C:\Users\hp\AssureCode\.agents\m1_m2_m3_worker`.
   - Send a message to parent when done referencing `handoff.md`.
</USER_REQUEST>
