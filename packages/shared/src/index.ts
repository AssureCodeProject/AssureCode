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
});
export type InitializeContract = z.infer<typeof InitializeContractSchema>;

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
  totalTests: z.number().int().min(1),
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

export const SettlementCompletedSchema = z.object({
  contractId: z.string(),
  amountCents: z.number().int().positive(),
  transferId: z.string(),
  completedAt: z.string().datetime({ offset: true }),
});
export type SettlementCompleted = z.infer<typeof SettlementCompletedSchema>;

export const SettlementRejectedSchema = z.object({
  contractId: z.string(),
  reason: z.string(),
  rejectedAt: z.string().datetime({ offset: true }),
});
export type SettlementRejected = z.infer<typeof SettlementRejectedSchema>;

// ── Idempotency Key Header Schema ──────────────────────────────

export const IdempotencyKeyHeaderSchema = z.object({
  'idempotency-key': z.string().min(1).max(255).optional(),
  'x-idempotency-key': z.string().min(1).max(255).optional(),
}).passthrough();
export type IdempotencyKeyHeader = z.infer<typeof IdempotencyKeyHeaderSchema>;

