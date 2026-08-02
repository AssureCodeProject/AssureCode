# Technical Analysis & Remediation Strategy — Milestone M1 Fix (Iteration 2)

**Author**: Explorer Subagent (`explorer_m1_fix`)  
**Target Project**: `C:\Users\hp\AssureCode`  
**Target Workspace**: `apps/web`  
**Date**: 2026-07-28  

---

## 1. Executive Summary & Audit Reconciliation

### 1.1 Root Cause Summary
In Milestone M1 (Iteration 1), Worker 1 implemented pure `.js` and `.jsx` component files (`App.jsx`, `main.jsx`, `ContractInitialization.jsx`, `VerificationDashboard.jsx`, `components/ui/*.jsx`, `types/*.js`, `vite.config.js`). However, Worker 1 created 2-to-3 line proxy `.ts` and `.tsx` files that re-exported from the new JavaScript implementations instead of deleting the TypeScript files.

Because 16 `.ts`/`.tsx` files remained in `apps/web/src` and `vite.config.ts` remained in `apps/web`, Auditor 1 (`m1_auditor_1`) correctly issued an **INTEGRITY VIOLATION** verdict.

### 1.2 Verification Goal
To achieve 100% compliance with `ORIGINAL_REQUEST.md` (§R1 & Acceptance Criteria) and `PROJECT.md`, the `apps/web/src` directory must contain **zero** `.ts` or `.tsx` files, `apps/web/vite.config.ts` must be deleted, and `node scripts/verify-web.js` must pass with exit code 0.

---

## 2. Inventory & Inspection of Lingering TypeScript Artifacts

We conducted a line-by-line inspection of all 17 lingering TypeScript files (`16` in `apps/web/src` + `1` root config in `apps/web`).

| # | Lingering TS/TSX Path | Content Inspection Summary | Counterpart JS/JSX File | Counterpart Status |
|---|-----------------------|----------------------------|-------------------------|--------------------|
| 1 | `apps/web/src/App.tsx` | 3 lines: Re-exports `App.jsx` (`export { default } from './App.jsx'`) | `apps/web/src/App.jsx` | Fully implemented (170 lines) |
| 2 | `apps/web/src/main.tsx` | 2 lines: Imports `main.jsx` (`import './main.jsx';`) | `apps/web/src/main.jsx` | Fully implemented (16 lines) |
| 3 | `apps/web/src/components/ContractInitialization.tsx` | 3 lines: Re-exports `ContractInitialization.jsx` | `apps/web/src/components/ContractInitialization.jsx` | Fully implemented (540 lines) |
| 4 | `apps/web/src/components/VerificationDashboard.tsx` | 3 lines: Re-exports `VerificationDashboard.jsx` | `apps/web/src/components/VerificationDashboard.jsx` | Fully implemented (604 lines) |
| 5 | `apps/web/src/components/ui/FuturisticButton.tsx` | 3 lines: Re-exports `FuturisticButton.jsx` | `apps/web/src/components/ui/FuturisticButton.jsx` | Fully implemented (87 lines) |
| 6 | `apps/web/src/components/ui/GlassCard.tsx` | 3 lines: Re-exports `GlassCard.jsx` | `apps/web/src/components/ui/GlassCard.jsx` | Fully implemented (111 lines) |
| 7 | `apps/web/src/components/ui/MobileDrawer.tsx` | 3 lines: Re-exports `MobileDrawer.jsx` | `apps/web/src/components/ui/MobileDrawer.jsx` | Fully implemented (114 lines) |
| 8 | `apps/web/src/components/ui/RadialGauge.tsx` | 3 lines: Re-exports `RadialGauge.jsx` | `apps/web/src/components/ui/RadialGauge.jsx` | Fully implemented (126 lines) |
| 9 | `apps/web/src/components/ui/StatusBadge.tsx` | 3 lines: Re-exports `StatusBadge.jsx` | `apps/web/src/components/ui/StatusBadge.jsx` | Fully implemented (107 lines) |
| 10 | `apps/web/src/components/ui/ToastNotification.tsx` | 3 lines: Re-exports `ToastNotification.jsx` | `apps/web/src/components/ui/ToastNotification.jsx` | Fully implemented (128 lines) |
| 11 | `apps/web/src/components/ui/index.ts` | 2 lines: Re-exports `index.js` (`export * from './index.js'`) | `apps/web/src/components/ui/index.js` | Fully implemented (7 lines) |
| 12 | `apps/web/src/types/contract.ts` | 2 lines: Re-exports `contract.js` | `apps/web/src/types/contract.js` | Fully implemented (8 lines) |
| 13 | `apps/web/src/types/escrow.ts` | 2 lines: Re-exports `escrow.js` | `apps/web/src/types/escrow.js` | Fully implemented (24 lines) |
| 14 | `apps/web/src/types/index.ts` | 2 lines: Re-exports `index.js` | `apps/web/src/types/index.js` | Fully implemented (5 lines) |
| 15 | `apps/web/src/types/telemetry.ts` | 2 lines: Re-exports `telemetry.js` | `apps/web/src/types/telemetry.js` | Fully implemented (14 lines) |
| 16 | `apps/web/src/types/xai.ts` | 2 lines: Re-exports `xai.js` | `apps/web/src/types/xai.js` | Fully implemented (7 lines) |
| 17 | `apps/web/vite.config.ts` | 2 lines: Re-exports `vite.config.js` (`export { default } from './vite.config.js'`) | `apps/web/vite.config.js` | Fully implemented (34 lines) |

### Key Finding:
Every single `.ts` / `.tsx` file is purely a shell proxy. Deleting all 17 files will cause **zero** loss of functionality or code.

---

## 3. Configuration & Script Analysis

### 3.1 `apps/web/index.html`
- Currently line 21: `<script type="module" src="/src/main.jsx"></script>`
- Verdict: **Already compliant**. No changes required for `index.html`.

### 3.2 `apps/web/vite.config.js`
- Standard ES module Vite configuration exporting `defineConfig(...)` with `@vitejs/plugin-react` and `@` alias mapped to `src`.
- Verdict: **Already compliant**. `vite.config.ts` can be deleted safely without breaking Vite.

### 3.3 `apps/web/package.json`
- Line 9: `"typecheck": "tsc --noEmit"`
- Analysis: When all `.ts`/`.tsx` files are deleted from `apps/web/src`, running `npm run typecheck` across workspaces will invoke `tsc` in `apps/web`. `tsc` will report `error TS18003: No inputs were found in config file...` unless `"typecheck"` script in `apps/web/package.json` is updated or `tsconfig.json` is updated.
- Remediation: Update `apps/web/package.json` script `"typecheck"` to `"echo 'Pure JS workspace (no TypeScript)'"`.

### 3.4 `apps/web/tsconfig.json`
- Line 28: `"include": ["src/**/*", "vite.config.ts"]`
- Analysis: Since `vite.config.ts` will be deleted, `vite.config.ts` must be removed from `tsconfig.json` if `tsconfig.json` is kept, or `tsconfig.json` can be updated to include `"allowJs": true` or updated to `"include": ["src/**/*.js", "src/**/*.jsx"]`.

### 3.5 `scripts/verify-web.js` Behavior
- Tier 1: Executes `npm run build:web` (`vite build`).
- Tier 2: Scans `apps/web/src` for files ending in `.ts` or `.tsx`. FAILS if count > 0. Checks `index.html` for `.ts`/`.tsx` references. Checks `.js`/`.jsx` files for `.ts`/`.tsx` imports.
- Tier 3 & 4: Checks required `.jsx` component exports, responsive hooks, navigation tabs, and mock data.

Purging all 17 `.ts`/`.tsx` files will immediately allow Tier 2 of `node scripts/verify-web.js` to PASS.

---

## 4. Remediation Strategy for Worker 2

Worker 2 must execute the following 3-step action plan:

### Step 1: File Deletion (Purge Lingering TypeScript Artifacts)
Purge the following 17 files from `C:\Users\hp\AssureCode`:

```powershell
# 1. Delete root config TS file
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\vite.config.ts" -Force

# 2. Delete root src TS/TSX files
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\App.tsx" -Force
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\main.tsx" -Force

# 3. Delete component TSX files
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\components\ContractInitialization.tsx" -Force
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\components\VerificationDashboard.tsx" -Force

# 4. Delete UI primitive TS/TSX files
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\components\ui\FuturisticButton.tsx" -Force
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\components\ui\GlassCard.tsx" -Force
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\components\ui\MobileDrawer.tsx" -Force
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\components\ui\RadialGauge.tsx" -Force
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\components\ui\StatusBadge.tsx" -Force
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\components\ui\ToastNotification.tsx" -Force
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\components\ui\index.ts" -Force

# 5. Delete domain type TS files
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\types\contract.ts" -Force
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\types\escrow.ts" -Force
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\types\index.ts" -Force
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\types\telemetry.ts" -Force
Remove-Item -Path "C:\Users\hp\AssureCode\apps\web\src\types\xai.ts" -Force
```

### Step 2: Package Script & Config Cleanup

1. Update `apps/web/package.json`:
   Change:
   ```json
   "typecheck": "tsc --noEmit"
   ```
   To:
   ```json
   "typecheck": "echo \"Pure JS workspace (no TypeScript)\""
   ```

2. Update `apps/web/tsconfig.json`:
   Remove `"vite.config.ts"` from `"include"`, so line 28 becomes:
   ```json
   "include": ["src/**/*"]
   ```

### Step 3: Verification Execution

Execute the verification scripts from the project root (`C:\Users\hp\AssureCode`):

1. Run verification script:
   ```bash
   node scripts/verify-web.js
   ```
   Expected output:
   `Tier 2: Pure JS/JSX Compliance` -> **PASSED** (0 `.ts`/`.tsx` files found in `apps/web/src`).

2. Run build verification:
   ```bash
   npm run build:web
   ```
   Expected output: Build succeeds with exit code 0 and populates `apps/web/dist`.

---

## 5. Verification Matrix & Invalidation Criteria

| Criteria | Verification Command | Expected Clean Result | Invalidation Condition |
|----------|----------------------|-----------------------|------------------------|
| Zero TS files in `apps/web/src` | `Get-ChildItem -Path "apps/web/src" -Recurse -Include *.ts, *.tsx` | 0 items returned | >0 files returned |
| Zero TS root config | `Test-Path "apps/web/vite.config.ts"` | `False` | `True` |
| Web Verification Runner | `node scripts/verify-web.js` | Tier 2 PASSED (Exit code 0) | Tier 2 FAILED (Exit code 1) |
| Web Vite Build | `npm run build:web` | Build succeeds, exit code 0 | Build error |
