/**
 * startMetricsServer() attached no 'error' listener to the server it created.
 * A bind failure (e.g. EADDRINUSE, from two settlement-worker test files or a
 * spawned child process both defaulting to SETTLEMENT_WORKER_PORT) is emitted
 * as an 'error' event; Node throws it as an uncaught exception when nothing is
 * listening, which crashes whatever else is running in that process at the
 * time — this is what turned a second process's bind failure into a golden-path
 * test timing out waiting on unrelated state.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMetricsServer } from '../src/metrics-server.js';

describe('startMetricsServer', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  });

  it('logs a bind failure instead of throwing an uncaught exception', async () => {
    const logger = {
      info: () => {},
      error: (obj: unknown) => errors.push(obj),
    };
    const errors: unknown[] = [];

    const first = startMetricsServer(0, logger);
    servers.push(first);
    await new Promise<void>((resolve) => first.once('listening', resolve));
    const { port } = first.address() as AddressInfo;

    // No listener of our own is attached to `second` here — if
    // startMetricsServer does not handle its own 'error' event, this is the
    // exact scenario that crashes the process instead of merely failing this
    // assertion.
    const second = startMetricsServer(port, logger);
    servers.push(second);

    // The bind failure is asynchronous; give it a tick to surface.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(errors).toHaveLength(1);
  });
});
