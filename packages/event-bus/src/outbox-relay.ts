/**
 * OutboxRelay daemon — background worker that polls unsent rows from the `outbox`
 * PostgreSQL table, publishes them to the EventBus (RedisStreamsBus/KafkaBus),
 * and updates `sent_at` timestamp.
 */
import pg from 'pg';
import type { EventBus } from './index.js';

export interface OutboxRelayOptions {
  databaseUrl: string;
  eventBus: EventBus;
  pollIntervalMs?: number;
  batchSize?: number;
}

export class OutboxRelay {
  private pool: pg.Pool;
  private eventBus: EventBus;
  private pollIntervalMs: number;
  private batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(options: OutboxRelayOptions) {
    this.pool = new pg.Pool({ connectionString: options.databaseUrl });
    this.eventBus = options.eventBus;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.batchSize = options.batchSize ?? 50;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNext();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => {
      void this.pump().finally(() => {
        if (this.isRunning) this.scheduleNext();
      });
    }, this.pollIntervalMs);
  }

  public async pump(): Promise<number> {
    let client: pg.PoolClient | null = null;
    let processed = 0;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');

      const res = await client.query<{
        outbox_id: string;
        topic: string;
        payload: Record<string, unknown>;
        correlation_id: string | null;
      }>(
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

  public async close(): Promise<void> {
    this.stop();
    await this.pool.end();
  }
}
