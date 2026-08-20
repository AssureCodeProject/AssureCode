/**
 * @assurecode/shared — Cross-service domain types, DTOs, and zod schemas.
 *
 * Single source of truth for the wire format shared by API gateway, workers,
 * event bus, and the web frontend.
 */
import { z } from 'zod';

// ── Event Topics ──────────────────────────────────────────────
export const EVENT_TOPICS = {
  CONTRACT_INITIALIZED: 'contract.initialized',
  CONTRACT_LOCKED: 'contract.locked',
  CODE_PUSH_RECEIVED: 'code.push.received',
  CI_SANDBOX_READY: 'ci.sandbox.ready',
  CI_AST_COMPLETED: 'ci.ast.completed',
  CI_TESTS_COMPLETED: 'ci.tests.completed',
  SECURITY_SCAN_COMPLETED: 'security.scan.completed',
  AUDIT_COMPLETED: 'audit.completed',
  TESTS_GENERATED: 'tests.generated',
  SCOPE_CHECKED: 'scope.checked',
  XAI_SCORED: 'xai.scored',
  SETTLEMENT_REQUESTED: 'settlement.requested',
  SETTLEMENT_REJECTED: 'settlement.rejected',
  SETTLEMENT_COMPLETED: 'settlement.completed',
  ESCROW_LOCKED: 'escrow.locked',
  PAYMENT_FAILED: 'payment.failed',
} as const;

export type EventTopic = (typeof EVENT_TOPICS)[keyof typeof EVENT_TOPICS];

// ── Event Envelope ─────────────────────────────────────────────
export const EventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  topic: z.string(),
  timestamp: z.string().datetime({ offset: true }),
  correlationId: z.string(),
  payload: z.record(z.unknown()),
  /**
   * W3C trace-context carrier for distributed tracing.
   *
   * Deliberately a sibling of `payload`, not a key inside it. The payload is the
   * domain event and is hashed into the Merkle ledger; trace context changes on
   * every publish, so folding it into the payload would make the ledger hash of
   * an otherwise-identical event unreproducible.
   */
  traceContext: z.record(z.string()).optional(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

// ── Contract DTOs ──────────────────────────────────────────────

export const InitializeContractSchema = z.object({
  title: z.string().min(1),
  requirements: z.string().min(1),
  budgetCents: z.number().int().positive(),
  deadline: z.string().date(),
  // Full text extracted from an uploaded requirements PDF (POST /api/pdf/extract),
  // stored separately from `requirements` — the client may edit the summary
  // that gets hashed without losing the source document RAG ingests against.
  pdfRawText: z.string().optional(),
});
export type InitializeContract = z.infer<typeof InitializeContractSchema>;

/**
 * Body of PATCH /api/contracts/:contractId/github-repo.
 *
 * The value is matched verbatim against a push webhook's
 * `repository.full_name`, so it must be exactly "owner/repo" — a pasted clone
 * URL stored here would simply never match any delivery, and the failure would
 * surface much later as "no contract is linked to this repository" on a push
 * the client believed was wired up. Rejecting it at the boundary makes the
 * mistake visible where it is made.
 */
export const LinkGithubRepoSchema = z.object({
  githubRepoFullName: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'must be exactly "owner/repo", not a URL'),
});
export type LinkGithubRepo = z.infer<typeof LinkGithubRepoSchema>;

export const ContractSchema = z.object({
  contractId: z.string(),
  clientId: z.string(),
  freelancerId: z.string().nullable(),
  title: z.string(),
  requirements: z.string(),
  budgetCents: z.number().int(),
  deadline: z.string(),
  status: z.enum(['DRAFT', 'LOCKED', 'IN_PROGRESS', 'COMPLETED', 'DISPUTED']),
  createdAt: z.string().datetime({ offset: true }),
});
export type Contract = z.infer<typeof ContractSchema>;

export const ContractLockedSchema = z.object({
  contractId: z.string(),
  hash: z.string().length(64),
  timestamp: z.string().datetime({ offset: true }),
  title: z.string(),
  budgetCents: z.number().int(),
  deadline: z.string(),
});
export type ContractLocked = z.infer<typeof ContractLockedSchema>;

// ── Tests Generated DTO ──────────────────────────────────────

export const TestsGeneratedSchema = z.object({
  contractId: z.string(),
  s3Key: z.string(),
  s3Url: z.string(),
  testCount: z.number().int().min(0),
  framework: z.string(),
  generatedAt: z.string().datetime({ offset: true }),
});
export type TestsGenerated = z.infer<typeof TestsGeneratedSchema>;

// ── Audit / CI Telemetry ──────────────────────────────────────

export const AuditResultsSchema = z.object({
  maintainability: z.number().min(0).max(100),
  passedTests: z.number().int().min(0),
  // min(0), not min(1). 0/0 is the sandbox's indeterminate result and is a
  // value the pipeline deliberately produces — `min(1)` made the schema reject
  // the exact case the rest of the system is careful to represent. Consumers
  // must treat totalTests === 0 as "unknown", never as a pass; see
  // ci-worker's overallPassed and OracleStore.evaluate.
  totalTests: z.number().int().min(0),
  vulnerabilities: z.number().int().min(0),
  passed: z.boolean(),
  scanDuration: z.number(),
});
export type AuditResults = z.infer<typeof AuditResultsSchema>;

// ── Ledger Entry ────────────────────────────────────────────────

export const LedgerEntrySchema = z.object({
  ledgerId: z.number(),
  contractId: z.string(),
  actionType: z.string(),
  payload: z.record(z.unknown()),
  previousHash: z.string(),
  currentHash: z.string().length(64),
  createdAt: z.string().datetime({ offset: true }),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

// ── Pipeline Steps (for WS streaming to UI) ────────────────────

export const PipelineStepSchema = z.object({
  id: z.number(),
  label: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
});
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

// ── Scope Guard ───────────────────────────────────────────────

export const ScopeCheckResultSchema = z.object({
  allowed: z.boolean(),
  similarity: z.number().min(0).max(1),
  reason: z.string(),
});
export type ScopeCheckResult = z.infer<typeof ScopeCheckResultSchema>;

// ── Settlement Events ─────────────────────────────────────────

export const SettlementRequestedSchema = z.object({
  contractId: z.string(),
  freelancerId: z.string(),
  amountCents: z.number().int().positive(),
  requestedAt: z.string().datetime({ offset: true }),
});
export type SettlementRequested = z.infer<typeof SettlementRequestedSchema>;

/**
 * Both schemas below described a wire format nothing produced.
 *
 * SettlementCompletedSchema required `transferId` and `completedAt`, but the
 * settlement worker publishes `paymentIntentId` and `settledAt` — release is a
 * *capture* of a held PaymentIntent, not a transfer, and there is no transfer
 * id to report. SettlementRejectedSchema required `rejectedAt`, which was never
 * sent at all. Neither schema is used to validate anything, so the drift was
 * silent: a consumer that trusted these types would have read undefined from
 * every field.
 *
 * Aligned with what settlement-worker actually publishes.
 */
export const SettlementCompletedSchema = z.object({
  contractId: z.string(),
  freelancerId: z.string(),
  amountCents: z.number().int().nonnegative(),
  paymentIntentId: z.string(),
  captureStatus: z.string(),
  trustScore: z.number().nullable(),
  criticalVulns: z.number().nullable(),
  settledAt: z.string().datetime({ offset: true }),
});
export type SettlementCompleted = z.infer<typeof SettlementCompletedSchema>;

export const SettlementRejectedSchema = z.object({
  contractId: z.string(),
  reason: z.string(),
  /** Present only on the oracle-verdict rejection, not the failure paths. */
  blockers: z.array(z.string()).optional(),
});
export type SettlementRejected = z.infer<typeof SettlementRejectedSchema>;

// ── Idempotency Key Header Schema ──────────────────────────────

export const IdempotencyKeyHeaderSchema = z.object({
  'idempotency-key': z.string().min(1).max(255).optional(),
  'x-idempotency-key': z.string().min(1).max(255).optional(),
}).passthrough();
export type IdempotencyKeyHeader = z.infer<typeof IdempotencyKeyHeaderSchema>;

