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

export interface AuditPayload {
  contractId: string;
  maintainability: number;
  cyclomaticComplexity: number;
  passedTests: number;
  totalTests: number;
  vulnerabilities: number;
  criticalVulns: number;
  highVulns: number;
  securityScore: number;
  passed: boolean;
  scanDuration: number;
  timestamp: string;
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
