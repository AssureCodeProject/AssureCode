/** Liveness, readiness, and Prometheus metrics endpoints. */
import type { FastifyInstance } from 'fastify';
import { dbPool, metrics, pingRedis } from '../context.js';

export function registerHealthRoutes(server: FastifyInstance): void {
  // Liveness probe
  server.get('/healthz', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0-alpha.0',
    };
  });

  // BUG-009: Readiness probe now actually verifies both DB and Redis connectivity.
  server.get('/readyz', async (_request, reply) => {
    const checks: Record<string, string> = {};
    let allOk = true;

    try {
      await dbPool.query('SELECT 1');
      checks.db = 'ok';
    } catch (err: any) {
      checks.db = `error: ${err?.message || String(err)}`;
      allOk = false;
    }

    const redisStatus = await pingRedis();
    checks.redis = redisStatus;
    if (redisStatus === 'error') allOk = false;

    return reply.status(allOk ? 200 : 503).send({
      status: allOk ? 'ready' : 'not_ready',
      ...checks,
      timestamp: new Date().toISOString(),
    });
  });

  // Prometheus metrics endpoint
  server.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', metrics.getMetricsContentType());
    return metrics.getMetrics();
  });
}
