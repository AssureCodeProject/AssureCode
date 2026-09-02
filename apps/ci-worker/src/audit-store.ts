/**
 * Persistence for CI audit results.
 *
 * `audit_results` has existed since V001 and was never written to. Every
 * consumer that needed audit telemetry either re-derived it by scanning the
 * ledger for an AUDIT_COMPLETED action, or — in the gateway's case — gave up and
 * used a hardcoded literal. Objective 4 requires the trust score to be computed
 * from real telemetry, so that telemetry needs somewhere durable to live.
 *
 * Ordering matters: the worker writes the row *before* publishing
 * AUDIT_COMPLETED. If the write fails the event is not published, so the oracle
 * never ingests signals for an audit the score endpoint cannot see. The two
 * views of the same pipeline run either both exist or neither does.
 */
import pg from 'pg';
import { buildDbConfig } from '@assurecode/config';
import type { ThreatModel } from './sandbox/types.js';

export interface AuditPayload {
  contractId: string;
  maintainability: number;
  cyclomaticComplexity: number;
  passedTests: number;
  totalTests: number;
  /**
   * Name + assertion message per failing hidden test. Lets a freelancer see
   * exactly which test failed and why, not just a passedTests/totalTests
   * ratio -- previously computed by the harness and discarded before
   * persistence (see test-harness.cjs and sandbox/types.ts's parseTestOutput).
   */
  testFailures?: { name: string; message: string }[];
  /**
   * Worst-offending functions (cyclomaticComplexity > 10, capped to 10),
   * sourced from ast-analyzer.ts's full per-function breakdown, which used to
   * be computed and then thrown away after only the module-level aggregate
   * (maintainability/cyclomaticComplexity above) was kept.
   */
  complexFunctions?: { name: string; line: number; cyclomaticComplexity: number }[];
  vulnerabilities: number;
  /**
   * Per-finding detail (type/category/severity/message/line), capped to 30.
   * Same story as testFailures/complexFunctions: security-auditor.ts already
   * produces this per finding; only the count used to survive into storage.
   */
  vulnerabilityDetails?: {
    type: string;
    category: string;
    severity: string;
    message: string;
    line?: number;
  }[];
  criticalVulns: number;
  highVulns: number;
  securityScore: number;
  passed: boolean;
  scanDuration: number;
  timestamp: string;
  /**
   * Which sandbox adapter produced passedTests/totalTests, and the isolation
   * it actually provided. Previously this stopped at a log line
   * ("Sandbox provisioned") and the CI_SANDBOX_READY event payload — a
   * settlement decision read from this row could not say what isolation
   * strength it rested on. No DB migration needed: audit_results.payload is
   * jsonb.
   */
  sandboxRunner: string;
  threatModel: ThreatModel;
  /**
   * True only for a run triggered by POST /api/contracts/:id/simulate-push's
   * built-in fallback snippet (SIMULATED_PUSH_DEMO_CODE) — a two-line demo
   * function, never the freelancer's actual code. Persisted so a later reader
   * (the simulate-push route's own overwrite guard, the UI) can tell a real
   * result from a demo one without re-deriving it. Absent/false on every
   * other path, including a real GitHub webhook push and a simulate-push call
   * where the caller supplied their own `code`.
   */
  demo: boolean;
}

export interface AuditStore {
  save(payload: AuditPayload): Promise<void>;
}

export class AuditStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuditStoreUnavailableError';
  }
}

/** Writes to audit_results. One row per pipeline run; history is kept. */
export class PostgresAuditStore implements AuditStore {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool(buildDbConfig(databaseUrl));
  }

  async save(payload: AuditPayload): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO audit_results (contract_id, payload, passed)
         VALUES ($1, $2::jsonb, $3)`,
        [payload.contractId, JSON.stringify(payload), payload.passed],
      );
    } catch (err) {
      throw new AuditStoreUnavailableError(
        `failed to persist audit results for ${payload.contractId}: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Test double. Keeps every saved payload so assertions can inspect them. */
export class InMemoryAuditStore implements AuditStore {
  readonly saved: AuditPayload[] = [];

  async save(payload: AuditPayload): Promise<void> {
    this.saved.push(payload);
  }
}
