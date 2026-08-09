/**
 * Reachability probes for the services the integration tests need.
 *
 * These suites are real integration tests: they exercise Postgres transactions,
 * Redis streams, and the Docker sandbox against live services from
 * `infra/docker-compose.yml`. Without those services they cannot mean anything.
 *
 * The rule here is that a suite either RUNS against real infrastructure or is
 * SKIPPED with a visible reason. It never passes by mocking away the thing it
 * was written to verify — a green tick that proves nothing is worse than a skip,
 * because it makes the gap invisible.
 *
 * Bring the services up with `npm run infra:up`.
 */
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '@assurecode/config';

/** Resolve host/port from a connection URL, falling back to localhost defaults. */
function endpointFrom(url: string | undefined, defaultPort: number): { host: string; port: number } {
  if (!url) return { host: '127.0.0.1', port: defaultPort };
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port ? Number(parsed.port) : defaultPort,
    };
  } catch {
    return { host: '127.0.0.1', port: defaultPort };
  }
}

/** True if something accepts a TCP connection at host:port within `timeoutMs`. */
export function canConnect(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

export function postgresAvailable(): Promise<boolean> {
  const { host, port } = endpointFrom(process.env.DATABASE_URL, 5432);
  return canConnect(host, port);
}

export function redisAvailable(): Promise<boolean> {
  const { host, port } = endpointFrom(process.env.REDIS_URL, 6379);
  return canConnect(host, port);
}

/** Docker needs a responsive daemon, not just a binary on PATH. */
export function dockerAvailable(): boolean {
  const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 5000,
    shell: process.platform === 'win32',
  });
  return probe.status === 0;
}

/**
 * Header these integration suites present instead of a user login — they
 * exercise gateway business logic, not the auth guard itself, so they
 * authenticate as a machine caller the same way tools/benchmark.js and the
 * verify_phase*.mjs harnesses do.
 */
export function serviceAuthHeaders(): Record<string, string> {
  return { 'x-service-token': loadConfig().SERVICE_TOKEN };
}

/** Emit the reason once per suite so a skip is never silent. */
export function announceSkip(suite: string, requirement: string): void {
  console.warn(
    `[skip] ${suite} — requires ${requirement}. Start it with \`npm run infra:up\`. ` +
      `This suite was SKIPPED, not passed.`,
  );
}
