/**
 * Tests for the schemas and topic constants every service shares.
 *
 * `packages/shared` had no test script and no tests. It is the contract between
 * producers and consumers across the event bus — a loosened constraint here is
 * invisible at the call site and shows up as a malformed event three services
 * away, so the constraints that carry real meaning are pinned here explicitly.
 */
import { describe, it, expect } from 'vitest';
import {
  EVENT_TOPICS,
  EventEnvelopeSchema,
  InitializeContractSchema,
  ContractSchema,
  ContractLockedSchema,
  AuditResultsSchema,
  LedgerEntrySchema,
  ScopeCheckResultSchema,
  TestsGeneratedSchema,
  PipelineStepSchema,
} from '../src/index.js';

const ISO = '2026-08-16T10:00:00.000Z';
const SHA256 = 'a'.repeat(64);
const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('EVENT_TOPICS', () => {
  it('has a unique string per topic', () => {
    // A duplicated value would silently join two logical streams: both
    // consumers would receive both event types.
    const values = Object.values(EVENT_TOPICS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('names every topic in dotted lower-case', () => {
    // Redis stream keys and Kafka topic names are taken verbatim from these.
    for (const topic of Object.values(EVENT_TOPICS)) {
      expect(topic).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    }
  });

  it('covers the five pipeline phases end to end', () => {
    // If one of these is renamed, the producer and consumer are updated
    // together via this constant; the test is here so a *deletion* is caught.
    for (const key of [
      'CONTRACT_INITIALIZED',
      'CONTRACT_LOCKED',
      'CODE_PUSH_RECEIVED',
      'AUDIT_COMPLETED',
      'SCOPE_CHECKED',
      'XAI_SCORED',
      'SETTLEMENT_REQUESTED',
      'SETTLEMENT_COMPLETED',
    ] as const) {
      expect(EVENT_TOPICS[key]).toBeTruthy();
    }
  });
});

describe('EventEnvelopeSchema', () => {
  const valid = {
    id: UUID,
    topic: EVENT_TOPICS.CONTRACT_LOCKED,
    timestamp: ISO,
    correlationId: 'corr-1',
    payload: { contractId: 'c1' },
  };

  it('accepts a well-formed envelope', () => {
    expect(EventEnvelopeSchema.parse(valid)).toMatchObject(valid);
  });

  it('requires the id to be a uuid', () => {
    expect(() => EventEnvelopeSchema.parse({ ...valid, id: 'not-a-uuid' })).toThrow();
  });

  it('requires an offset-bearing timestamp', () => {
    // A timestamp without an offset is ambiguous across services in different
    // zones, and consumer lag is computed by subtracting it from now().
    expect(() => EventEnvelopeSchema.parse({ ...valid, timestamp: '2026-08-16 10:00' })).toThrow();
  });

  it('makes traceContext optional', () => {
    expect(EventEnvelopeSchema.parse(valid).traceContext).toBeUndefined();
  });

  it('keeps traceContext a sibling of payload, never inside it', () => {
    // The payload is hashed into the Merkle ledger; trace context changes on
    // every publish, so folding it in would make an otherwise-identical event
    // hash differently and break chain reproduction.
    const parsed = EventEnvelopeSchema.parse({ ...valid, traceContext: { traceparent: '00-a-b-01' } });
    expect(parsed.traceContext).toEqual({ traceparent: '00-a-b-01' });
    expect(parsed.payload).toEqual({ contractId: 'c1' });
    expect('traceContext' in parsed.payload).toBe(false);
  });
});

describe('InitializeContractSchema', () => {
  const valid = {
    title: 'Build an API',
    requirements: 'A REST API with auth',
    budgetCents: 250_000,
    deadline: '2026-12-01',
  };

  it('accepts a well-formed contract', () => {
    expect(InitializeContractSchema.parse(valid)).toMatchObject(valid);
  });

  it('rejects a zero or negative budget', () => {
    expect(() => InitializeContractSchema.parse({ ...valid, budgetCents: 0 })).toThrow();
    expect(() => InitializeContractSchema.parse({ ...valid, budgetCents: -1 })).toThrow();
  });

  it('rejects a fractional budget', () => {
    // The column holds minor units; a fraction of a paise is not a thing, and
    // rounding it downstream silently changes the escrow amount.
    expect(() => InitializeContractSchema.parse({ ...valid, budgetCents: 100.5 })).toThrow();
  });

  it('rejects empty title or requirements', () => {
    expect(() => InitializeContractSchema.parse({ ...valid, title: '' })).toThrow();
    expect(() => InitializeContractSchema.parse({ ...valid, requirements: '' })).toThrow();
  });

  it('treats pdfRawText as optional and separate from requirements', () => {
    // The client may edit the summary that gets hashed without losing the
    // source document RAG ingests against.
    const parsed = InitializeContractSchema.parse({ ...valid, pdfRawText: 'full doc' });
    expect(parsed.pdfRawText).toBe('full doc');
    expect(parsed.requirements).toBe(valid.requirements);
  });
});

describe('ContractSchema', () => {
  const valid = {
    contractId: 'AC-1',
    clientId: 'u1',
    freelancerId: null,
    title: 't',
    requirements: 'r',
    budgetCents: 1000,
    deadline: '2026-12-01',
    status: 'DRAFT',
    createdAt: ISO,
  };

  it('allows an unassigned freelancer', () => {
    expect(ContractSchema.parse(valid).freelancerId).toBeNull();
  });

  it('accepts every lifecycle status and rejects invented ones', () => {
    for (const status of ['DRAFT', 'LOCKED', 'IN_PROGRESS', 'COMPLETED', 'DISPUTED']) {
      expect(ContractSchema.parse({ ...valid, status }).status).toBe(status);
    }
    expect(() => ContractSchema.parse({ ...valid, status: 'SETTLED' })).toThrow();
  });
});

describe('ContractLockedSchema', () => {
  const valid = {
    contractId: 'AC-1',
    hash: SHA256,
    timestamp: ISO,
    title: 't',
    budgetCents: 1000,
    deadline: '2026-12-01',
  };

  it('requires a 64-character hash', () => {
    // This is H0 — the anchor every scope decision binds to. A truncated value
    // would still be a string, and the mismatch would only surface at replay.
    expect(ContractLockedSchema.parse(valid).hash).toHaveLength(64);
    expect(() => ContractLockedSchema.parse({ ...valid, hash: 'a'.repeat(63) })).toThrow();
    expect(() => ContractLockedSchema.parse({ ...valid, hash: 'a'.repeat(65) })).toThrow();
  });
});

describe('AuditResultsSchema', () => {
  const valid = {
    maintainability: 80,
    passedTests: 5,
    totalTests: 5,
    vulnerabilities: 0,
    passed: true,
    scanDuration: 1.2,
  };

  it('accepts 0/0 as the sandbox indeterminate result', () => {
    // min(0), not min(1). `min(1)` rejected the exact case the rest of the
    // system is careful to represent: consumers must read totalTests === 0 as
    // "unknown", never as a pass.
    const parsed = AuditResultsSchema.parse({ ...valid, passedTests: 0, totalTests: 0, passed: false });
    expect(parsed.totalTests).toBe(0);
  });

  it('bounds maintainability to 0-100', () => {
    expect(() => AuditResultsSchema.parse({ ...valid, maintainability: 101 })).toThrow();
    expect(() => AuditResultsSchema.parse({ ...valid, maintainability: -1 })).toThrow();
  });

  it('rejects negative counts', () => {
    expect(() => AuditResultsSchema.parse({ ...valid, vulnerabilities: -1 })).toThrow();
    expect(() => AuditResultsSchema.parse({ ...valid, passedTests: -1 })).toThrow();
  });
});

describe('LedgerEntrySchema', () => {
  const valid = {
    ledgerId: 1,
    contractId: 'AC-1',
    actionType: 'CONTRACT_LOCKED',
    payload: { a: 1 },
    previousHash: 'GENESIS',
    currentHash: SHA256,
    createdAt: ISO,
  };

  it('accepts the GENESIS sentinel as a previous hash', () => {
    // The first row of every chain. Constraining previousHash to length 64
    // would make a genesis row unrepresentable.
    expect(LedgerEntrySchema.parse(valid).previousHash).toBe('GENESIS');
  });

  it('requires currentHash to be a full digest', () => {
    expect(() => LedgerEntrySchema.parse({ ...valid, currentHash: 'abc' })).toThrow();
  });
});

describe('ScopeCheckResultSchema', () => {
  it('bounds similarity to the cosine range', () => {
    expect(ScopeCheckResultSchema.parse({ allowed: true, similarity: 1, reason: 'r' }).similarity).toBe(1);
    expect(() => ScopeCheckResultSchema.parse({ allowed: true, similarity: 1.5, reason: 'r' })).toThrow();
    expect(() => ScopeCheckResultSchema.parse({ allowed: true, similarity: -0.1, reason: 'r' })).toThrow();
  });

  it('always requires a reason, including when allowed', () => {
    // The reason is what makes a decision auditable after the fact.
    expect(() => ScopeCheckResultSchema.parse({ allowed: true, similarity: 0.9 })).toThrow();
  });
});

describe('TestsGeneratedSchema and PipelineStepSchema', () => {
  it('allows a zero test count', () => {
    // The gateway's degraded stub reports testCount: 0; the schema must be able
    // to represent it rather than force a lie.
    const parsed = TestsGeneratedSchema.parse({
      contractId: 'AC-1',
      s3Key: 'k',
      s3Url: 'u',
      testCount: 0,
      framework: 'jest',
      generatedAt: ISO,
    });
    expect(parsed.testCount).toBe(0);
  });

  it('constrains pipeline step status to the four UI states', () => {
    const base = { id: 1, label: 'l', description: 'd' };
    for (const status of ['pending', 'running', 'done', 'failed']) {
      expect(PipelineStepSchema.parse({ ...base, status }).status).toBe(status);
    }
    expect(() => PipelineStepSchema.parse({ ...base, status: 'skipped' })).toThrow();
  });
});
