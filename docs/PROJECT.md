# Project: AssureCode (Trust-Code 2.0) Frontend Upgrade

## Architecture
- React 18 SPA built with Vite (`@assurecode/web`).
- Pure JavaScript and JSX (`.jsx` / `.js` only — zero `.ts` or `.tsx` files in `apps/web/src`).
- Tailwind CSS v3.4 + PostCSS + Framer Motion + Lucide React icons for futuristic dark-theme UI/UX.
- Mobile-first responsive layout down to 375px viewport width (adaptive topbar, mobile drawer, responsive padding).
- 4-Phase Core Navigation:
  - Phase 1: Contract Initialization (`ContractInitialization.jsx`)
  - Phase 2: Verification Dashboard (`VerificationDashboard.jsx`)
  - Phase 3: XAI Trust Score Evaluation (`XaiTrustScoreView.jsx`)
  - Phase 4: Escrow & Settlement Status (`EscrowSettlementView.jsx`)

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | R1: Pure JS Conversion | Convert all `.ts`/`.tsx` files in `apps/web/src` to pure `.jsx`/`.js`, update `index.html` and `vite.config.js` | M1 | ORIGINAL_REQUEST §R1 |
| 2 | R2: UI/UX & Responsive Layout | Refactor layout, topbar nav, container paddings, mobile drawer for 375px mobile viewport, micro-animations | M2 | ORIGINAL_REQUEST §R2 |
| 3 | R3.1: XAI Trust Score View | Build `XaiTrustScoreView.jsx` with radial score gauge, category weights, RAG ScopeGuard, explainability audit trail | M3 | ORIGINAL_REQUEST §R3 |
| 4 | R3.2: Escrow & Settlement View | Build `EscrowSettlementView.jsx` with vault overview, milestone payment status, 5-oracle signals, Merkle ledger viewer, dispute drawer, release controls | M3 | ORIGINAL_REQUEST §R3 |
| 5 | Routing & Nav Integration | Update `App.jsx` with 4-phase tab navigation, mobile drawer toggle, active view router | M3 | ORIGINAL_REQUEST §R3 |
| 6 | Technical Criteria Verification | Verify `npm run build:web` succeeds without errors, 0 `.ts`/`.tsx` files in `apps/web/src`, 375px responsive check | M4 | ORIGINAL_REQUEST §Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Pure JS Conversion & Clean Baseline | Convert all `.ts`/`.tsx` files in `apps/web/src` to pure `.jsx`/`.js`, update imports, `index.html` & `vite.config.js` | none | DONE |
| M2 | Responsive UI/UX & Layout Foundation | Overhaul navigation, responsive padding, mobile drawer integration, theme primitives | M1 | DONE |
| M3 | Dashboard Views (XAI & Escrow) | Implement `XaiTrustScoreView.jsx`, `EscrowSettlementView.jsx`, integrate 4-phase router in `App.jsx` | M1, M2 | DONE |
| M4 | E2E Testing & Final Hardening | Build verification (`npm run build:web`), non-cheating audit, 375px mobile viewport validation | M1, M2, M3 | DONE |

## Interface Contracts
### Navigation & View State Contract (`App.jsx`)
- State `activeTab`: `'contract'` | `'verification'` | `'xai'` | `'escrow'`
- State `contractData`: Shared contract info between Phase 1, Phase 2, Phase 3, and Phase 4.
- UI Primitives (`GlassCard`, `StatusBadge`, `FuturisticButton`, `RadialGauge`, `MobileDrawer`, `ToastNotification`): Exported as Pure JSX React functional components.

## Code Layout
`apps/web/src/`
├── `main.jsx`
├── `App.jsx`
├── `index.css`
├── `components/`
│   ├── `ContractInitialization.jsx`
│   ├── `VerificationDashboard.jsx`
│   ├── `XaiTrustScoreView.jsx`
│   └── `EscrowSettlementView.jsx`
├── `components/ui/`
│   ├── `FuturisticButton.jsx`
│   ├── `GlassCard.jsx`
│   ├── `MobileDrawer.jsx`
│   ├── `RadialGauge.jsx`
│   ├── `StatusBadge.jsx`
│   └── `ToastNotification.jsx`
└── `data/`
    ├── `mockXaiData.js`
    └── `mockEscrowData.js`
