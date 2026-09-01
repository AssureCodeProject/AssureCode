/**
 * @assurecode/shared — Cross-service domain types, DTOs, and zod schemas.
 *
 * Single source of truth for the wire format shared by API gateway, workers,
 * event bus, and the web frontend.
 */
import { z } from 'zod';

// ── Event Topics ──────────────────────────────────────────────
//
// Consumption status, recorded here so the next reader does not have to grep it
// out again. "No consumer" is a deliberate state for several of these, not an
// oversight — but which ones is not obvious from the code:
//
//   contract.initialized   published, no consumer. A fan-out point kept for
//   contract.locked        integrations; contract.locked and tests.generated
//   tests.generated        additionally go through the transactional outbox, so
//                          they are durable whether or not anyone listens.
//   code.push.received     -> ci-worker (the audit pipeline), + gateway WS
//   ci.sandbox.ready       -> gateway WS only. These four exist to drive the
//   ci.ast.completed          verification dashboard's live stream; the audit
//   ci.tests.completed        verdict travels on audit.completed instead, so no
//   security.scan.completed   business logic reads them.
//   audit.completed        -> settlement-worker (records the CI signals, then
//                             triggers scoring), + gateway WS
//   scope.checked          -> settlement-worker, log only. The scope signal is
//                             recomputed from scope_checks at evaluation time,
//                             so a single early in-scope message cannot latch
//                             the gate open.
//   xai.scored             -> settlement-worker (the trust-score half of the
//                             settlement gate)
//   settlement.requested   -> settlement-worker
//   settlement.rejected    published, no consumer. The UI learns the outcome by
//   settlement.completed   polling GET /oracle; these are fan-out points.
//   escrow.locked          -> settlement-worker (escrow PENDING -> AUTHORIZED)
//   assignment.pending      published, no consumer. Fan-out point for the
//                            client-assigns-freelancer moment, same "durable
//                            via the outbox, no listener required" shape as
//                            contract.locked.
//   assignment.accepted    -> settlement-worker (client notification, THEN
//                             repo provisioning — see subscribeAssignmentAccepted).
//                             This is what CONTRACT_LOCKED used to trigger
//                             provisioning off of; moved here so a repo is
//                             never created before the freelancer has agreed.
//   assignment.rejected    -> settlement-worker (client notification only;
//                             no provisioning follows).
//
// Every topic also has a `<topic>.dlq` partner created by the Redis and Kafka
// adapters. Nothing drains them; the alert on assurecode_dlq_messages_total is
// what surfaces a poison message.
//
// PAYMENT_FAILED was removed: it was declared here and never published or
// subscribed anywhere. Its wire name also collided confusingly with Razorpay's
// own `payment.failed` event-name string, which the gateway compares inside an
// ESCROW_LOCKED payload and which has nothing to do with this bus.
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
  REPOSITORY_PROVISIONED: 'repository.provisioned',
  ASSIGNMENT_PENDING: 'assignment.pending',
  ASSIGNMENT_ACCEPTED: 'assignment.accepted',
  ASSIGNMENT_REJECTED: 'assignment.rejected',
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

/** Body of POST /api/contracts/:contractId/assignment/reject. */
export const RejectAssignmentSchema = z.object({
  reasonCode: z.enum(['DEADLINE_INFEASIBLE', 'OUTSIDE_EXPERTISE', 'COMPENSATION_MISMATCH', 'UNAVAILABLE', 'OTHER']).optional(),
  reasonText: z.string().max(2000).optional(),
}).refine(
  (body) => body.reasonCode !== 'OTHER' || Boolean(body.reasonText?.trim()),
  { message: 'reasonText is required when reasonCode is OTHER', path: ['reasonText'] },
);
export type RejectAssignment = z.infer<typeof RejectAssignmentSchema>;

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
 * The original required `transferId` and `completedAt`; a first correction
 * changed those to `paymentIntentId` and `settledAt`. `settledAt` was right.
 * `paymentIntentId` was not — that name came from the Stripe era, and the
 * Razorpay pivot made the field `paymentId`. So the comment that claimed this
 * schema had been "aligned with what settlement-worker actually publishes" was
 * itself wrong, and stayed wrong because nothing validates against these
 * schemas: the drift is invisible at runtime and a consumer trusting the type
 * would read undefined.
 *
 * Checked field-by-field against the `settlementPayload` literal in
 * apps/settlement-worker/src/worker.ts. `currency` and `oracleSignals` were
 * published and simply missing here.
 *
 * Release is a *capture* of a held payment, not a transfer — there is no
 * transfer id to report, and no payout leg exists.
 */
export const SettlementCompletedSchema = z.object({
  contractId: z.string(),
  freelancerId: z.string(),
  // Minor units (paise), despite the name — see V014__razorpay_escrow.sql.
  amountCents: z.number().int().nonnegative(),
  paymentId: z.string(),
  currency: z.string(),
  captureStatus: z.string(),
  trustScore: z.number().nullable(),
  criticalVulns: z.number().nullable(),
  // The full verdict the oracle reached, carried for audit rather than for any
  // consumer's control flow. Loose on purpose: packages/oracle owns its shape.
  oracleSignals: z.record(z.unknown()).optional(),
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

