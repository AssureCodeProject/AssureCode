/**
 * Load repo-root `.env` into process.env for integration tests.
 *
 * The services read their configuration from the environment, and `.env` is
 * where the working credentials live (it is gitignored). Without this the
 * integration suites resolve DATABASE_URL to the localhost default, fail to
 * connect, and skip — reporting "no Postgres" on a machine that has one.
 *
 * Existing environment variables always win, so CI can override any value.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function findRepoRoot(startDir: string = process.cwd()): string | undefined {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(path.join(dir, '.env'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

let loaded = false;

export function loadDotEnv(): void {
  if (loaded) return;
  loaded = true;

  const root = findRepoRoot();
  if (!root) return;

  for (const rawLine of readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
