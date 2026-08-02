/**
 * OutboxRelay daemon — background worker that polls unsent rows from the `outbox`
 * PostgreSQL table, publishes them to the EventBus, and updates `sent_at` timestamp.
 */
import pg from 'pg';

export class OutboxRelay {
  constructor(options) {
    const poolConfig = options.pgConfig || options.dbConfig
      ? { ...(options.pgConfig || options.dbConfig) }
      : {
          connectionString: options.databaseUrl,
          ssl: options.ssl ?? false,
          ...(options.family ? { family: options.family } : {}),
        };
    this.pool = new pg.Pool(poolConfig);
    this.eventBus = options.eventBus;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.batchSize = options.batchSize ?? 50;
    this.timer = null;
    this.isRunning = false;
  }


  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNext();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  scheduleNext() {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => {
      void this.pump().finally(() => {
        if (this.isRunning) this.scheduleNext();
      });
    }, this.pollIntervalMs);
  }

  async pump() {
    let client = null;
    let processed = 0;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');

      const res = await client.query(
        `SELECT outbox_id, topic, payload, correlation_id
         FROM outbox
         WHERE sent_at IS NULL
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );

      for (const row of res.rows) {
        await this.eventBus.publish(
          row.topic,
          row.payload,
          row.correlation_id || undefined,
        );

        await client.query(
          `UPDATE outbox SET sent_at = NOW() WHERE outbox_id = $1`,
          [row.outbox_id],
        );
        processed++;
      }

      await client.query('COMMIT');
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {}
      }
      console.error('[outbox-relay] Error pumping outbox events:', err);
    } finally {
      if (client) client.release();
    }
    return processed;
  }

  async close() {
    this.stop();
    await this.pool.end();
  }
}
