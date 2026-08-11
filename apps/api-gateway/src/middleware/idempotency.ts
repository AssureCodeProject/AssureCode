import type { FastifyRequest, FastifyReply } from 'fastify';
import pg from 'pg';

export interface IdempotencyHandlerResult<T> {
  statusCode: number;
  body: T;
  contractId?: string;
}

// BUG-006: Bounded TTL cache to prevent unbounded memory growth.
const MAX_CACHE_ENTRIES = 10_000;
const CACHE_TTL_MS = 25 * 60 * 60 * 1000; // 25 hours (> DB 24h expiry)

interface CacheEntry {
  promise: Promise<{ statusCode: number; body: any }>;
  expiry: number;
}

const inMemoryCache = new Map<string, CacheEntry>();

/** Current entry count. Exported so the bound can actually be asserted. */
export function inMemoryCacheSize(): number {
  return inMemoryCache.size;
}

/**
 * Remove expired entries, then enforce the maximum-size cap.
 *
 * The previous version could not enforce the cap at all. It broke out of the
 * loop as soon as `size <= MAX_CACHE_ENTRIES`, and entries are inserted with a
 * 25-hour TTL — so on a map that was over the cap, nothing was expired to
 * delete and the loop walked the whole thing removing nothing. The bound the
 * comment above claims was never applied, and the map grew without limit.
 *
 * Map iterates in insertion order, so the second pass evicts oldest-first.
 */
function evictStale(): void {
  const now = Date.now();
  for (const [key, entry] of inMemoryCache) {
    if (now > entry.expiry) inMemoryCache.delete(key);
  }
  if (inMemoryCache.size <= MAX_CACHE_ENTRIES) return;
  const excess = inMemoryCache.size - MAX_CACHE_ENTRIES;
  let removed = 0;
  for (const key of inMemoryCache.keys()) {
    if (removed >= excess) break;
    inMemoryCache.delete(key);
    removed++;
  }
}

/**
 * Wraps Fastify mutating endpoint handlers with atomic end-to-end idempotency caching.
 *
 * The cache is bounded (≤10 000 entries, oldest evicted first) and each entry
 * carries a 25-hour TTL. In-process duplicates await the winner's in-flight
 * promise directly; cross-process duplicates read the winner's persisted
 * result, because an in-memory promise cannot cross a process boundary.
 *
 * A handler that throws releases both claims — the cache entry and the reserved
 * database row — so an ordinary 400 does not lock its key out for a day.
 */
export async function withIdempotency(
  pool: pg.Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  handler: () => Promise<IdempotencyHandlerResult<any>>,
): Promise<FastifyReply> {
  const raw = request.headers['idempotency-key'] || request.headers['x-idempotency-key'];
  const key = typeof raw === 'string' ? raw.trim() : undefined;

  if (!key) {
    const result = await handler();
    return reply.status(result.statusCode).send(result.body);
  }

  const now = Date.now();

  // 1. In-memory check: handles concurrent in-process duplicates instantly.
  const existing = inMemoryCache.get(key);
  if (existing && now < existing.expiry) {
    // BUG-007: Await the in-flight Promise (with timeout) instead of a busy-wait poll loop.
    const cached = await Promise.race([
      existing.promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    if (cached !== null) {
      return reply.status(cached.statusCode).send(cached.body);
    }
    // Timed out — fall through to DB check.
  }

  // 2. Atomically claim the key in memory BEFORE any async operations.
  let resolvePromise!: (val: { statusCode: number; body: any }) => void;
  const inFlightPromise = new Promise<{ statusCode: number; body: any }>((res) => {
    resolvePromise = res;
  });
  inMemoryCache.set(key, { promise: inFlightPromise, expiry: now + CACHE_TTL_MS });
  evictStale();

  // 3. Try to atomically reserve the key in the DB.
  try {
    const reserveRes = await pool.query(
      `INSERT INTO idempotency_keys (key, contract_id, response_json, status_code, expires_at)
       VALUES ($1, $2, '{}'::jsonb, 0, NOW() + INTERVAL '24 hours')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, null],
    );

    if (reserveRes.rowCount === 1) {
      // We won the race — execute the handler.
      let result: IdempotencyHandlerResult<any>;
      try {
        result = await handler();
      } catch (handlerErr) {
        // A throwing handler used to poison its key for 25 hours: the reserved
        // row stayed at status_code = 0 and this promise stayed pending
        // forever, so every retry with the same key paid two 5-second timeouts
        // and then re-ran anyway. A ZodError from a route's schema parse — an
        // ordinary 400 — was enough to trigger it. Release both claims so a
        // corrected retry behaves like a first attempt.
        inMemoryCache.delete(key);
        resolvePromise({ statusCode: 500, body: { error: 'Handler failed' } });
        await pool
          .query(`DELETE FROM idempotency_keys WHERE key = $1 AND status_code = 0`, [key])
          .catch(() => undefined);
        throw handlerErr;
      }

      const resObj = { statusCode: result.statusCode, body: result.body };
      resolvePromise(resObj);

      // Persist result for cross-process duplicate detection (best-effort).
      try {
        await pool.query(
          `UPDATE idempotency_keys
           SET contract_id = $2, response_json = $3::jsonb, status_code = $4
           WHERE key = $1`,
          [key, result.contractId || null, JSON.stringify(result.body), result.statusCode],
        );
      } catch (err) {
        request.log?.warn?.({ key, err }, 'Failed to persist idempotency result to DB');
      }

      return reply.status(result.statusCode).send(result.body);
    }
  } catch (err) {
    // DB error during reservation — execute handler and resolve in-flight promise.
    request.log?.warn?.({ key, err }, 'Idempotency DB reservation failed; executing handler');
    let result: IdempotencyHandlerResult<any>;
    try {
      result = await handler();
    } catch (handlerErr) {
      // Same release as the won-the-race path: a pending promise left in the
      // cache would stall every retry of this key for its whole 25-hour TTL.
      inMemoryCache.delete(key);
      resolvePromise({ statusCode: 500, body: { error: 'Handler failed' } });
      throw handlerErr;
    }
    const resObj = { statusCode: result.statusCode, body: result.body };
    resolvePromise(resObj);
    return reply.status(result.statusCode).send(result.body);
  }

  // 4. Lost the DB race — the winner is in another process.
  //
  // There was a step here that re-read `inMemoryCache.get(key)` and awaited it
  // with a 5-second timeout. It could only ever time out: step 2 above has
  // already overwritten that entry with *this* request's promise, and on the
  // lost-race path nothing resolves it — so the wait was dead code that added a
  // flat 5 seconds to every cross-process duplicate before falling through to
  // exactly the query below. The winner's result reaches us through the
  // database or not at all, so go there directly.
  //
  // Poll briefly rather than reading once: the winner has reserved the row but
  // may not have written its response yet, and `status_code > 0` is what
  // distinguishes a completed result from a bare reservation.
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const dbRes = await pool.query(
        `SELECT response_json, status_code
         FROM idempotency_keys
         WHERE key = $1 AND expires_at > NOW() AND status_code > 0`,
        [key],
      );
      if (dbRes.rowCount && dbRes.rowCount > 0) {
        const row = dbRes.rows[0];
        resolvePromise({ statusCode: row.status_code, body: row.response_json });
        inMemoryCache.set(key, {
          promise: Promise.resolve({ statusCode: row.status_code, body: row.response_json }),
          expiry: Date.now() + CACHE_TTL_MS,
        });
        return reply.status(row.status_code).send(row.response_json);
      }
    } catch (err) {
      request.log?.warn?.({ key, err }, 'Idempotency DB fallback read failed');
      break;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // 5. Last resort: execute handler (accepts risk of duplicate side-effect).
  request.log?.warn?.({ key }, 'Idempotency exhausted all strategies; executing handler as last resort');
  let result: IdempotencyHandlerResult<any>;
  try {
    result = await handler();
  } catch (handlerErr) {
    inMemoryCache.delete(key);
    resolvePromise({ statusCode: 500, body: { error: 'Handler failed' } });
    throw handlerErr;
  }
  const resObj = { statusCode: result.statusCode, body: result.body };
  resolvePromise(resObj);
  return reply.status(result.statusCode).send(result.body);
}
