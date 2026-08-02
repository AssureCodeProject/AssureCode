## 2026-07-28T17:45:46Z
You are Worker subagent 3 for Milestone M1 (Pure JS Conversion - Iteration 3 File Deletion).
Your metadata directory is: `C:\Users\hp\AssureCode\.agents\m1_worker_3`
Target project root: `C:\Users\hp\AssureCode`
Web app root: `C:\Users\hp\AssureCode\apps\web`

Requirements to read:
1. `C:\Users\hp\AssureCode\.agents\ORIGINAL_REQUEST.md`
2. `C:\Users\hp\AssureCode\PROJECT.md`
3. `C:\Users\hp\AssureCode\.agents\m1_auditor_2\handoff.md` (AUDITOR EVIDENCE REPORT)

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Task:
1. DO NOT use runtime prebuild hooks to delete files at build time. Perform PHYSICAL DELETION of all 16 `.ts`/`.tsx` files in `apps/web/src` and `apps/web/vite.config.ts` right now during your execution.
   Execute a script using `run_command` (e.g., `node -e "const fs=require('fs'); ['apps/web/vite.config.ts', 'apps/web/src/App.tsx', 'apps/web/src/main.tsx', 'apps/web/src/components/ContractInitialization.tsx', 'apps/web/src/components/VerificationDashboard.tsx', 'apps/web/src/components/ui/FuturisticButton.tsx', 'apps/web/src/components/ui/GlassCard.tsx', 'apps/web/src/components/ui/MobileDrawer.tsx', 'apps/web/src/components/ui/RadialGauge.tsx', 'apps/web/src/components/ui/StatusBadge.tsx', 'apps/web/src/components/ui/ToastNotification.tsx', 'apps/web/src/components/ui/index.ts', 'apps/web/src/types/contract.ts', 'apps/web/src/types/escrow.ts', 'apps/web/src/types/index.ts', 'apps/web/src/types/telemetry.ts', 'apps/web/src/types/xai.ts'].forEach(f => fs.existsSync(f) && fs.unlinkSync(f));"`) or PowerShell `Remove-Item`.
2. Remove any `scripts/clean-ts.js` file and remove any `"prebuild"` scripts added to `apps/web/package.json` or root `package.json`.
3. Verify on disk that `Get-ChildItem -Path apps/web/src -Recurse -Include *.ts,*.tsx` returns ZERO files.
4. Run `node scripts/verify-web.js` and `npm run build:web` from project root `C:\Users\hp\AssureCode` and confirm both succeed cleanly.
5. Write `changes.md` and `handoff.md` in `C:\Users\hp\AssureCode\.agents\m1_worker_3`.
6. Send a message to parent when done.
