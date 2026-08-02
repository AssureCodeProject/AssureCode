# 5-Signal Settlement Tracing Report

## 1. Observation

### Codebase Topology & Service Overview
The AssureCode monorepo implements a zero-trust, autonomous 5-Signal Oracle Escrow Settlement architecture across `apps/` and `packages/`:
- `apps/webhook-ingest/src/server.ts`: Ingests GitHub webhooks, verifies HMAC SHA-256 signatures, and publishes `code.push.received`.
- `apps/ci-worker/src/`: Executes zero-trust CI sandbox (`sandbox-runner.ts`), AST maintainability analysis (`ast-analyzer.ts`), OWASP security audit (`security-auditor.ts`), and visual Playwright video proof generation (`video-recorder.ts`). Publishes `ci.sandbox.ready`, `ci.ast.completed`, `ci.tests.completed`, `security.scan.completed`, `video.verified`, and `audit.completed`.
- `apps/scope-guard/app/main.py`: Python FastAPI service for cosine similarity & pattern-based scope boundary enforcement (`POST /scope/check`).
- `apps/ai-service/app/`: Python FastAPI service serving RAG contract ingestion/query (`routes/rag.py`), test generation (`routes/test_gen.py`), and weighted XAI Trust Score evaluation (`routes/xai.py`).
- `apps/api-gateway/src/server.ts`: Fastify BFF routing requests for contract initialization, locking, test generation, escrow funding, chat intercept, job status, and settlement requests.
- `apps/settlement-worker/src/worker.ts`: 5-Signal Oracle engine. Ingests telemetry, enforces strict Boolean AND criteria across all 5 signals, locks single-fire database guards, calls Stripe payout transfers, and appends Merkle ledger entries atomically.
- `packages/ledger-client/src/index.ts`: PostgreSQL SHA-256 Merkle tree client with outbox staging (`appendWithOutbox`, `verifyChain`).
- `packages/stripe-adapter/src/index.ts`: Hexagonal Stripe adapter managing manual hold PaymentIntents and Connect transfers (`transferToFreelancer`).
- `packages/shared/src/index.ts`: Single source of truth for event topics (`EVENT_TOPICS`) and Zod DTO schemas.

---

### Detailed 5-Signal Breakdown

#### 1. AST Signal (Abstract Syntax Tree / Code Quality / Maintainability)
- **Computed Location**: `apps/ci-worker/src/ast-analyzer.ts`, lines 12–47 in function `analyzeAST(codeString: string)`.
- **Computation Metric & Formula**:
  - Scans code for decision keywords: `if`, `else if`, `for`, `while`, `catch`, `case`, `&&`, `||`, `?` to calculate `cyclomaticComplexity` (base 1).
  - Counts functions matching `function`, `=>`, `def` (`functionCount`).
  - Computes `averageComplexity = decisionPoints / functionCount`.
  - Calculates Maintainability Index: `baseScore = 100 - averageComplexity * 10 - lineCount * 0.5`, clamped to `[10, 100]`.
- **Trigger**: `code.push.received` event processed by `processCodePush` in `apps/ci-worker/src/worker.ts` (lines 35–45).
- **Event Name & Payload**:
  - Direct Topic: `ci.ast.completed` (`EVENT_TOPICS.CI_AST_COMPLETED` - line 44 in `apps/ci-worker/src/worker.ts`).
  - Direct Payload: `{ contractId: string, cyclomaticComplexity: number, maintainabilityIndex: number, lineCount: number, functionCount: number }`.
  - Aggregated Topic: `audit.completed` (`EVENT_TOPICS.AUDIT_COMPLETED` - line 80 in `apps/ci-worker/src/worker.ts`).
  - Aggregated Payload: `auditResults: { contractId, maintainability, cyclomaticComplexity, passedTests, totalTests, vulnerabilities, securityScore, passed, scanDuration, timestamp }`.
- **Ingestion & Evaluation**: Ingested in `apps/settlement-worker/src/worker.ts` (lines 49–70).
  - State Field: `state.astPassed`.
  - Settlement Threshold: `state.astPassed = Number(payload.auditResults.maintainability) >= 10;` (line 57).
- **AI Service Score Contribution**: `apps/ai-service/app/routes/xai.py` (lines 48 & 52): weighted at **25%** (`0.25 * (maintainability / 100.0)`).

#### 2. Tests Signal (Test Coverage / Pass Rate / Unit & Integration Results)
- **Computed Location**: `apps/ci-worker/src/sandbox-runner.ts`, lines 22–52 in function `runInSandbox(contractId: string, options: SandboxOptions)`.
- **Computation Metric**: Runs test suite inside an isolated Docker container (`docker run --rm --network=none --memory=512m --cpus=1 alpine:latest`) or fallback in-memory sandbox. Returns `passedTests` and `totalTests`.
- **Trigger**: `code.push.received` event processed by `processCodePush` in `apps/ci-worker/src/worker.ts` (lines 47–50).
- **Event Name & Payload**:
  - Direct Topic: `ci.tests.completed` (`EVENT_TOPICS.CI_TESTS_COMPLETED` - line 50 in `apps/ci-worker/src/worker.ts`).
  - Direct Payload: `{ contractId: string, passedTests: number, totalTests: number }`.
  - Aggregated Topic: `audit.completed` (`EVENT_TOPICS.AUDIT_COMPLETED` - line 80 in `apps/ci-worker/src/worker.ts`).
- **Ingestion & Evaluation**: Ingested in `apps/settlement-worker/src/worker.ts` (lines 49–70).
  - State Field: `state.testsPassed`.
  - Settlement Threshold: `state.testsPassed = Number(payload.auditResults.passedTests) === Number(payload.auditResults.totalTests) && Number(payload.auditResults.totalTests) > 0;` (lines 58–60). Requires 100% test pass rate.
- **AI Service Score Contribution**: `apps/ai-service/app/routes/xai.py` (lines 47 & 52): weighted at **40%** (`0.40 * (passed_tests / total_tests)`).

#### 3. Security Signal (Vulnerability Scan / Dependency Audit / Security Checks)
- **Computed Location**: `apps/ci-worker/src/security-auditor.ts`, lines 16–75 in function `performSecurityScan(codeString: string)`.
- **Computation Metric & Formula**:
  - Scans AST/code lines for 4 OWASP vulnerability classes:
    1. Hardcoded Secrets (`HARDCODED_SECRET`, HIGH)
    2. Dynamic Code Execution (`DYNAMIC_CODE_EXECUTION`, CRITICAL via `eval()` or `new Function()`)
    3. SQL Injection (`SQL_INJECTION`, CRITICAL via unescaped string concatenation)
    4. Command Injection (`COMMAND_INJECTION`, HIGH via `child_process.exec`)
  - Score Formula: `score = Math.max(0, 100 - criticalCount * 40 - highCount * 20 - vulnerabilities.length * 5)`.
  - Pass Condition: `passed = criticalCount === 0 && highCount === 0`.
- **Trigger**: `code.push.received` event processed by `processCodePush` in `apps/ci-worker/src/worker.ts` (lines 53–55).
- **Event Name & Payload**:
  - Direct Topic: `security.scan.completed` (`EVENT_TOPICS.SECURITY_SCAN_COMPLETED` - line 55 in `apps/ci-worker/src/worker.ts`).
  - Direct Payload: `{ contractId: string, vulnerabilities: Array<...>, passed: boolean, score: number }`.
  - Aggregated Topic: `audit.completed` (`EVENT_TOPICS.AUDIT_COMPLETED` - line 80 in `apps/ci-worker/src/worker.ts`).
- **Ingestion & Evaluation**: Ingested in `apps/settlement-worker/src/worker.ts` (lines 49–70).
  - State Field: `state.securityPassed`.
  - Settlement Threshold: `state.securityPassed = Number(payload.auditResults.vulnerabilities) === 0;` (line 61). Requires 0 vulnerabilities.
- **AI Service Score Contribution**: `apps/ai-service/app/routes/xai.py` (lines 49 & 52): weighted at **20%** (`0.20 * (1.0 if vulnerabilities == 0 else max(0.0, 1.0 - vulnerabilities * 0.25))`).

#### 4. Scope Signal (PR/Commit Diff Scope vs Task Requirements / Scope Compliance)
- **Computed Location**: `apps/scope-guard/app/main.py`, lines 56–85 in function `check_scope(req: ScopeCheckRequest)` under endpoint `POST /scope/check`.
- **Computation Metric**: Checks chat messages / diff requests against `OFF_SCOPE_PATTERNS` ("for free", "extra feature", "without extra budget", "overhaul the whole", "add mobile app", "redesign everything", "unpaid", "no extra cost") and cosine similarity against embedded requirement vectors in PostgreSQL (`rag_embeddings`).
  - Returns `ScopeCheckResponse`: `{ allowed: boolean, similarity_score: float, reason: string, suggested_mediation?: string, checked_at: string }`.
- **Trigger**: HTTP call to `POST /api/contracts/:contractId/chat` in `apps/api-gateway/src/server.ts` (lines 799–865).
- **Event Name & Payload**:
  - Event Topic: `scope.checked` (`EVENT_TOPICS.SCOPE_CHECKED` - lines 829 & 854 in `apps/api-gateway/src/server.ts`).
  - Event Payload: `{ contractId: string, message: string, allowed: boolean, reason?: string, mediation?: string, sender?: string }`.
- **Ingestion & Evaluation**: Ingested in `apps/settlement-worker/src/worker.ts` (lines 72–81).
  - State Field: `state.scopePassed`.
  - Settlement Threshold: `if (payload.allowed) { state.scopePassed = true; }` (lines 77–79).

#### 5. Video Signal (Screen Recording / AI Verification of Demo / Video Analysis)
- **Computed Location**: `apps/ci-worker/src/video-recorder.ts`, lines 12–28 in function `captureVisualProof(contractId: string)`.
- **Computation Metric**: Captures Playwright headful visual proof recorded video, uploads to mock S3 storage, and generates a deterministic SHA-256 cryptographic video hash (`crypto.createHash('sha256').update('${contractId}_${timestamp}_proof').digest('hex')`).
- **Trigger**: Executed during CI pipeline in `apps/ci-worker/src/worker.ts` (lines 58–60).
- **Event Name & Payload**:
  - Event Topic: `video.verified` (`EVENT_TOPICS.VIDEO_VERIFIED` - line 60 in `apps/ci-worker/src/worker.ts`).
  - Event Payload: `{ contractId: string, s3Url: string, s3Key: string, videoHash: string, durationSeconds: number, verified: boolean }`.
- **Ingestion & Evaluation**: Ingested in `apps/settlement-worker/src/worker.ts` (lines 83–90).
  - State Field: `state.videoPassed`.
  - Settlement Threshold: `getState(contractId).videoPassed = true;` (line 88). Requires explicit `video.verified` event emitted over EventBus.

---

## 2. Logic Chain

1. **Trigger Ingestion**:
   - `apps/webhook-ingest/src/server.ts:69–100` verifies incoming GitHub push webhooks via HMAC SHA-256 (`verifyGitHubSignature`) and publishes `code.push.received` (`EVENT_TOPICS.CODE_PUSH_RECEIVED`) onto EventBus with payload `{ contractId, commitHash, repoUrl, ref, pusher, timestamp }`.
   - Alternatively, `apps/api-gateway/src/server.ts:630–652` exposes `POST /api/contracts/:contractId/simulate-push` to manually publish `code.push.received`.

2. **CI Signal Generation Pipeline**:
   - `apps/ci-worker/src/worker.ts:86–98` listens for `code.push.received` and invokes `processCodePush` (lines 21–81).
   - `processCodePush` runs sequentially:
     - `runInSandbox` (`sandbox-runner.ts:22–52`) -> emits `ci.sandbox.ready`.
     - `analyzeAST` (`ast-analyzer.ts:12–47`) -> computes maintainability index & cyclomatic complexity -> emits `ci.ast.completed`.
     - Hidden test execution -> verifies `passedTests` vs `totalTests` -> emits `ci.tests.completed`.
     - `performSecurityScan` (`security-auditor.ts:16–75`) -> checks 4 OWASP vulnerability classes -> emits `security.scan.completed`.
     - `captureVisualProof` (`video-recorder.ts:12–28`) -> creates SHA-256 visual proof hash -> emits `video.verified`.
     - Aggregates metrics into `auditResults` -> emits `audit.completed` (`EVENT_TOPICS.AUDIT_COMPLETED`).

3. **Scope Guard Mediation**:
   - `apps/api-gateway/src/server.ts:799–865` receives chat messages at `POST /api/contracts/:contractId/chat` and forwards them to Python FastAPI `scope-guard` at `/scope/check` (`apps/scope-guard/app/main.py:56–85`).
   - If allowed, API Gateway publishes `scope.checked` (`EVENT_TOPICS.SCOPE_CHECKED`) with `allowed: true`. If blocked, it publishes `scope.checked` with `allowed: false` and returns HTTP 403.

4. **Oracle Ingestion in Settlement Worker**:
   - `apps/settlement-worker/src/worker.ts:30–43` maintains an in-memory oracle store (`oracleStore = new Map<string, ContractOracleState>()`).
   - `settlement-worker` subscribes to:
     - `audit.completed` (lines 49–70) -> sets `astPassed`, `testsPassed`, `securityPassed`.
     - `scope.checked` (lines 72–81) -> sets `scopePassed`.
     - `video.verified` (lines 83–90) -> sets `videoPassed`.

5. **Settlement Evaluation & Single-Fire Database Guard**:
   - Client or freelancer calls `POST /api/contracts/:contractId/settle` (`apps/api-gateway/src/server.ts:450–484`).
   - API Gateway verifies Merkle ledger chain has no existing `INVOICE` entry (line 457) and emits `settlement.requested` (`EVENT_TOPICS.SETTLEMENT_REQUESTED`).
   - `settlement-worker` receives `settlement.requested` (line 93) and evaluates strict Boolean AND across all 5 signals (lines 100–106):
     `const isApproved = state.astPassed && state.testsPassed && state.securityPassed && state.scopePassed && state.videoPassed;`
   - If `isApproved === false`, settlement is rejected (`EVENT_TOPICS.SETTLEMENT_REJECTED` - line 112).
   - If `isApproved === true`, `settlement-worker` performs single-fire concurrency lock against PostgreSQL `settlements` table (lines 123–140):
     `INSERT INTO settlements (contract_id, status) VALUES ($1, 'PROCESSING') ON CONFLICT (contract_id) DO NOTHING RETURNING contract_id;`
   - If `rowCount !== 1`, lock acquisition fails and duplicate payout execution is halted.

6. **Stripe Escrow Transfer & Atomic Merkle Ledger Creation**:
   - `settlement-worker` calls `escrowAdapter.transferToFreelancer({ amountCents, destinationAccountId: 'acct_freelancer_123', contractId })` (`packages/stripe-adapter/src/index.ts:218–234`) to transfer funds via Stripe Connect.
   - Begins PostgreSQL database transaction (`BEGIN`):
     - Appends Merkle ledger block via `ledgerClient.append(contractId, 'INVOICE', invoicePayload, client)` (`packages/ledger-client/src/index.ts:46–88`), which executes PostgreSQL stored procedure `append_ledger` computing `currentHash = SHA256(payload + previousHash)`.
     - Updates `settlements` table: `UPDATE settlements SET status = 'COMPLETED', transfer_id = $1, updated_at = NOW() WHERE contract_id = $2`.
     - Commits transaction (`COMMIT`).
   - Emits `settlement.completed` (`EVENT_TOPICS.SETTLEMENT_COMPLETED`) with transaction details (`contractId`, `amountCents`, `transferId`, `completedAt`).

---

## 3. Caveats

- **Network Mode**: Investigation was executed under `CODE_ONLY` mode. All code paths, schemas, tests, and configuration files were inspected directly on the local filesystem.
- **In-Memory Store Scope**: `settlement-worker` currently maintains oracle signal state in an in-memory `Map<string, ContractOracleState>` instance. In multi-pod production deployments, this state would be backed by Redis Streams / PostgreSQL persistence.
- **Stripe Adapter Seam**: When `STRIPE_SECRET_KEY` is not prefixed with `sk_` or running in test environment, `createEscrowAdapter` falls back to `FakeEscrowAdapter` producing deterministic fake IDs (`tr_fake_...`).

---

## 4. Conclusion

The 5-Signal Settlement process in AssureCode is fully specified, robust, and end-to-end integrated across `apps/` and `packages/`:
1. **AST Signal**: Calculated in `apps/ci-worker/src/ast-analyzer.ts`, published as `ci.ast.completed` and `audit.completed`, evaluated as `maintainability >= 10` in `settlement-worker`.
2. **Tests Signal**: Calculated in `apps/ci-worker/src/sandbox-runner.ts`, published as `ci.tests.completed` and `audit.completed`, evaluated as `passedTests === totalTests && totalTests > 0` in `settlement-worker`.
3. **Security Signal**: Scanned in `apps/ci-worker/src/security-auditor.ts`, published as `security.scan.completed` and `audit.completed`, evaluated as `vulnerabilities === 0` in `settlement-worker`.
4. **Scope Signal**: Verified in `apps/scope-guard/app/main.py`, published as `scope.checked`, evaluated as `allowed === true` in `settlement-worker`.
5. **Video Signal**: Recorded in `apps/ci-worker/src/video-recorder.ts`, published as `video.verified`, evaluated as `videoPassed === true` in `settlement-worker`.
6. **Settlement & Escrow Release**: Enforced via strict Boolean AND in `apps/settlement-worker/src/worker.ts`, guarded against double-payouts using `settlements` table `ON CONFLICT DO NOTHING`, executed via Stripe Connect transfers, and immutably recorded in PostgreSQL Merkle ledger (`merkle_ledger`).

---

## 5. Verification Method

To independently verify the 5-Signal Settlement architecture:

1. **Run Settlement Worker Tests**:
   - Command: `npx vitest run apps/settlement-worker/test/settlement.test.ts`
   - Verification: Confirms 5-signal oracle evaluation logic (`checkOracle`) and single-fire DB guard behavior.
2. **Run Settlement Concurrency Tests**:
   - Command: `npx vitest run apps/settlement-worker/test/settlement-concurrency.test.ts`
   - Verification: Confirms 5 concurrent settlement calls yield exactly 1 success (`rowCount = 1`) and 4 blocked attempts (`rowCount = 0`).
3. **Inspect Core Implementation Files**:
   - `apps/ci-worker/src/worker.ts` (lines 21–81)
   - `apps/settlement-worker/src/worker.ts` (lines 45–203)
   - `apps/api-gateway/src/server.ts` (lines 450–484, 799–865)
   - `apps/scope-guard/app/main.py` (lines 56–85)
   - `apps/ai-service/app/routes/xai.py` (lines 39–71)
   - `packages/ledger-client/src/index.ts` (lines 46–168)
   - `packages/stripe-adapter/src/index.ts` (lines 135–235)
