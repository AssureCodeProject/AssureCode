import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { startMetricsServer } from '../src/metrics-server.js';
import { metrics } from '../src/metrics.js';

/**
 * settlement-worker and ci-worker have no other HTTP surface, so this tiny
 * server is the only thing standing between them and being invisible to
 * Prometheus. Worth its own real test rather than trusting the two callers'
 * wiring alone.
 */
describe('startMetricsServer', () => {
  let server: Server | undefined;
  const noopLogger = { info: () => undefined, error: () => undefined };

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  it('serves real Prometheus text on GET /metrics', async () => {
    const port = 15801;
    server = startMetricsServer(port, noopLogger);
    metrics.dlqMessagesTotal.inc({ stream: 'metrics-server-test' });

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('assurecode_dlq_messages_total');
  });

  it('returns 404 for any other path', async () => {
    const port = 15802;
    server = startMetricsServer(port, noopLogger);

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(404);
  });
});
