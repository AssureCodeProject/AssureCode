## 2026-07-28T15:57:30Z
You are worker_m1 (teamwork_preview_worker).
Your working directory is C:\Users\hp\AssureCode\.agents\worker_m1. Create your directory if needed.

Read:
- User requirements: C:\Users\hp\AssureCode\.agents\ORIGINAL_REQUEST.md
- Project Scope: C:\Users\hp\AssureCode\PROJECT.md
- Explorer M1 Reports:
  - C:\Users\hp\AssureCode\.agents\explorer_m1_1\handoff.md
  - C:\Users\hp\AssureCode\.agents\explorer_m1_2\handoff.md
  - C:\Users\hp\AssureCode\.agents\explorer_m1_3\handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Task for Milestone 1 (Codebase Modernization & TS Setup):
Implement the complete TypeScript migration, configuration, type definitions, UI primitives, and component refactoring in `apps/web`:

1. **Config & Package Setup**:
   - Create `apps/web/tsconfig.json` extending `../../tsconfig.base.json` with React JSX ("react-jsx"), bundler module resolution, noEmit: true, strict type checking, and target ES2022.
   - Add `"typecheck": "tsc --noEmit"` to `scripts` in `apps/web/package.json`.
   - Rename `apps/web/vite.config.js` -> `apps/web/vite.config.ts`.
   - Update `apps/web/index.html` line 21 script src from `/src/main.jsx` to `/src/main.tsx`.

2. **TypeScript Domain Types (`apps/web/src/types/`)**:
   - `contract.ts`: `ContractData`, `ContractFormState`, `ContractInitResponse`, `LockResponse`.
   - `telemetry.ts`: `AuditTelemetry`, `PipelineStepConfig`, `MetricStatus`, `AuditStreamEvent`.
   - `xai.ts`: `XAITrustScoreData`, `XaiScoreWeight`, `XaiTelemetryComponents`, `ScopeGuardAnalysis`.
   - `escrow.ts`: `EscrowSettlementState`, `OracleSignals`, `MerkleLedgerEntry`, `LedgerIntegrityStatus`.
   - `index.ts`: Re-export all types.

3. **Reusable UI Primitives (`apps/web/src/components/ui/`)**:
   - `GlassCard.tsx`: Glassmorphic container with theme variants, glow options, scan overlay, top accent bar, and sub-components.
   - `StatusBadge.tsx`: Badges with status color themes, pulsing indicator dot, monospace font support, click-to-copy hash capability.
   - `FuturisticButton.tsx`: Animated button with hover glow gradients, spinning loader, icon slot, tap scale feedback.
   - `RadialGauge.tsx`: Circular SVG progress gauge for Trust Score visualizer with stroke calculations, dropshadow glow, auto-threshold colors.
   - `ToastNotification.tsx`: Toast system with `ToastProvider` context and `useToast` hook.
   - `MobileDrawer.tsx`: Slide-in drawer with backdrop blur, scroll lock, keyboard escape listener, Framer Motion animations.
   - `index.ts`: Re-export all UI components.

4. **Component Refactoring (.jsx -> .tsx)**:
   - `src/main.jsx` -> `src/main.tsx` (typed root mount).
   - `src/App.jsx` -> `src/App.tsx` (typed phase switching, nav bar, status footer).
   - `src/components/ContractInitialization.jsx` -> `src/components/ContractInitialization.tsx` (typed form inputs, API lock flow, Merkle hash display with copy button).
   - `src/components/VerificationDashboard.jsx` -> `src/components/VerificationDashboard.tsx` (typed WebSocket listener, pipeline stepper, telemetry cards).

5. **Verification**:
   - Run `npx tsc --noEmit` inside `apps/web` (or `npm run typecheck`).
   - Run `npm run build:web` from project root (or `npm run build` in `apps/web`).
   - Confirm 0 errors.

Write your handoff report containing build & typecheck results to `C:\Users\hp\AssureCode\.agents\worker_m1\handoff.md` and send a message back to parent when done.
