/**
 * Idempotency middleware, exercised against fakes.
 *
 * The existing idempotency suites need a live Postgres and skip without one,
 * so the three defects fixed here had no coverage at all. These use a fake
 * pool and reply, so they run everywhere.
 *
 * What is pinned:
 *   - a throwing handler releases its claims instead of poisoning the key
 *   - a cross-process duplicate reads the winner's result without a dead wait
 *   - the in-memory cache is actually bounded
 */
import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';

import { withIdempotency, type IdempotencyHandlerResult } from '../src/middleware/idempotency.js';

/** Minimal stand-in for the two queries the middleware issues. */
function fakePool(handlers: {
  reserve?: () => { rowCount: number };
  select?: () => { rowCount: number; rows: any[] };
  onDelete?: (sql: string) => void;
}): pg.Pool {
  return {
    async query(sql: string, _params?: unknown[]) {
      if (sql.includes('INSERT INTO idempotency_keys')) {
        return handlers.reserve?.() ?? { rowCount: 1, rows: [] };
      }
      if (sql.trimStart().startsWith('SELECT')) {
        return handlers.select?.() ?? { rowCount: 0, rows: [] };
      }
      if (sql.trimStart().startsWith('DELETE')) {
        handlers.onDelete?.(sql);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as pg.Pool;
}

function fakeRequest(key?: string) {
  return {
    headers: key ? { 'idempotency-key': key } : {},
    log: { warn: vi.fn(), error: vi.fn() },
  } as any;
}

function fakeReply() {
  const sent: { statusCode?: number; body?: unknown } = {};
  const reply: any = {
    status(code: number) {
      sent.statusCode = code;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
    sent,
  };
  return reply;
}

const ok = (): Promise<IdempotencyHandlerResult<any>> =>
  Promise.resolve({ statusCode: 200, contractId: 'AC-1', body: { fine: true } });

describe('withIdempotency — no key supplied', () => {
  it('runs the handler and returns its result', async () => {
    const reply = fakeReply();
    await withIdempotency(fakePool({}), fakeRequest(), reply, ok);
    expect(reply.sent.statusCode).toBe(200);
    expect(reply.sent.body).toEqual({ fine: true });
  });
});

describe('withIdempotency — a throwing handler must not poison its key', () => {
  it('rethrows and then lets an identical retry run again immediately', async () => {
    const key = `k-throw-${Math.random()}`;
    const deleted: string[] = [];
    const pool = fakePool({ onDelete: (sql) => deleted.push(sql) });

    // First attempt: the handler throws, exactly as a route's Zod parse would
    // on a malformed body.
    await expect(
      withIdempotency(pool, fakeRequest(key), fakeReply(), async () => {
        throw new Error('bad request body');
      }),
    ).rejects.toThrow('bad request body');

    // The reserved row is released so a corrected retry is a first attempt.
    expect(deleted.some((sql) => sql.includes('status_code = 0'))).toBe(true);

    // Second attempt with the same key: previously this waited out two
    // 5-second timeouts against a promise nothing would ever resolve. It must
    // now complete promptly.
    const started = Date.now();
    const reply = fakeReply();
    await withIdempotency(pool, fakeRequest(key), reply, ok);

    expect(reply.sent.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('withIdempotency — cross-process duplicate', () => {
  it('returns the winner’s persisted result without the dead 5s wait', async () => {
    const key = `k-dup-${Math.random()}`;
    // rowCount 0 on the reservation == another process holds the key.
    const pool = fakePool({
      reserve: () => ({ rowCount: 0 }),
      select: () => ({
        rowCount: 1,
        rows: [{ status_code: 201, response_json: { contractId: 'AC-WINNER' } }],
      }),
    });

    const started = Date.now();
    const reply = fakeReply();
    const handler = vi.fn(ok);
    await withIdempotency(pool, fakeRequest(key), reply, handler);

    expect(reply.sent.statusCode).toBe(201);
    expect(reply.sent.body).toEqual({ contractId: 'AC-WINNER' });
    // The winner already ran it; this request must not run it a second time.
    expect(handler).not.toHaveBeenCalled();
    // The removed step-4 re-read made this path cost a flat 5 seconds.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it(
    'falls through to the handler when the winner never records a result',
    async () => {
      const key = `k-noresult-${Math.random()}`;
      const pool = fakePool({
        reserve: () => ({ rowCount: 0 }),
        select: () => ({ rowCount: 0, rows: [] }),
      });

      const reply = fakeReply();
      const started = Date.now();
      await withIdempotency(pool, fakeRequest(key), reply, ok);

      expect(reply.sent.statusCode).toBe(200);
      // This path deliberately polls for the winner's result before giving up,
      // so it is expected to take the full budget — but it must be bounded and
      // must still answer rather than hanging.
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(8_000);
    },
    15_000,
  );
});

describe('withIdempotency — cache bound', () => {
  it('stays bounded well past the 10 000-entry cap', async () => {
    // The old evictStale() broke out of its loop as soon as the map was under
    // the cap and, with a 25-hour TTL, had nothing expired to delete when it
    // was over — so the cap was never applied and the map grew without limit.
    // A leak this shape is only visible in aggregate, hence the volume.
    const pool = fakePool({});
    for (let i = 0; i < 10_600; i++) {
      await withIdempotency(pool, fakeRequest(`bound-${i}`), fakeReply(), ok);
    }

    const { inMemoryCacheSize } = await import('../src/middleware/idempotency.js');
    expect(inMemoryCacheSize()).toBeLessThanOrEqual(10_000);
  });
});
