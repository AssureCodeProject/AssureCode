# Test Suite Architecture & Infrastructure (`TEST_INFRA.md`)

## 1. Overview & Objectives
This document defines the End-to-End (E2E) testing architecture and automated verification runner for the **AssureCode (Trust-Code 2.0)** frontend upgrade (`apps/web`).

The test infrastructure is designed as an opaque-box verification suite (`scripts/verify-web.js`) that validates four critical quality tiers:
1. **Tier 1 (Build Pipeline Validation)**: Verifies `npm run build:web` compilation, exit code, and production bundle artifacts.
2. **Tier 2 (Pure JS/JSX Compliance)**: Asserts zero `.ts` or `.tsx` files in `apps/web/src`, and verifies index/import clean references without TypeScript artifacts.
3. **Tier 3 (Component Structure & Mobile Responsiveness)**: Audits component existence, export signatures, and mobile responsiveness (375px viewport adaptation, mobile navigation drawer).
4. **Tier 4 (Real-World Scenarios & State Persistence)**: Validates full 4-phase core navigation routing (`contract`, `verification`, `xai`, `escrow`), shared state management, state persistence, and mock data interface contracts.

---

## 2. Test Architecture Tiers

### Tier 1: Build Pipeline & Artifact Verification
- **Command**: `npm run build:web` (invokes Vite build inside `apps/web`).
- **Verifications**:
  - Process execution exit code is `0`.
  - Directory `apps/web/dist` is generated.
  - Production `dist/index.html` exists and is valid.
  - Bundled JS and CSS assets exist in `apps/web/dist/assets`.

### Tier 2: Pure JS/JSX Compliance Audit
- **Requirement R1**: No TypeScript files allowed in `apps/web/src`.
- **Verifications**:
  - Recursive search of `apps/web/src` returns **0** `.ts` or `.tsx` files.
  - `apps/web/index.html` references pure JavaScript/JSX entry point (`src/main.jsx`).
  - No `.jsx` or `.js` file contains static import paths referencing `.ts` or `.tsx` extensions.

### Tier 3: Component Structure & Mobile Responsiveness
- **Core Phase Components**:
  - `Phase 1`: `apps/web/src/components/ContractInitialization.jsx`
  - `Phase 2`: `apps/web/src/components/VerificationDashboard.jsx`
  - `Phase 3`: `apps/web/src/components/XaiTrustScoreView.jsx` (XAI Trust Score View)
  - `Phase 4`: `apps/web/src/components/EscrowSettlementView.jsx` (Escrow & Settlement View)
- **UI Primitives**:
  - `GlassCard.jsx`, `StatusBadge.jsx`, `FuturisticButton.jsx`, `RadialGauge.jsx`, `MobileDrawer.jsx`, `ToastNotification.jsx`.
- **Mobile Responsiveness (375px target)**:
  - `MobileDrawer.jsx` handles responsive mobile navigation with animations/overlays.
  - `App.jsx` incorporates mobile layout breakpoints (`md:`, `lg:`, `sm:`, `hidden`, `block`) and mobile drawer toggle state.

### Tier 4: Real-World Scenarios & State Persistence
- **4-Phase Navigation Flow**:
  - Validates active tab routing across all 4 phases: `'contract'`, `'verification'`, `'xai'`, `'escrow'`.
- **Shared State & Persistence**:
  - Validates shared `contractData` state structure accessible across all phase views.
  - Validates state persistence mechanism (e.g. `localStorage` backup/restore or state retention across tab switches).
- **Mock Data Contracts**:
  - `mockXaiData.js`: Score gauge metrics, category breakdowns, RAG ScopeGuard signals, explainability audit trail.
  - `mockEscrowData.js`: Vault overview, milestone statuses, 5-oracle signals, Merkle ledger tree structure.

---

## 3. Automated Test Runner (`scripts/verify-web.js`)
The verification runner is located at `scripts/verify-web.js`. It runs natively using Node.js without requiring external test framework setups.

### Features:
- Self-contained static analysis and dynamic build execution.
- Clear console reporting with colorized pass/fail checkmarks.
- Detailed failure reporting pointing directly to non-compliant files or missing contract definitions.
- Deterministic process exit code (`0` for total pass, `1` for any failure).

---

## 4. Execution Commands
To run the full E2E verification test suite:

```bash
node scripts/verify-web.js
```

Or execute build pipeline directly:

```bash
npm run build:web
```

---

## 5. Defect Escalation & QA Protocols
If any tier fails during execution:
1. `scripts/verify-web.js` outputs `[FAIL]` with the specific missing file, syntax error, or compliance violation.
2. The QA agent records the failure in `handoff.md` and escalates implementation defects to the implementing subagents (e.g., `worker_m1`, `worker_m2`, `worker_m3`).
3. Implementation agents apply targeted fixes to `apps/web/src` without breaking pure JSX rules.
4. The test suite is re-executed until all 4 tiers pass with `exit code 0`.
