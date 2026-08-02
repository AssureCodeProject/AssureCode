/**
 * @assurecode/config — Shared env loading + structured logging (pino).
 */
import { z } from 'zod';
import pino from 'pino';
import { getCorrelationId } from '@assurecode/telemetry';

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
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),

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

/** Load + validate environment. Throws on invalid config in production. */
export function loadConfig(env = process.env) {
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

/** Resolve the Postgres connection config as an object for pg.Pool.
 *  Avoids URL parsing/escaping issues with special characters in passwords.
 */
export function getPgPoolConfig(config) {
  const ssl = config.POSTGRES_HOST?.includes('supabase')
    ? { rejectUnauthorized: false }
    : false;

  return {
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
    database: config.POSTGRES_DB,
    ssl,
    connectionTimeoutMillis: 10000,
  };
}

/** Resolve the Postgres connection string from any of the env shapes.
 *  Always builds from individual POSTGRES_* vars so special characters
 *  in the password are safely percent-encoded for the pg URL parser.
 */
export function getDatabaseUrl(config) {
  const user = encodeURIComponent(config.POSTGRES_USER);
  const pass = encodeURIComponent(config.POSTGRES_PASSWORD);
  const host = config.POSTGRES_HOST;
  const port = config.POSTGRES_PORT;
  const db   = config.POSTGRES_DB;
  return `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

export function createLogger(name, level = process.env.LOG_LEVEL ?? 'info') {
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
