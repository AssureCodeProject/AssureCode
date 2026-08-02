import pg from 'pg';

const MAX_CACHE_ENTRIES = 10_000;
const CACHE_TTL_MS = 25 * 60 * 60 * 1000; // 25 hours (> DB 24h expiry)

const inMemoryCache = new Map();

/** Remove expired entries and enforce the maximum-size cap. */
function evictStale() {
  const now = Date.now();
  for (const [key, entry] of inMemoryCache) {
    if (now > entry.expiry) inMemoryCache.delete(key);
    if (inMemoryCache.size <= MAX_CACHE_ENTRIES) break;
  }
}

/**
 * Wraps Fastify mutating endpoint handlers with atomic end-to-end idempotency caching.
 */
export async function withIdempotency(pool, request, reply, handler) {
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
    const cached = await Promise.race([
      existing.promise,
      new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    if (cached !== null) {
      return reply.status(cached.statusCode).send(cached.body);
    }
  }

  // 2. Atomically claim the key in memory BEFORE any async operations.
  let resolvePromise;
  const inFlightPromise = new Promise((res) => {
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
      const result = await handler();
      const resObj = { statusCode: result.statusCode, body: result.body };
      resolvePromise(resObj);

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
      new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
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

  request.log?.warn?.({ key }, 'Idempotency exhausted all strategies; executing handler as last resort');
  const result = await handler();
  const resObj = { statusCode: result.statusCode, body: result.body };
  resolvePromise(resObj);
  return reply.status(result.statusCode).send(result.body);
}
