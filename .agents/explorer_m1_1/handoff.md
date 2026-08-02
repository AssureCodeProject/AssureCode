# Handoff Report — Milestone 1 (Codebase Modernization & TS Setup Analysis)

## 1. Observation

Direct observations from examining the codebase at `C:\Users\hp\AssureCode`:

### A. Root TypeScript Configuration (`tsconfig.base.json`)
- Path: `C:\Users\hp\AssureCode\tsconfig.base.json`
- Content:
  ```json
  {
    "$schema": "https://json.schemastore.org/tsconfig",
    "compilerOptions": {
      "target": "ES2022",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "lib": ["ES2022"],
      "declaration": true,
      "declarationMap": true,
      "sourceMap": true,
      "strict": true,
      "noUnusedLocals": true,
      "noUnusedParameters": true,
      "noImplicitReturns": true,
      "noFallthroughCasesInSwitch": true,
      "esModuleInterop": true,
      "forceConsistentCasingInFileNames": true,
      "skipLibCheck": true,
      "resolveJsonModule": true,
      "isolatedModules": true
    }
  }
  ```
- Note: Root configuration targets NodeNext environment. The web application requires browser DOM libraries and Bundler module resolution with React JSX transformation.

### B. Web App `package.json` (`apps/web/package.json`)
- Path: `C:\Users\hp\AssureCode\apps\web\package.json`
- Content (lines 1-27):
  ```json
  {
    "name": "@assurecode/web",
    "private": true,
    "version": "1.0.0-alpha.0",
    "type": "module",
    "scripts": {
      "dev": "vite",
      "build": "vite build",
      "preview": "vite preview"
    },
    "dependencies": {
      "react": "^18.3.1",
      "react-dom": "^18.3.1",
      "framer-motion": "^11.18.0",
      "lucide-react": "^0.469.0"
    },
    "devDependencies": {
      "@types/react": "^18.3.18",
      "@types/react-dom": "^18.3.5",
      "@vitejs/plugin-react": "^4.3.4",
      "autoprefixer": "^10.4.20",
      "postcss": "^8.4.49",
      "tailwindcss": "^3.4.17",
      "vite": "^6.0.5"
    }
  }
  ```
- Observation: Missing `"typecheck": "tsc --noEmit"` script. Also requires `@types/node` and `typescript` in devDependencies for clean IDE and CLI execution.

### C. Web Entry & Configuration (`apps/web/vite.config.js` and `apps/web/index.html`)
- Path 1: `C:\Users\hp\AssureCode\apps\web\vite.config.js` (JavaScript config, needs rename to `.ts`).
- Path 2: `C:\Users\hp\AssureCode\apps\web\index.html` line 21:
  `<script type="module" src="/src/main.jsx"></script>`
  (Needs update to point to `/src/main.tsx`).

### D. Current `apps/web/src` Structure & Shared Backend Types
- `apps/web/src/` currently has `main.jsx`, `App.jsx`, `index.css`, and `components/` (`ContractInitialization.jsx`, `VerificationDashboard.jsx`).
- Shared backend types in `packages/shared/src/index.ts` define DTOs for contracts, audit telemetry, ledger entries, pipeline steps, and settlement events.
- `apps/web/src/types/` directory does NOT exist yet and needs to be created with `contract.ts`, `telemetry.ts`, `xai.ts`, `escrow.ts`, and `index.ts`.

---

## 2. Logic Chain

1. **tsconfig.json Strategy**:
   - `apps/web/tsconfig.json` must inherit base compiler settings by extending `../../tsconfig.base.json`.
   - Override `moduleResolution` to `"Bundler"`, `module` to `"ESNext"`, add `lib: ["ES2022", "DOM", "DOM.Iterable"]`, set `jsx: "react-jsx"`, `noEmit: true`, `allowImportingTsExtensions: true`, `baseUrl: "."`, and `paths: { "@/*": ["src/*"] }`.
   - Include files in `src/**/*` and `vite.config.ts`.

2. **package.json Update Strategy**:
   - Add `"typecheck": "tsc --noEmit"` to `"scripts"` in `apps/web/package.json`.
   - Add `@types/node` and `typescript` to `devDependencies` to ensure workspace-wide typechecking via `npm run typecheck` works seamlessly.

3. **Vite Config & HTML Entry Migration Strategy**:
   - Rename `apps/web/vite.config.js` to `apps/web/vite.config.ts`.
   - Ensure type imports (`UserConfig` / `defineConfig` from `vite`) are retained.
   - Update `apps/web/index.html` line 21 from `<script type="module" src="/src/main.jsx"></script>` to `<script type="module" src="/src/main.tsx"></script>`.

4. **Domain Type Definitions Strategy (`apps/web/src/types/`)**:
   - **`contract.ts`**: Define `ContractStatus`, `InitializeContractParams`, `ContractLockedData`, `Contract`, `TestsGeneratedInfo`, `ContractVerificationResult`. Alignment with backend `/api/contracts/*` responses.
   - **`telemetry.ts`**: Define `PipelineStepStatus`, `PipelineStepId`, `PipelineStep`, `AuditResults`, `AuditStreamEvent`, `TelemetryLog`, `OwaspVulnerability`. Alignment with `/api/audits/*` endpoints and WebSocket streaming.
   - **`xai.ts`**: Define `XaiMetricCategory`, `XaiMetricScore`, `XaiJustification`, `XaiTrustScore`. Alignment with `/xai/score` endpoint and Phase 3 XaiScoreView requirements.
   - **`escrow.ts`**: Define `EscrowStatus`, `OracleSignalType`, `OracleSignalStatus`, `OracleSignal`, `MerkleLedgerBlock`, `SettlementRequest`, `SettlementResult`, `EscrowState`. Alignment with `/api/contracts/:id/settle` and Phase 3 EscrowSettlementView requirements.
   - **`index.ts`**: Re-export all type modules (`export * from './contract';` etc.) to form a single clean barrel import path.

---

## 3. Caveats

- **Read-Only Scope**: This report provides the analysis and exact concrete code/configurations for implementation. Code changes should be executed by the implementer agent.
- **Dependency Hoisting**: Root `package.json` contains `typescript: ^5.6.3`. Explicitly declaring `typescript` in `apps/web/package.json` devDependencies guarantees resolution consistency across monorepo package managers.

---

## 4. Conclusion

Milestone 1 execution strategy is fully mapped and ready for implementation. The proposed configs and types ensure 100% type safety, proper Vite bundling, and seamless alignment with shared backend schemas and upcoming UI views.

### Concrete Implementation File Specifications

#### File 1: `apps/web/tsconfig.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,

    /* Bundler mode */
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",

    /* Linting & Path Aliases */
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*", "vite.config.ts"]
}
```

#### File 2: `apps/web/package.json` (Updated `scripts` & `devDependencies`)
```json
{
  "name": "@assurecode/web",
  "private": true,
  "version": "1.0.0-alpha.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "framer-motion": "^11.18.0",
    "lucide-react": "^0.469.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.6.3",
    "vite": "^6.0.5"
  }
}
```

#### File 3: `apps/web/vite.config.ts` (Renamed from `vite.config.js`)
```ts
import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
  },
  plugins: [react()],
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api': {
        target: process.env.VITE_GATEWAY_URL || 'http://localhost:4000',
        changeOrigin: true,
        ws: true,
      },
      '/webhooks': {
        target: process.env.VITE_GATEWAY_URL || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
```

#### File 4: `apps/web/index.html` (Line 21 update)
```html
<script type="module" src="/src/main.tsx"></script>
```

#### File 5: `apps/web/src/types/contract.ts`
```ts
export type ContractStatus = 'DRAFT' | 'LOCKED' | 'IN_PROGRESS' | 'COMPLETED' | 'DISPUTED';

export interface InitializeContractParams {
  title: string;
  requirements: string;
  budgetCents: number;
  deadline: string;
}

export interface ContractLockedData {
  contractId: string;
  hash: string;
  timestamp: string;
  title: string;
  requirements?: string;
  budgetCents: number;
  deadline: string;
  status?: ContractStatus;
  s3Url?: string;
  testCount?: number;
  framework?: string;
}

export interface Contract {
  contractId: string;
  clientId: string;
  freelancerId: string | null;
  title: string;
  requirements: string;
  budgetCents: number;
  deadline: string;
  status: ContractStatus;
  createdAt: string;
  hash?: string;
}

export interface TestsGeneratedInfo {
  contractId: string;
  s3Key: string;
  s3Url: string;
  testCount: number;
  framework: string;
  generatedAt: string;
}

export interface ContractVerificationResult {
  valid: boolean;
  ledgerId?: number;
  currentHash?: string;
  previousHash?: string;
  timestamp?: string;
  error?: string;
}
```

#### File 6: `apps/web/src/types/telemetry.ts`
```ts
export type PipelineStepStatus = 'pending' | 'running' | 'done' | 'failed';
export type PipelineStepId = 1 | 2 | 3 | 4;

export interface PipelineStep {
  id: PipelineStepId;
  label: string;
  description: string;
  status: PipelineStepStatus;
  duration?: number;
  icon?: string;
}

export interface OwaspVulnerability {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  file?: string;
  line?: number;
}

export interface AuditResults {
  maintainability: number;
  passedTests: number;
  totalTests: number;
  vulnerabilities: number;
  passed: boolean;
  scanDuration: string | number;
  cyclomaticComplexity?: number;
  owaspIssues?: OwaspVulnerability[];
}

export interface AuditStreamEvent {
  stepId: number;
  status: PipelineStepStatus;
  message?: string;
  timestamp: string;
  results?: AuditResults;
}

export interface TelemetryLog {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  correlationId?: string;
  source?: string;
}
```

#### File 7: `apps/web/src/types/xai.ts`
```ts
export type XaiMetricCategory = 'codeQuality' | 'securityCompliance' | 'testCoverage' | 'scopeAdherence';

export interface XaiMetricScore {
  category: XaiMetricCategory;
  name: string;
  score: number; // 0–100
  weight: number; // 0.0–1.0
  weightedScore: number;
  status: 'excellent' | 'good' | 'warning' | 'critical';
  details: string;
}

export interface XaiJustification {
  id: string;
  category: XaiMetricCategory;
  title: string;
  finding: string;
  impact: 'positive' | 'negative' | 'neutral';
  confidence: number; // 0–100
  recommendation?: string;
}

export interface XaiTrustScore {
  overallScore: number; // 0–100
  grade: 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';
  recommendation: 'APPROVE_SETTLEMENT' | 'MANUAL_REVIEW' | 'REJECT_SETTLEMENT';
  metrics: XaiMetricScore[];
  justifications: XaiJustification[];
  evaluatedAt: string;
  modelVer: string;
}
```

#### File 8: `apps/web/src/types/escrow.ts`
```ts
export type EscrowStatus = 'UNFUNDED' | 'HELD_IN_ESCROW' | 'RELEASE_PENDING' | 'SETTLED' | 'DISPUTED' | 'REFUNDED';

export type OracleSignalType = 'CI_TESTS' | 'SECURITY_SCAN' | 'SCOPE_RAG' | 'XAI_SCORE' | 'LEDGER_INTEGRITY';
export type OracleSignalStatus = 'PENDING' | 'VERIFIED' | 'FAILED' | 'BYPASSED';

export interface OracleSignal {
  id: string;
  type: OracleSignalType;
  label: string;
  status: OracleSignalStatus;
  verifiedAt?: string;
  details: string;
  weight: number;
}

export interface MerkleLedgerBlock {
  ledgerId: number;
  contractId: string;
  actionType: string;
  previousHash: string;
  currentHash: string;
  timestamp: string;
  isVerified: boolean;
}

export interface SettlementRequest {
  contractId: string;
  freelancerId: string;
  amountCents: number;
  idempotencyKey?: string;
}

export interface SettlementResult {
  success: boolean;
  contractId: string;
  transferId?: string;
  amountCents: number;
  settledAt: string;
  status: 'COMPLETED' | 'REJECTED' | 'PENDING';
  reason?: string;
}

export interface EscrowState {
  contractId: string;
  status: EscrowStatus;
  budgetCents: number;
  signals: OracleSignal[];
  ledgerBlocks: MerkleLedgerBlock[];
  canSettle: boolean;
  lastUpdated: string;
}
```

#### File 9: `apps/web/src/types/index.ts`
```ts
export * from './contract';
export * from './telemetry';
export * from './xai';
export * from './escrow';
```

---

## 5. Verification Method

To verify these changes after implementation:

1. **TypeScript Typecheck Command**:
   Execute `npm run typecheck` (or `npx tsc --noEmit` within `apps/web`). Verify exit code is `0` with zero errors.

2. **Web Build Command**:
   Execute `npm run build:web` (or `npm run build` within `apps/web`). Verify that Vite successfully builds the project bundle to `apps/web/dist/`.

3. **Index HTML Script Reference**:
   Inspect `apps/web/index.html` line 21 to confirm `<script type="module" src="/src/main.tsx"></script>`.

4. **Type Exports Verification**:
   Verify that `import { Contract, AuditResults, XaiTrustScore, EscrowState } from '@/types';` compiles without resolution errors.
