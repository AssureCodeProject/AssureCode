# Handoff Report: Refactoring Strategy for JSX to TSX Migration (Milestone 1)

**Agent**: `explorer_m1_3`  
**Milestone**: 1 — Codebase Modernization & TS Setup  
**Target Files**:
1. `apps/web/src/main.jsx` → `apps/web/src/main.tsx`
2. `apps/web/src/App.jsx` → `apps/web/src/App.tsx`
3. `apps/web/src/components/ContractInitialization.jsx` → `apps/web/src/components/ContractInitialization.tsx`
4. `apps/web/src/components/VerificationDashboard.jsx` → `apps/web/src/components/VerificationDashboard.tsx`

---

## 1. Observation

Direct examination of the existing React JavaScript source files (`apps/web/src/`) reveals the following code structures, implicit `any` vulnerabilities, missing state types, and event/WebSocket handler patterns:

### A. `src/main.jsx` (11 lines)
- **Line 3**: `import App from './App.jsx';` — Uses hardcoded `.jsx` file extension in import path.
- **Line 6**: `ReactDOM.createRoot(document.getElementById('root')).render(...)` — `document.getElementById('root')` returns `HTMLElement | null`. `ReactDOM.createRoot` expects `Element | DocumentFragment`. Without non-null assertion (`!`) or a runtime null check, TypeScript strict mode flags `Argument of type 'HTMLElement | null' is not assignable to parameter of type 'Element | DocumentFragment'`.

### B. `src/App.jsx` (170 lines)
- **Line 19**: `const [activePhase, setActivePhase] = useState(1);` — Implicitly typed as `number`. Should be strictly typed as union literal `1 | 2`.
- **Line 22**: `const [contractData, setContractData] = useState(null);` — Implicitly typed as `null`. Any attempt to pass or set a object without explicit type generics defaults to type `null` permanently in TS.
- **Line 28**: `const handleContractLocked = (data) => { setContractData(data); };` — Parameter `data` has implicit `any` type.
- **Lines 33 & 38**: `goToPhase2` and `goToPhase1` event handlers lack explicit function signatures `() => void`.
- **Lines 131-135 & 145-148**: Props passed to `<ContractInitialization>` and `<VerificationDashboard>` lack prop interface definitions.

### C. `src/components/ContractInitialization.jsx` (534 lines)
- **Line 55**: Component signature `function ContractInitialization({ onContractLocked, contractData, onProceedToPhase2 })` lacks `ContractInitializationProps` interface.
- **Lines 57-62**: `const [formData, setFormData] = useState({ title: '', requirements: '', budget: '', deadline: '' });` — Missing explicit `ContractFormData` interface.
- **Lines 65-69**: State hooks `isProcessing` (`boolean`), `currentStep` (`number`), `completedSteps` (`number[]`), `isLocked` (`boolean`), and `lockedData` (`ContractData | null`) rely on standard inference or default to `null`.
- **Line 74**: `const handleChange = useCallback((e) => { ... })` — Parameter `e` has implicit `any`. Needs `React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>`.
- **Line 92**: `const callApi = async (endpoint, method = 'POST', body = null)` — `endpoint`, `method`, `body` have implicit `any` types. Return type is untyped `Promise<any>`.
- **Line 115**: `const handleSubmit = async (e) => { ... }` — Parameter `e` has implicit `any`. Needs `React.FormEvent<HTMLFormElement>`.
- **Line 170**: `catch (error)` block uses `error.message` directly without narrowing from `unknown`.
- **Line 518**: Helper component `function DetailCard({ label, value, mono = false })` parameter object destructuring has implicit `any` on all properties (`label`, `value`, `mono`).

### D. `src/components/VerificationDashboard.jsx` (638 lines)
- **Line 97**: Component signature `function VerificationDashboard({ contractData, onBack })` lacks `VerificationDashboardProps` interface.
- **Line 67**: `function generateMockResults()` — Return value lacks `AuditResults` interface annotation.
- **Lines 99-103**: State hooks `isRunning` (`boolean`), `activeStep` (`number`), `completedSteps` (`number[]`), `pipelineComplete` (`boolean`), `results` (`AuditResults | null`) lack explicit generic type annotations.
- **Line 108**: `const callApi = async (endpoint, method = 'GET')` — `endpoint` and `method` have implicit `any` parameters and return untyped `Promise<any>`.
- **Line 166**: `socket.onmessage = (event) => { const data = JSON.parse(event.data); ... }` — `event` parameter is `MessageEvent`. `data` parsing requires typed `WebSocketMessage` union.
- **Lines 170 & 179**: `data.type === 'step-complete'` and `data.type === 'audit-complete'` handle incoming WebSocket streaming events without type guards.
- **Line 585**: Helper component `function MetricCard({ id, icon: Icon, label, value, suffix, subtext, status, delay = 0 })` parameter object destructuring has implicit `any` on all properties. `icon: Icon` requires `LucideIcon` or `React.ComponentType<{ className?: string }>`.

---

## 2. Logic Chain

From the observations above, refactoring the codebase to TypeScript requiring 0 `tsc --noEmit` errors follows a 4-layer dependency model:

```
[ Centralized Type Definitions (src/types/) ]
                     │
                     ▼
[ UI Helper Component Props (DetailCard, MetricCard) ]
                     │
                     ▼
[ View Component Props & Handlers (ContractInitialization, VerificationDashboard) ]
                     │
                     ▼
[ App Root & Entry Point (App.tsx, main.tsx) ]
```

### Step 1: Centralized Type Definitions (`src/types/`)

To prevent duplicate type declarations across `App.tsx`, `ContractInitialization.tsx`, and `VerificationDashboard.tsx`, define domain interfaces in `src/types/`:

1. `src/types/contract.ts`:
```typescript
export interface ContractFormData {
  title: string;
  requirements: string;
  budget: string;
  deadline: string;
}

export interface ContractData extends ContractFormData {
  hash: string;
  timestamp: string;
  contractId: string;
  clientId: string;
  budgetCents: number;
}

export interface InitContractResponse {
  contractId: string;
  clientId: string;
  status?: string;
}

export interface LockContractResponse {
  hash: string;
  timestamp: string;
  budgetCents: number;
  status?: string;
}
```

2. `src/types/telemetry.ts`:
```typescript
import React from 'react';

export interface PipelineStep {
  id: number;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  duration: number;
}

export interface AuditResults {
  maintainability: number;
  passedTests: number;
  totalTests: number;
  vulnerabilities: number;
  passed: boolean;
  scanDuration: string;
}

export type WebSocketStepCompleteMessage = {
  type: 'step-complete';
  stepId: number;
};

export type WebSocketAuditCompleteMessage = {
  type: 'audit-complete';
  contractId?: string;
};

export type WebSocketMessage =
  | WebSocketStepCompleteMessage
  | WebSocketAuditCompleteMessage
  | { type: string; [key: string]: unknown };
```

---

### Step 2: Refactoring Strategy for `src/main.tsx`

Rename `src/main.jsx` → `src/main.tsx`:
```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found in document');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

---

### Step 3: Refactoring Strategy for `src/App.tsx`

Rename `src/App.jsx` → `src/App.tsx`:
- Import `ContractData` from `./types/contract`.
- Define `type Phase = 1 | 2;`.
- Type state:
  - `const [activePhase, setActivePhase] = useState<Phase>(1);`
  - `const [contractData, setContractData] = useState<ContractData | null>(null);`
- Type handlers:
  - `const handleContractLocked = (data: ContractData): void => setContractData(data);`
  - `const goToPhase2 = (): void => { if (contractData) setActivePhase(2); };`
  - `const goToPhase1 = (): void => setActivePhase(1);`

---

### Step 4: Refactoring Strategy for `src/components/ContractInitialization.tsx`

Rename `src/components/ContractInitialization.jsx` → `src/components/ContractInitialization.tsx`:
- Define `ContractInitializationProps`:
```typescript
export interface ContractInitializationProps {
  onContractLocked: (data: ContractData) => void;
  contractData: ContractData | null;
  onProceedToPhase2: () => void;
}
```
- Define `LoadingStep`:
```typescript
export interface LoadingStep {
  id: number;
  text: string;
  detail: string;
  duration: number;
}
```
- Type event handlers:
  - `handleChange`: `(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void`
  - `handleSubmit`: `(e: React.FormEvent<HTMLFormElement>): Promise<void>`
- Type API utility:
```typescript
const callApi = async <T,>(
  endpoint: string,
  method: string = 'POST',
  body: unknown = null
): Promise<T> => { ... }
```
- Error handling in `handleSubmit`:
```typescript
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Contract initialization failed:', error);
  setIsProcessing(false);
  alert(`Failed to initialize contract: ${message}`);
}
```
- Helper `DetailCardProps`:
```typescript
interface DetailCardProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}
```

---

### Step 5: Refactoring Strategy for `src/components/VerificationDashboard.tsx`

Rename `src/components/VerificationDashboard.jsx` → `src/components/VerificationDashboard.tsx`:
- Define `VerificationDashboardProps`:
```typescript
export interface VerificationDashboardProps {
  contractData: ContractData | null;
  onBack: () => void;
}
```
- Type `generateMockResults(): AuditResults`.
- Type WebSocket handler:
```typescript
socket.onmessage = (event: MessageEvent) => {
  try {
    const data: WebSocketMessage = JSON.parse(event.data);
    console.log('WebSocket message:', data);

    if (data.type === 'step-complete' && 'stepId' in data && typeof data.stepId === 'number') {
      const stepId = data.stepId;
      setActiveStep(stepId);
      setCompletedSteps((prev) => (!prev.includes(stepId) ? [...prev, stepId] : prev));
    } else if (data.type === 'audit-complete') {
      setPipelineComplete(true);
      setIsRunning(false);
      fetchResults().then((res) => {
        if (res && !isClosed) {
          setResults(res);
        }
      });
    }
  } catch (err) {
    console.error('Failed to parse WebSocket message:', err);
  }
};
```
- Helper `MetricCardProps`:
```typescript
export interface MetricCardProps {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  suffix: string;
  subtext: string;
  status: 'success' | 'warning' | 'danger';
  delay?: number;
}
```

---

## 3. Caveats

1. **Vite Proxy & Endpoint Fallback**:
   `ContractInitialization` and `VerificationDashboard` invoke backend endpoints (`/api/contracts/*`, `/api/audits/*`) via `fetch` and `WebSocket`. In standalone or offline development environments, network calls fail over to `catch` blocks or mock data generators. Refactored `.tsx` types must handle fallback nullability cleanly without throwing runtime type errors.
2. **React Strict Mode & Duplicate Mounts**:
   `main.tsx` renders in `React.StrictMode`. Hooks, state initializers, and WebSocket connections must properly clean up sockets on unmount to prevent leaks.
3. **No Unused Variables**:
   In strict TypeScript configs (`noUnusedLocals: true`), unused icon imports (such as `Hash`, `Sparkles`, `Zap` in `ContractInitialization.jsx` or `Terminal` in `VerificationDashboard.jsx`) will throw compile errors and must be cleaned up.

---

## 4. Conclusion

Migrating `main.jsx`, `App.jsx`, `ContractInitialization.jsx`, and `VerificationDashboard.jsx` to TypeScript (`.tsx`) is straight-forward with zero architectural refactoring required. Centralizing domain types in `src/types/` (`contract.ts`, `telemetry.ts`) ensures clean interfaces for components, forms, API calls, and WebSocket message streams.

Execution plan:
1. Create `src/types/contract.ts` and `src/types/telemetry.ts`.
2. Convert `src/main.jsx` → `src/main.tsx`.
3. Convert `src/App.jsx` → `src/App.tsx`.
4. Convert `src/components/ContractInitialization.jsx` → `src/components/ContractInitialization.tsx`.
5. Convert `src/components/VerificationDashboard.jsx` → `src/components/VerificationDashboard.tsx`.
6. Remove obsolete `.jsx` files.

---

## 5. Verification Method

To independently verify the implementation strategy:
1. Run TypeScript typecheck:
   `npx tsc --noEmit --project apps/web/tsconfig.json` (or `npm run typecheck` from `apps/web`)
   - Expectation: 0 errors.
2. Run Vite Web Build:
   `npm --prefix apps/web run build` or `npm run build:web`
   - Expectation: Build completes successfully producing `dist/` assets.
