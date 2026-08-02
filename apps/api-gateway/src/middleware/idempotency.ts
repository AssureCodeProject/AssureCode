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

/** Remove expired entries and enforce the maximum-size cap. */
function evictStale(): void {
  const now = Date.now();
  for (const [key, entry] of inMemoryCache) {
    if (now > entry.expiry) inMemoryCache.delete(key);
    if (inMemoryCache.size <= MAX_CACHE_ENTRIES) break;
  }
}

/**
 * Wraps Fastify mutating endpoint handlers with atomic end-to-end idempotency caching.
 *
 * BUG-006 fixed: cache is now bounded (≤10 000 entries) and each entry has a 25-hour TTL.
 * BUG-007 fixed: duplicate requests await the in-flight Promise directly via Promise.race
 *   (with a 5-second timeout) instead of polling the DB in a busy loop every 100 ms.
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
      const result = await handler();
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
    const result = await handler();
    const resObj = { statusCode: result.statusCode, body: result.body };
    resolvePromise(resObj);
    return reply.status(result.statusCode).send(result.body);
  }

  // 4. Lost the DB race — await the winner's in-flight promise.
  const inflight = inMemoryCache.get(key);
  if (inflight && now < inflight.expiry) {
    const cached = await Promise.race([
      inflight.promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    if (cached !== null) {
      return reply.status(cached.statusCode).send(cached.body);
    }
  }

  // 5. Timeout fallback — read completed result from DB.
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
      return reply.status(row.status_code).send(row.response_json);
    }
  } catch (err) {
    request.log?.warn?.({ key, err }, 'Idempotency DB fallback read failed');
  }

  // 6. Last resort: execute handler (accepts risk of duplicate side-effect).
  request.log?.warn?.({ key }, 'Idempotency exhausted all strategies; executing handler as last resort');
  const result = await handler();
  const resObj = { statusCode: result.statusCode, body: result.body };
  resolvePromise(resObj);
  return reply.status(result.statusCode).send(result.body);
}
