# AssureCode Frontend Architecture & Feature Gap Analysis

**Project**: AssureCode (Trust-Code 2.0) — Zero-Trust Freelance Ecosystem  
**Target Root**: `C:\Users\hp\AssureCode`  
**Web App Root**: `C:\Users\hp\AssureCode\apps\web`  
**Explorer Agent**: `explorer_survey_2`  
**Date**: 2026-07-28  

---

## 1. Executive Summary

This comprehensive analysis surveys the current state of the AssureCode frontend application in `apps/web/src`, evaluates compliance with core requirements (including plain JavaScript/JSX enforcement and 375px responsiveness), and provides detailed specifications for building the missing **XAI Trust Score Evaluation** and **Escrow / Settlement Status** dashboard views.

### Key Discoveries:
1. **TypeScript Violations**: The repository currently contains mixed TypeScript (`.ts`/`.tsx`) and JavaScript (`.jsx`) files in `apps/web/src`. The entry points (`main.jsx`, `App.jsx`, `ContractInitialization.jsx`, `VerificationDashboard.jsx`) currently act as re-export shims pointing to `.tsx` implementations. Requirement **R1** and Acceptance Criterion **#2** strictly prohibit `.ts` or `.tsx` files in `apps/web/src`. All components must be migrated to pure `.js` / `.jsx`.
2. **Existing Dashboard Views**:
   - **Phase 1 — Contract Initialization**: Form for defining title, requirements, budget, deadline, triggering contract initialization, generating hidden tests, and displaying locked SHA-256 Merkle hash chain records.
   - **Phase 2 — Zero-Trust CI/CD Verification**: Real-time pipeline execution (Kafka event, Docker sandbox, AST complexity, AI OWASP auditor) with live WebSocket streaming / mock fallback and telemetry results cards.
3. **Missing Dashboard Views To Implement**:
   - **Phase 3 — XAI Trust Score Evaluation**: Interactive evaluation view showing overall trust score, letter grade (A+ to F), recommendation badge (`APPROVE_SETTLEMENT`, `MANUAL_REVIEW`, `REJECT_SETTLEMENT`), category feature weights, RAG ScopeGuard semantic analysis, and explainability audit trail with confidence meters.
   - **Phase 4 — Escrow & Settlement Status**: Financial vault view tracking escrow lock/release status, milestone payment allocations, 5-oracle verification signals matrix, interactive Merkle hash ledger audit history, dispute initiation/resolution workflow, and automated settlement release controls.

---

## 2. Codebase Survey & Existing Architecture

### 2.1 File & Directory Map (`apps/web/src`)

```
apps/web/src/
├── App.jsx                        # Re-export shim for App.tsx
├── App.tsx                        # Main dashboard container & tab navigation (Phase 1 & Phase 2)
├── main.jsx                       # Re-export shim for main.tsx
├── main.tsx                       # React DOM root entry point
├── index.css                      # Tailwind base, dark void theme, glassmorphism, glowing utilities
├── components/
│   ├── ContractInitialization.jsx # Re-export shim for ContractInitialization.tsx
│   ├── ContractInitialization.tsx # Phase 1 contract form & hash lock display
│   ├── VerificationDashboard.jsx # Re-export shim for VerificationDashboard.tsx
│   ├── VerificationDashboard.tsx # Phase 2 CI/CD pipeline & audit telemetry display
│   └── ui/                        # UI Primitives
│       ├── FuturisticButton.tsx   # Neon/glass button with loading state & glow
│       ├── GlassCard.tsx          # Glassmorphic card container with accent bars & hover effects
│       ├── MobileDrawer.tsx       # Slide-over drawer with backdrop blur for mobile
│       ├── RadialGauge.tsx        # SVG radial gauge meter for score visualization
│       ├── StatusBadge.tsx        # Status pill badge with pulse animation & copy-to-clipboard
│       ├── ToastNotification.tsx  # Toast context provider & animated notification items
│       └── index.ts               # Re-export barrel for UI primitives
└── types/                         # TypeScript interfaces (to be converted to JS mock/doc specs)
    ├── contract.ts                # ContractData, ContractStatus, LockResponse
    ├── escrow.ts                  # EscrowStatus, OracleSignals, MerkleLedgerEntry
    ├── index.ts                   # Types index
    ├── telemetry.ts               # AuditResults, PipelineStepConfig, OwaspVulnerability
    └── xai.ts                     # XAITrustScoreData, ScopeGuardAnalysis, XaiJustification
```

### 2.2 Styling & Design Tokens
- **Theme**: Deep space dark void (`#0B0D1E` background, `#101226` cards, `#00D4FF` cyber cyan, `#9333FF` electric purple, `#00FF88` status success, `#FF3366` status danger).
- **Typography**: Inter (sans-serif text) and JetBrains Mono (code, hashes, telemetry metrics).
- **Effects**: Backdrop blur (`backdrop-filter: blur(20px)`), scanline overlays (`.scan-overlay`), glow pulse animations, animated gradient borders (`.gradient-border`).

---

## 3. Strict Compliance Violation & JavaScript Migration Plan

### 3.1 Requirement Conflict Identified
- **Requirement R1**: "The codebase must remain in plain JavaScript and JSX (`.js` or `.jsx`). Do NOT use TypeScript."
- **Acceptance Criterion 2**: "There are no `.ts` or `.tsx` files introduced in the `apps/web/src` directory."
- **Current State**: `apps/web/src` contains 13 `.ts`/`.tsx` files, and `index.html` references `/src/main.tsx`.

### 3.2 Actionable Migration Plan for Implementer
1. **`index.html` Update**: Change line 21 from `<script type="module" src="/src/main.tsx"></script>` to `<script type="module" src="/src/main.jsx"></script>`.
2. **File Conversion**:
   - `main.tsx` → Replace `main.jsx` with plain JS content of `main.tsx` (remove `.tsx` file).
   - `App.tsx` → Replace `App.jsx` with plain JSX content of `App.tsx` (remove `.tsx` file, remove TS type annotations like `: ActivePhase`, `: ContractData`).
   - `ContractInitialization.tsx` → Replace `ContractInitialization.jsx` with plain JSX content (remove TS interfaces & type casts).
   - `VerificationDashboard.tsx` → Replace `VerificationDashboard.jsx` with plain JSX content (remove TS type annotations).
   - `components/ui/*.tsx` → Convert all UI components to `.jsx` files (`FuturisticButton.jsx`, `GlassCard.jsx`, `MobileDrawer.jsx`, `RadialGauge.jsx`, `StatusBadge.jsx`, `ToastNotification.jsx`, `index.js`).
   - `types/*.ts` → Delete `types/` folder in `apps/web/src` OR replace with `data/` constants / JS helper functions, as `.ts` files inside `apps/web/src` fail Acceptance Criterion 2.
3. **Build Script Verification**: Ensure `vite build` succeeds using `vite.config.js`.

---

## 4. XAI Trust Score Evaluation View Specification

### 4.1 Objective & Domain Context
The **XAI Trust Score Evaluation View** evaluates the overall trust level of delivered software before releasing funds. It synthesizes telemetry metrics from the CI/CD pipeline, RAG similarity analysis from ScopeGuard, OWASP vulnerability counts, and AST cyclomatic complexity into an explainable 0–100 score with an explicit grade and recommendation.

### 4.2 Required Data Schema & Mock Model (`src/data/mockXaiData.js`)

```javascript
export const MOCK_XAI_DATA = {
  overallScore: 92,
  grade: 'A+',
  recommendation: 'APPROVE_SETTLEMENT', // 'APPROVE_SETTLEMENT' | 'MANUAL_REVIEW' | 'REJECT_SETTLEMENT'
  evaluatedAt: new Date().toISOString(),
  modelVer: 'v2.4-hybrid-rag',
  components: {
    maintainabilityIndex: 88,
    testPassRate: 100, // %
    owaspVulnerabilityCount: 0,
    ragSimilarityScore: 95.4, // %
  },
  weights: [
    { category: 'codeQuality', label: 'Code Maintainability (AST)', weight: 0.25, score: 88 },
    { category: 'securityCompliance', label: 'OWASP Security Scan', weight: 0.30, score: 100 },
    { category: 'testCoverage', label: 'Hidden Test Suite Coverage', weight: 0.25, score: 100 },
    { category: 'scopeAdherence', label: 'RAG Semantic Scope Match', weight: 0.20, score: 95 },
  ],
  scopeGuard: {
    inScopeScore: 96,
    outOfScopeScore: 4,
    unauthorizedFeatures: [],
    justificationText: 'All implemented modules directly correspond to contract requirements R1–R3. AST analysis shows no hidden network calls or unapproved third-party dependencies.',
  },
  justifications: [
    {
      id: 'just-1',
      category: 'codeQuality',
      title: 'Optimal Cyclomatic Complexity',
      finding: 'AST analysis computed average function complexity of 3.2 (Threshold: < 10.0).',
      impact: 'positive',
      confidence: 98,
      recommendation: 'Code structure is modular and highly maintainable.',
    },
    {
      id: 'just-2',
      category: 'securityCompliance',
      title: 'Zero Vulnerabilities Detected',
      finding: 'OWASP Top-10 static analysis scanner identified 0 critical, high, or medium security issues.',
      impact: 'positive',
      confidence: 99,
      recommendation: 'Security posture satisfies enterprise zero-trust requirements.',
    },
    {
      id: 'just-3',
      category: 'scopeAdherence',
      title: 'Semantic Requirement Alignment',
      finding: 'Vector embedding similarity with original contract corpus measured at 95.4%.',
      impact: 'positive',
      confidence: 94,
      recommendation: 'Delivered functionality perfectly matches initial specification.',
    },
  ],
};
```

### 4.3 UI Component Breakdown for XAI View

1. **`XaiScoreHeader.jsx`**:
   - Title: "Phase 03 — XAI Trust Score Evaluation"
   - Contract metadata summary bar (Title, Hash badge, Timestamp).
2. **`TrustScoreGauge.jsx`**:
   - Centerpiece radial gauge (`size={220}`) showing the overall score (e.g. 92/100).
   - Color auto-thresholds: ≥80 (Emerald `#00FF88`), 60–79 (Amber `#FFB800`), <60 (Rose `#FF3366`).
   - Grade pill badge (`A+`, `A`, `B`, etc.) with glowing neon text.
   - Recommendation banner badge:
     - `APPROVE_SETTLEMENT`: Green glow with check icon ("Automated Settlement Recommended").
     - `MANUAL_REVIEW`: Yellow glow with alert icon ("Manual Arbitrator Review Required").
     - `REJECT_SETTLEMENT`: Red glow with error icon ("Contract Terms Unfulfilled").
3. **`FeatureImportanceChart.jsx`**:
   - Interactive breakdown showing how the 4 categories contribute to the final score.
   - Category progress bars showing weight percentage (e.g., Security 30%, Quality 25%) and individual score (0–100).
4. **`ScopeGuardCard.jsx`**:
   - Visual comparison of In-Scope vs Out-of-Scope scores.
   - Status badge for unauthorized features (e.g., "0 Unauthorized Features").
   - Semantic RAG justification text block in monospace styling.
5. **`ExplainabilityAuditTrail.jsx`**:
   - Card list displaying explainability findings.
   - Filter pills (All, Positive, Negative, Neutral).
   - Each item includes: Category icon, Title, Finding text, Confidence progress meter (e.g., 98%), and Recommendation note.
6. **`XaiActionFooter.jsx`**:
   - Action buttons:
     - `Re-evaluate Score` (runs AI evaluation animation).
     - `Proceed to Escrow Settlement` (smooth transition to Phase 4).

---

## 5. Escrow / Settlement Status View Specification

### 5.1 Objective & Domain Context
The **Escrow / Settlement Status View** manages the financial custody of contract funds. It displays locked escrow balances, tracks multi-stage milestone payments, evaluates 5 independent oracle verification signals, displays an interactive Merkle hash audit chain, and provides release/dispute trigger controls.

### 5.2 Required Data Schema & Mock Model (`src/data/mockEscrowData.js`)

```javascript
export const MOCK_ESCROW_DATA = {
  contractId: 'ctr_7f8e9a2b',
  status: 'HELD_IN_ESCROW', // 'UNFUNDED' | 'HELD_IN_ESCROW' | 'RELEASE_PENDING' | 'SETTLED' | 'DISPUTED' | 'REFUNDED'
  budgetCents: 500000, // $5,000.00
  escrowAddress: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
  clientName: 'Enterprise Client Corp',
  freelancerName: 'Alex Mercer (Lead Dev)',
  lockedAt: new Date(Date.now() - 86400000 * 3).toISOString(),
  canSettle: true,
  milestones: [
    { id: 'm1', title: 'Phase 1: Contract Initialization & Hash Lock', amountCents: 100000, status: 'RELEASED', releasedAt: '2026-07-26' },
    { id: 'm2', title: 'Phase 2: Zero-Trust CI/CD Audit & AST Scanning', amountCents: 200000, status: 'READY_FOR_RELEASE', releasedAt: null },
    { id: 'm3', title: 'Phase 3: XAI Trust Evaluation & Final Settlement', amountCents: 200000, status: 'LOCKED', releasedAt: null },
  ],
  oracleSignals: [
    { id: 'sig-1', type: 'CI_TESTS', label: 'Hidden Unit Test Suite', status: 'VERIFIED', details: '5/5 hidden unit test vectors passed successfully.', weight: 0.25 },
    { id: 'sig-2', type: 'SECURITY_SCAN', label: 'OWASP Security Scanner', status: 'VERIFIED', details: '0 vulnerabilities detected in Docker container sandbox.', weight: 0.25 },
    { id: 'sig-3', type: 'SCOPE_RAG', label: 'ScopeGuard RAG Analysis', status: 'VERIFIED', details: '95.4% semantic requirement vector match.', weight: 0.20 },
    { id: 'sig-4', type: 'XAI_SCORE', label: 'XAI Trust Score Threshold', status: 'VERIFIED', details: 'Score 92/100 exceeds minimum settlement threshold (75).', weight: 0.20 },
    { id: 'sig-5', type: 'LEDGER_INTEGRITY', label: 'Merkle Hash Chain Verification', status: 'VERIFIED', details: 'Chain valid. Genesis to current block hashes match ledger.', weight: 0.10 },
  ],
  ledgerBlocks: [
    { ledgerId: 101, actionType: 'CONTRACT_LOCK', previousHash: '0x0000000000000000000000000000000000000000000000000000000000000000', currentHash: '0x3a8f9c1b2e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a', timestamp: '2026-07-26T10:15:00Z', isVerified: true },
    { ledgerId: 102, actionType: 'ESCROW_DEPOSIT', previousHash: '0x3a8f9c1b2e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a', currentHash: '0x7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c', timestamp: '2026-07-26T10:16:30Z', isVerified: true },
    { ledgerId: 103, actionType: 'AUDIT_VERIFIED', previousHash: '0x7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c', currentHash: '0x9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f', timestamp: '2026-07-28T14:22:10Z', isVerified: true },
    { ledgerId: 104, actionType: 'XAI_EVALUATED', previousHash: '0x9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f', currentHash: '0x2c4d6e8f0a2b4c6d8e0f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d', timestamp: '2026-07-28T16:05:44Z', isVerified: true },
  ],
  integrity: {
    isValid: true,
    lastVerifiedHash: '0x2c4d6e8f0a2b4c6d8e0f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d',
    verifiedAt: new Date().toISOString(),
  },
};
```

### 5.3 UI Component Breakdown for Escrow View

1. **`EscrowHeader.jsx`**:
   - Section header: "Phase 04 — Escrow & Settlement Status"
   - Vault overview banner displaying:
     - **Locked Funds**: `$5,000.00` in large neon text (`#00FF88` or `#00D4FF`).
     - **Status Badge**: `HELD IN ESCROW` (cyan/green glow).
     - **Vault Address**: `0x71C...976F` with copy button.
2. **`MilestoneTracker.jsx`**:
   - Step-by-step progress cards for project milestones.
   - Shows milestone title, allocated budget, status pill (`RELEASED`, `READY FOR RELEASE`, `LOCKED`), and individual release trigger button.
3. **`OracleSignalsGrid.jsx`**:
   - 5-column grid displaying the 5 cryptographic oracle signals:
     1. Hidden Unit Tests
     2. OWASP Security Scan
     3. ScopeGuard RAG Analysis
     4. XAI Trust Score Threshold
     5. Merkle Ledger Integrity
   - Visual status indicators (`VERIFIED` check, `PENDING` spinner, `FAILED` alert).
4. **`MerkleLedgerViewer.jsx`**:
   - Interactive Merkle block timeline viewer.
   - Displays ledger ID, action type, block timestamp, previous block hash, and current block hash.
   - Copyable SHA-256 hash badges formatted for responsive wrapping.
   - Integrity verification badge ("Chain Integrity 100% Verified").
5. **`SettlementControlPanel.jsx`**:
   - Action controls:
     - **`Release Escrow Funds`**: Triggers funds release animation & toast notification. Enabled when all 5 oracles are verified.
     - **`Initiate Dispute`**: Opens dispute drawer/modal with reason input and evidence upload simulation.
     - **`Refund Client`**: Emergency refund trigger for failed audits.

---

## 6. Component Reuse & Enhancement Matrix

| Component | Existing File | Status / Action Needed | Purpose in New Dashboard Views |
|-----------|---------------|------------------------|--------------------------------|
| `GlassCard` | `GlassCard.tsx` | Convert to `GlassCard.jsx` | Container cards for XAI metrics, Escrow Vault, Oracle signals, and Merkle blocks. |
| `RadialGauge` | `RadialGauge.tsx` | Convert to `RadialGauge.jsx` | Main score visualization meter for XAI Trust Score (92/100) & metric gauges. |
| `StatusBadge` | `StatusBadge.tsx` | Convert to `StatusBadge.jsx` | Status badges for Oracle signals (`VERIFIED`), Escrow (`HELD IN ESCROW`), Grades (`A+`), and hashes. |
| `FuturisticButton` | `FuturisticButton.tsx` | Convert to `FuturisticButton.jsx` | Main CTA buttons ("Release Funds", "Re-evaluate XAI", "Simulate Push", "Initiate Dispute"). |
| `MobileDrawer` | `MobileDrawer.tsx` | Convert to `MobileDrawer.jsx` | Mobile view navigation drawer, Merkle block detail inspector, and dispute submission modal. |
| `ToastNotification` | `ToastNotification.tsx` | Convert to `ToastNotification.jsx` | Real-time feedback popups upon hash copy, contract lock, escrow release, or error events. |
| `ContractInitialization` | `ContractInitialization.tsx` | Convert to `ContractInitialization.jsx` | Phase 1 view component. |
| `VerificationDashboard` | `VerificationDashboard.tsx` | Convert to `VerificationDashboard.jsx` | Phase 2 view component. |
| **NEW**: `XaiScoreView` | N/A | Create `XaiScoreView.jsx` | Phase 3 view component for XAI Trust Score evaluation. |
| **NEW**: `EscrowSettlementView` | N/A | Create `EscrowSettlementView.jsx` | Phase 4 view component for Escrow / Settlement status. |

---

## 7. Navigation & Workflow Routing Architecture

### 7.1 Updated 4-Phase Workflow Navigation (`App.jsx`)

To provide a cohesive end-to-end user experience, `App.jsx` will be updated to manage a 4-phase sequential workflow:

```
[Phase 1: Contract] ──> [Phase 2: Verification] ──> [Phase 3: XAI Score] ──> [Phase 4: Escrow Status]
```

### 7.2 Tab Navigation Bar Specification
- **Phase 1 — Contract**: Active from start.
- **Phase 2 — Verification**: Unlocked after Phase 1 contract lock.
- **Phase 3 — XAI Score**: Unlocked after Phase 2 CI/CD audit completion.
- **Phase 4 — Escrow Status**: Unlocked after Phase 3 XAI evaluation.

### 7.3 Mobile Responsiveness (375px Viewport Compliance)
- **Header**: Tab bar automatically collapses into a sleek mobile dropdown or `MobileDrawer` on screens `< 640px`.
- **Text & Hashes**: Cryptographic hashes use `break-all font-mono text-[11px]` to ensure zero horizontal scroll overflow at 375px width.
- **Grid Layouts**: Multi-column grids (`grid-cols-2`, `grid-cols-3`) collapse gracefully to `grid-cols-1` on mobile screens.

---

## 8. Summary of Findings & Next Steps

1. **Immediate Task**: Execute the Pure JS migration (convert all `.tsx`/`.ts` files in `apps/web/src` to plain `.jsx`/`.js` and update `index.html`).
2. **Implementation of XAI View**: Build `src/components/XaiScoreView.jsx` and subcomponents using mock data.
3. **Implementation of Escrow View**: Build `src/components/EscrowSettlementView.jsx` and subcomponents using mock data.
4. **Integration**: Update `src/App.jsx` to route across all 4 phases and verify using `npm run build:web`.
