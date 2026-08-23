/**
 * The transactional outbox relay.
 *
 * This is the component that makes cross-service delivery durable: the gateway
 * writes a domain event into the `outbox` table inside the same transaction as
 * the ledger append, and this relay drains it onto the bus. If it misbehaves,
 * events are silently lost or silently duplicated — and neither shows up as an
 * error anywhere.
 *
 * It had 12% coverage, which is why these exist. The property most worth
 * pinning is the one its own comment describes as a past bug: a single failing
 * publish used to escape to the catch, roll the whole transaction back, and —
 * because rows are drained `ORDER BY created_at ASC` — get picked up first on
 * every subsequent pass, blocking the entire outbox behind it permanently while
 * re-publishing everything that had already succeeded.
 *
 * Driven against a stubbed pg.Pool rather than live Postgres: what is under
 * test is the relay's control flow — which rows commit, which stay unsent,
 * whether the transaction is closed — and a real database would only make those
 * decisions harder to observe. `packages/ledger-client` covers the SQL side.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutboxRelay } from '../src/outbox-relay.js';

type Row = {
  outbox_id: string;
  topic: string;
  payload: Record<string, unknown>;
  correlation_id: string | null;
};

const row = (id: string, topic = 'contract.locked'): Row => ({
  outbox_id: id,
  topic,
  payload: { contractId: `AC-${id}` },
  correlation_id: `cid-${id}`,
});

/**
 * A pg.Pool stub that records every statement issued.
 *
 * The relay reaches its pool through `new pg.Pool(...)` in the constructor, so
 * the instance is replaced after construction — the alternative is threading a
 * pool parameter through production code purely for tests.
 */
function stubPool(selectRows: Row[], opts: { failUpdateFor?: string } = {}) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql.trim().split('\n')[0].trim());
      if (sql.includes('SELECT outbox_id')) return { rows: selectRows, rowCount: selectRows.length };
      if (sql.includes('UPDATE outbox') && opts.failUpdateFor === params?.[0]) {
        throw new Error('update failed');
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), end: vi.fn(async () => undefined) };
  return { pool, client, statements };
}

function relayWith(pool: unknown, publish: ReturnType<typeof vi.fn>) {
  const relay = new OutboxRelay({
    databaseUrl: 'postgresql://unused:unused@127.0.0.1:1/none',
    eventBus: { publish } as never,
    pollIntervalMs: 5,
  });
  // Replace the pool the constructor built. `end()` on the real one is never
  // called, which is why close() below is exercised against the stub too.
  (relay as unknown as { pool: unknown }).pool = pool;
  return relay;
}

describe('OutboxRelay.pump', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('publishes every unsent row and marks each sent, inside one transaction', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const { pool, statements } = stubPool([row('1'), row('2')]);

    const processed = await relayWith(pool, publish).pump();

    expect(processed).toBe(2);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('passes the topic, payload and correlation id straight through', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const { pool } = stubPool([row('7', 'tests.generated')]);

    await relayWith(pool, publish).pump();

    // The correlation id is what links a ledger append to the event it caused;
    // dropping it here would break tracing at the one hop that is asynchronous.
    expect(publish).toHaveBeenCalledWith('tests.generated', { contractId: 'AC-7' }, 'cid-7');
  });

  it('sends no correlation id rather than the string "null" when the column is null', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const { pool } = stubPool([{ ...row('8'), correlation_id: null }]);

    await relayWith(pool, publish).pump();

    expect(publish).toHaveBeenCalledWith('contract.locked', { contractId: 'AC-8' }, undefined);
  });

  // The regression this file exists for.
  it('isolates a failing publish so the rest of the batch still drains', async () => {
    const publish = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('bus down'))
      .mockResolvedValueOnce(undefined);
    const { pool, statements } = stubPool([row('1'), row('2'), row('3')]);

    const processed = await relayWith(pool, publish).pump();

    // Two of three committed; the failure did not sink the batch.
    expect(processed).toBe(2);
    expect(statements.at(-1)).toBe('COMMIT');
    // The failed row is left unsent — it must be retried, not marked delivered.
    const updates = statements.filter((s) => s.startsWith('UPDATE outbox'));
    expect(updates).toHaveLength(2);
  });

  it('does not block the queue behind one permanently failing row', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('always fails'));
    const { pool, statements } = stubPool([row('1'), row('2')]);

    const processed = await relayWith(pool, publish).pump();

    // Nothing published, nothing marked sent — but the transaction still
    // commits and the pass completes, so the next tick is free to try again
    // rather than the relay wedging on the oldest row forever.
    expect(processed).toBe(0);
    expect(statements.filter((s) => s.startsWith('UPDATE outbox'))).toHaveLength(0);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('rolls back and releases the client when the transaction itself fails', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const { pool, client, statements } = stubPool([row('1')], { failUpdateFor: '1' });

    const processed = await relayWith(pool, publish).pump();

    expect(processed).toBe(0);
    expect(statements).toContain('ROLLBACK');
    // Releasing in `finally` is what stops a pool leak on the error path — a
    // relay that ticks every 500ms exhausts its pool within minutes otherwise.
    expect(client.release).toHaveBeenCalled();
  });

  it('returns zero without publishing when the outbox is empty', async () => {
    const publish = vi.fn();
    const { pool } = stubPool([]);

    expect(await relayWith(pool, publish).pump()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('OutboxRelay lifecycle', () => {
  it('start is idempotent and stop halts the timer', async () => {
    const { pool } = stubPool([]);
    const relay = relayWith(pool, vi.fn());

    relay.start();
    relay.start(); // second call must not schedule a second timer
    relay.stop();

    // stop() twice must not throw on an already-cleared timer.
    expect(() => relay.stop()).not.toThrow();
  });

  it('close stops the timer and ends the pool', async () => {
    const { pool } = stubPool([]);
    const relay = relayWith(pool, vi.fn());

    relay.start();
    await relay.close();

    expect(pool.end).toHaveBeenCalled();
  });
});
