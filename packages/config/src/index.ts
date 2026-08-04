/**
 * @assurecode/config — Shared env loading + structured logging (pino).
 */
import { z } from 'zod';
import pino from 'pino';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── .env ───────────────────────────────────────────────────────
//
// Nothing loaded this. Every Node service read process.env directly, so
// starting one without exporting the environment first — `node
// apps/api-gateway/dist/server.js`, which is what `npm start` does — silently
// took every default in the schema below. DATABASE_URL fell back to
// localhost:5432, the service reported healthy on /healthz, and then every
// request failed with ECONNREFUSED against a database that was never there.
//
// The failure mode is what makes this worth fixing in the shared package
// rather than per service: a missing .env does not look like a configuration
// error, it looks like the database is down.
//
// Real environment variables always win, so containers and CI are unaffected.

let dotenvLoaded = false;

/** Load repo-root .env into process.env, without overwriting anything set. */
export function loadDotEnv(explicitPath?: string): void {
  if (dotenvLoaded && !explicitPath) return;
  dotenvLoaded = true;

  // packages/config/dist/index.js -> packages/config -> packages -> repo root
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = explicitPath ?? resolve(here, '..', '..', '..', '.env');
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
}

// ── Environment schema ─────────────────────────────────────────
export const AppConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  // Postgres
  DATABASE_URL: z.string().optional(),
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_USER: z.string().default('assurecode'),
  POSTGRES_PASSWORD: z.string().default('assurecode_local_dev'),
  POSTGRES_DB: z.string().default('assurecode'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // ai-service base URL — Layer 2 of the OWASP scan is delegated to it.
  AI_SERVICE_URL: z.string().default('http://localhost:8000'),

  // Neo4j
  NEO4J_URI: z.string().default('bolt://localhost:7687'),
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().default('assurecode_local_dev'),

  // Ports
  GATEWAY_PORT: z.coerce.number().default(4000),
  WEBHOOK_INGEST_PORT: z.coerce.number().default(9000),
  AI_SERVICE_PORT: z.coerce.number().default(8000),
  SCOPE_GUARD_PORT: z.coerce.number().default(8001),
  CI_WORKER_PORT: z.coerce.number().default(5001),
  SETTLEMENT_WORKER_PORT: z.coerce.number().default(5002),

  // LLM keys (optional until used)
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // Stripe (test mode)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // S3 / LocalStack
  S3_ENDPOINT: z.string().default('http://localhost:4566'),
  S3_BUCKET_NAME: z.string().default('assurecode-artifacts'),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

/** Load + validate environment. Throws on invalid config in production. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Before reading, not after: the schema's defaults would otherwise win over
  // values that are sitting in .env unread.
  if (env === process.env) loadDotEnv();
  const parsed = AppConfigSchema.safeParse(env);
  if (!parsed.success) {
    if (env.NODE_ENV === 'production') {
      throw new Error(`Invalid config: ${parsed.error.message}`);
    }
    // In dev/test, fall back to defaults + warn.
    const merged = AppConfigSchema.parse(env);
    return merged;
  }
  return parsed.data;
}

/** Resolve the Postgres connection string from any of the env shapes. */
export function getDatabaseUrl(config: AppConfig): string {
  return (
    config.DATABASE_URL ??
    `postgresql://${config.POSTGRES_USER}:${config.POSTGRES_PASSWORD}@${config.POSTGRES_HOST}:${config.POSTGRES_PORT}/${config.POSTGRES_DB}`
  );
}

// ── Logging ────────────────────────────────────────────────────
import { getCorrelationId } from '@assurecode/telemetry';

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info') {
  return pino({
    name,
    level,
    mixin() {
      const cid = getCorrelationId();
      return cid ? { correlationId: cid } : {};
    },
  });
}

export { pino };
export * from '@assurecode/telemetry';

// ── Database connection (TLS-verified) ─────────────────────────
export { buildDbConfig } from './db.js';
export type { DbConnectionConfig, DbSslConfig } from './db.js';
