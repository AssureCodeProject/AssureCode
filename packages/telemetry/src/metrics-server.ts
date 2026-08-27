import { createServer, type Server } from 'node:http';
import { metrics } from './metrics.js';

/**
 * Minimal `/metrics` HTTP surface for a process that otherwise has none.
 *
 * settlement-worker and ci-worker are pure background workers — no Fastify,
 * no other route — so pulling in a full framework just to expose one
 * Prometheus scrape endpoint would be a heavier dependency than the thing it
 * serves. Everything else (readiness, liveness) stays on the existing `exec`
 * probes those deployments already use; this exists solely so the process
 * that runs the sandbox / moves money is not invisible to `up` and to every
 * `assurecode_*` counter it already increments in-process but nothing was
 * ever scraping.
 */
export function startMetricsServer(port: number, logger: { info: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void }): Server {
  const server = createServer(async (req, res) => {
    if (req.url === '/metrics' && req.method === 'GET') {
      try {
        const body = await metrics.getMetrics();
        res.writeHead(200, { 'Content-Type': metrics.getMetricsContentType() });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('metrics collection failed');
        logger.error({ err }, 'Failed to render /metrics');
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  server.listen(port, () => {
    logger.info({ port }, 'Metrics server listening on /metrics');
  });

  return server;
}
