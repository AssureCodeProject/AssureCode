import pg, { type Pool, type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import type { LedgerEntry } from '@assurecode/shared';
import { trace } from '@opentelemetry/api';
import { metrics } from '@assurecode/telemetry';

const tracer = trace.getTracer('assurecode-ledger-client');

export interface LedgerRow {
  ledgerId: number;
  contractId: string;
  actionType: string;
  payload: Record<string, unknown>;
  previousHash: string;
  currentHash: string;
  createdAt: string;
}

/** Map the JSONB row returned by append_ledger into a typed LedgerEntry. */
function normalizeRow(row: Record<string, unknown>): LedgerRow {
  return {
    ledgerId: Number(row.ledger_id),
    contractId: String(row.contract_id),
    actionType: String(row.action_type),
    payload: row.payload as Record<string, unknown>,
    previousHash: String(row.previous_hash),
    currentHash: String(row.current_hash),
    createdAt: String(row.created_at),
  };
}

/** Compute SHA-256 hash matching PostgreSQL append_ledger procedure. */
function calculateSha256(payload: Record<string, unknown>, previousHash: string): string {
  const serialized = JSON.stringify(payload) + previousHash;
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

export class LedgerClient {
  private pool: Pool;

  constructor(databaseUrl: string, poolSize = 5) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: poolSize });
  }

  /** Append a new entry to the Merkle chain and return the new row. */
  async append(
    contractId: string,
    actionType: string,
    payload: Record<string, unknown>,
    client?: PoolClient,
  ): Promise<LedgerRow> {
    const span = tracer.startSpan('ledger.append', {
      attributes: {
        'ledger.contract_id': contractId,
        'ledger.action_type': actionType,
      },
    });

    const run = async (c: PoolClient) => {
      const result = await c.query(
        'SELECT append_ledger($1, $2, $3::jsonb) AS row',
        [contractId, actionType, JSON.stringify(payload)],
      );
      return normalizeRow(result.rows[0].row as Record<string, unknown>);
    };

    try {
      let row: LedgerRow;
      if (client) {
        row = await run(client);
      } else {
        const c = await this.pool.connect();
        try {
          row = await run(c);
        } finally {
          c.release();
        }
      }
      span.setAttribute('ledger.hash', row.currentHash);
      metrics.ledgerAppendsTotal.inc({ action_type: actionType, contract_id: contractId });
      return row;
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  }

  /** Append within a caller-managed transaction. */
  async appendWith<T>(
    contractId: string,
    actionType: string,
    payload: Record<string, unknown>,
    fn: (client: PoolClient, row: LedgerRow) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.append(contractId, actionType, payload, client);
      const out = await fn(client, row);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Append to Merkle chain AND stage event in outbox table atomically. */
  async appendWithOutbox(
    contractId: string,
    actionType: string,
    ledgerPayload: Record<string, unknown>,
    eventTopic: string,
    eventPayload: Record<string, unknown>,
    correlationId?: string,
  ): Promise<LedgerRow> {
    const span = tracer.startSpan('ledger.appendWithOutbox', {
      attributes: {
        'ledger.contract_id': contractId,
        'ledger.action_type': actionType,
        'event.topic': eventTopic,
      },
    });

    const client = await this.pool.connect();
    try {
      try {
        const result = await client.query(
          'SELECT append_ledger_and_outbox($1, $2, $3::jsonb, $4, $5::jsonb, $6) AS row',
          [
            contractId,
            actionType,
            JSON.stringify(ledgerPayload),
            eventTopic,
            JSON.stringify(eventPayload),
            correlationId || null,
          ],
        );
        const row = normalizeRow(result.rows[0].row as Record<string, unknown>);
        span.setAttribute('ledger.hash', row.currentHash);
        metrics.ledgerAppendsTotal.inc({ action_type: actionType, contract_id: contractId });
        return row;
      } catch (procErr) {
        // BUG-019: Record and log the stored procedure error before falling back
        // so it is not silently swallowed — constraint violations must not be hidden.
        span.recordException(procErr as Error);
        console.warn('[ledger-client] appendWithOutbox stored procedure failed, using manual fallback:', procErr);
        // Fallback: execute transaction with append_ledger + insert outbox
        await client.query('BEGIN');
        try {
          const ledgerRow = await this.append(contractId, actionType, ledgerPayload, client);
          await client.query(
            'INSERT INTO outbox (topic, payload, correlation_id) VALUES ($1, $2::jsonb, $3)',
            [eventTopic, JSON.stringify(eventPayload), correlationId || null],
          );
          await client.query('COMMIT');
          return ledgerRow;
        } catch (txErr) {
          await client.query('ROLLBACK');
          span.recordException(txErr as Error);
          throw txErr;
        }
      }
    } finally {
      span.end();
      client.release();
    }
  }

  /** Get the full chain for a contract (ordered). */
  async getChain(contractId: string): Promise<LedgerRow[]> {
    const result = await this.pool.query(
      'SELECT * FROM merkle_ledger WHERE contract_id = $1 ORDER BY ledger_id ASC',
      [contractId],
    );
    return result.rows.map((r) => normalizeRow(r));
  }

  /** Verify the integrity of a contract's chain (re-derives hashes). */
  async verifyChain(contractId: string): Promise<boolean> {
    // BUG-005: Acquire a client, run the DB query, then RELEASE the client before
    // entering the catch-block fallback which calls this.getChain() — which itself
    // needs a pool connection. Holding the first client while getChain() requests
    // another artificially inflates pool pressure and risks deadlock on small pools.
    let client: import('pg').PoolClient | null = await this.pool.connect();
    let queryRows: any[] = [];
    let queryOk = false;

    try {
      const res = await client.query(
        `SELECT ledger_id AS sequence_number, contract_id, previous_hash, current_hash, payload, encode(digest((to_jsonb(payload) || to_jsonb(previous_hash))::text, 'sha256'), 'hex') AS computed_hash FROM merkle_ledger WHERE contract_id = $1 ORDER BY sequence_number ASC`,
        [contractId],
      );
      queryRows = res.rows;
      queryOk = true;
    } finally {
      // Always release before any fallback pool operation.
      client.release();
      client = null;
    }

    if (queryOk) {
      if (queryRows.length === 0) return true;
      let prev_hash = 'GENESIS';
      for (const row of queryRows) {
        if (row.previous_hash !== prev_hash) return false;
        if (row.current_hash !== row.computed_hash) return false;
        prev_hash = row.current_hash;
      }
      return true;
    }

    // JS Fallback re-verifies full chain with SHA-256 hash calculation
    const rows = await this.getChain(contractId);
    if (rows.length === 0) return true;

    let prev_hash = 'GENESIS';
    for (const row of rows) {
      if (row.previousHash !== prev_hash) return false;

      const expectedHash = calculateSha256(row.payload, row.previousHash);
      if (row.currentHash !== expectedHash) return false;

      prev_hash = row.currentHash;
    }
    return true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export { pg };
export type { Pool, PoolClient };
export type { LedgerEntry };
