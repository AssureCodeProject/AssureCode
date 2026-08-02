import pg from 'pg';
import { createHash } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { metrics } from '@assurecode/telemetry';

const tracer = trace.getTracer('assurecode-ledger-client');

/** Map the JSONB row returned by append_ledger into a typed LedgerEntry. */
function normalizeRow(row) {
  return {
    ledgerId: Number(row.ledger_id),
    contractId: String(row.contract_id),
    actionType: String(row.action_type),
    payload: row.payload,
    previousHash: String(row.previous_hash),
    currentHash: String(row.current_hash),
    createdAt: String(row.created_at),
  };
}

/** Compute SHA-256 hash matching PostgreSQL append_ledger procedure. */
function calculateSha256(payload, previousHash) {
  const serialized = JSON.stringify(payload) + previousHash;
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

export class LedgerClient {
  constructor(dbConfig, options = {}) {
    const poolConfig = typeof dbConfig === 'object' && dbConfig !== null
      ? { ...dbConfig, max: options.poolSize ?? 5 }
      : { connectionString: dbConfig, max: options.poolSize ?? 5, ssl: options.ssl ?? false, ...(options.family ? { family: options.family } : {}) };
    this.pool = new pg.Pool(poolConfig);
  }



  /** Append a new entry to the Merkle chain and return the new row. */
  async append(contractId, actionType, payload, client) {
    const span = tracer.startSpan('ledger.append', {
      attributes: {
        'ledger.contract_id': contractId,
        'ledger.action_type': actionType,
      },
    });

    const run = async (c) => {
      const result = await c.query(
        'SELECT append_ledger($1, $2, $3::jsonb) AS row',
        [contractId, actionType, JSON.stringify(payload)],
      );
      return normalizeRow(result.rows[0].row);
    };

    try {
      let row;
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
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /** Append within a caller-managed transaction. */
  async appendWith(contractId, actionType, payload, fn) {
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
    contractId,
    actionType,
    ledgerPayload,
    eventTopic,
    eventPayload,
    correlationId,
  ) {
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
        const row = normalizeRow(result.rows[0].row);
        span.setAttribute('ledger.hash', row.currentHash);
        metrics.ledgerAppendsTotal.inc({ action_type: actionType, contract_id: contractId });
        return row;
      } catch (procErr) {
        span.recordException(procErr);
        console.warn('[ledger-client] appendWithOutbox stored procedure failed, using manual fallback:', procErr);
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
          span.recordException(txErr);
          throw txErr;
        }
      }
    } finally {
      span.end();
      client.release();
    }
  }

  /** Get the full chain for a contract (ordered). */
  async getChain(contractId) {
    const result = await this.pool.query(
      'SELECT * FROM merkle_ledger WHERE contract_id = $1 ORDER BY ledger_id ASC',
      [contractId],
    );
    return result.rows.map((r) => normalizeRow(r));
  }

  /** Verify the integrity of a contract's chain (re-derives hashes). */
  async verifyChain(contractId) {
    let client = await this.pool.connect();
    let queryRows = [];
    let queryOk = false;

    try {
      const res = await client.query(
        `SELECT ledger_id AS sequence_number, contract_id, previous_hash, current_hash, payload, encode(digest((to_jsonb(payload) || to_jsonb(previous_hash))::text, 'sha256'), 'hex') AS computed_hash FROM merkle_ledger WHERE contract_id = $1 ORDER BY sequence_number ASC`,
        [contractId],
      );
      queryRows = res.rows;
      queryOk = true;
    } finally {
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

  async close() {
    await this.pool.end();
  }
}

export { pg };
