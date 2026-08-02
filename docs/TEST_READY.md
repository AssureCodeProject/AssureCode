# Test Suite Ready & Verification Guide (`TEST_READY.md`)

## Verification Test Suite Status: READY

The automated opaque-box E2E verification test runner (`scripts/verify-web.js`) has been designed, implemented, and prepared for validating the AssureCode frontend upgrade.

---

## 1. Summary of Test Tiers

| Tier | Name | Target Verification | Verification Method | Status |
|------|------|--------------------|---------------------|--------|
| **Tier 1** | Build Pipeline Validation | `npm run build:web` execution, exit code 0, `dist/index.html` & asset generation | `child_process.execSync` + file audit | Configured |
| **Tier 2** | Pure JS/JSX Compliance | Zero `.ts`/`.tsx` files in `apps/web/src`, no TypeScript imports, pure `main.jsx` entry | Directory AST/walk audit | Configured |
| **Tier 3** | Component & Responsive Audit | Phase 1, Phase 2, Phase 3 (XAI), Phase 4 (Escrow) components, UI primitives, 375px mobile drawer navigation | Static analysis & export inspection | Configured |
| **Tier 4** | Scenarios & State Persistence | 4-Phase routing (`contract`, `verification`, `xai`, `escrow`), shared state management, state persistence, mock data contracts | Interface & routing contract audit | Configured |

---

## 2. Execution Command

To run the full multi-tier verification suite, execute the following command from the repository root:

```bash
node scripts/verify-web.js
```

To run individual build pipeline checks directly:

```bash
npm run build:web
```

---

## 3. Test Suite Architecture Document
For full details on the test architecture, tier breakdowns, and defect escalation protocols, see:
- `TEST_INFRA.md` (`C:\Users\hp\AssureCode\TEST_INFRA.md`)
- Verification Runner Source: `scripts/verify-web.js` (`C:\Users\hp\AssureCode\scripts\verify-web.js`)
