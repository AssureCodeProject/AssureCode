/**
 * PostgreSQL connection configuration with verified TLS.
 *
 * Supabase's direct endpoint (db.<ref>.supabase.co) presents a chain rooted at
 * "Supabase Root 2021 CA", which is not in any system trust store. The naive
 * response is `rejectUnauthorized: false`, which disables certificate checking
 * entirely and makes the connection trivially interceptable — on a link that
 * carries the database password and every contract payload.
 *
 * Instead the root is pinned: infra/certs/supabase-ca-bundle.crt is passed as
 * the trust anchor and verification stays ON. Connections to hosts using a
 * publicly-trusted certificate (the Supabase pooler, RDS, a local instance)
 * need no bundle and verify against the system store as usual.
 *
 * Verifying the bundle
 * --------------------
 * The committed bundle was captured from the live endpoint, which is trust on
 * first use. To confirm it out of band, download the certificate from the
 * Supabase dashboard (Project Settings -> Database -> SSL Configuration) and
 * compare the SHA-256 fingerprint:
 *
 *   Supabase Root 2021 CA
 *     80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:
 *     82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
 *
 *   openssl x509 -in infra/certs/supabase-ca-bundle.crt -noout -fingerprint -sha256
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface DbSslConfig {
  ca?: string;
  rejectUnauthorized: boolean;
}

export interface DbConnectionConfig {
  connectionString: string;
  ssl: DbSslConfig | false;
  connectionTimeoutMillis: number;
}

/** Repo-root-relative location of the pinned CA bundle. */
const CA_BUNDLE_RELATIVE = path.join('infra', 'certs', 'supabase-ca-bundle.crt');

function findCaBundle(startDir: string = process.cwd()): string | undefined {
  // Walk up from the working directory so this resolves whether a service is
  // started from the repo root or from its own workspace folder.
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, CA_BUNDLE_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** True for endpoints known to serve a self-signed root. */
function needsPinnedCa(connectionString: string): boolean {
  return /\.supabase\.co(:|\/|$)/.test(connectionString);
}

/**
 * Build a pg client/pool config with TLS verification enabled.
 *
 * Throws when a pinned CA is required but absent, rather than degrading to an
 * unverified connection. A silent downgrade here would mean the database
 * password crosses the network under a TLS session nobody authenticated.
 */
export function buildDbConfig(
  connectionString: string,
  options: { connectionTimeoutMillis?: number; caBundlePath?: string } = {},
): DbConnectionConfig {
  const connectionTimeoutMillis = options.connectionTimeoutMillis ?? 15_000;

  // Local development over a loopback socket has no meaningful MITM surface
  // and typically no TLS listener at all.
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)) {
    return { connectionString, ssl: false, connectionTimeoutMillis };
  }

  if (!needsPinnedCa(connectionString)) {
    // Publicly-trusted chain — the system CA store is the right anchor.
    return { connectionString, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis };
  }

  const bundlePath = options.caBundlePath ?? findCaBundle();
  if (!bundlePath) {
    throw new Error(
      `TLS certificate authority not found. Supabase's direct endpoint uses a self-signed ` +
        `root, so ${CA_BUNDLE_RELATIVE} must be present to verify it. Refusing to connect ` +
        `with certificate verification disabled.`,
    );
  }

  return {
    connectionString,
    ssl: { ca: readFileSync(bundlePath, 'utf8'), rejectUnauthorized: true },
    connectionTimeoutMillis,
  };
}
