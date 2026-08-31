/**
 * @assurecode/config — Shared env loading + structured logging (pino).
 */
import { z } from 'zod';
import pino from 'pino';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCorrelationId } from '@assurecode/telemetry';

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

  // Every RedisStreamsBus topic (and its .dlq partner) is trimmed to
  // approximately this many entries on each XADD (MAXLEN ~, so the cost is
  // amortized rather than an exact count on every write). Without a cap here
  // every stream grows forever — there was no trimming at all before this.
  EVENT_STREAM_MAXLEN: z.coerce.number().default(10_000),

  // Event bus backend. createEventBus() only selects KafkaBus when passed an
  // options object with type:'kafka' — every caller used to pass REDIS_URL as
  // a bare string, so this env var was dead and the bus was always Redis (or
  // in-memory). Unset defaults to 'redis', preserving prior behavior.
  EVENT_BUS_TYPE: z.enum(['memory', 'redis', 'kafka']).optional(),
  KAFKA_BROKERS: z.string().default('localhost:9092'),

  // Downstream service base URLs.
  //
  // These are the addresses services use to reach each other, and they must be
  // declared here rather than derived from the *_PORT vars below. The gateway
  // previously built the ai-service URL as `http://localhost:${AI_SERVICE_PORT}`,
  // which is correct only when everything runs on one host: inside a container
  // that resolves to the gateway itself, so /match, /generate-tests and
  // /rag/ingest all called into a port nothing was listening on. Every one of
  // those calls has a fallback, so the failure was silent.
  //
  // ai-service base URL — matchmaking, test generation, RAG ingest, XAI scoring,
  // and Layer 2 of the OWASP scan are all delegated to it.
  AI_SERVICE_URL: z.string().default('http://localhost:8000'),
  SCOPE_GUARD_URL: z.string().default('http://localhost:8001'),
  // Used by settlement-worker to trigger XAI scoring through the gateway rather
  // than reimplementing the /score route's contract resolution and payload shaping.
  GATEWAY_URL: z.string().default('http://localhost:4000'),

  // Whether settlement-worker calls GET /score on the gateway when an audit
  // completes.
  //
  // On by default, unlike ENABLE_GITHUB_SOURCE_FETCH below. That flag is off
  // because turning it on means new outbound traffic to the public internet.
  // This one is an in-cluster call, and with it off the trust-score half of the
  // settlement gate is reachable only by a human opening the XAI tab in a
  // browser -- so "off" is the broken state here, not the safe one.
  //
  // It exists as a kill switch: if the gateway is degraded, an operator can
  // stop every audit from adding a doomed HTTP call and its retry budget to the
  // AUDIT_COMPLETED consume path without redeploying the worker.
  ENABLE_AUTO_SCORING: z.enum(['true', 'false']).default('true'),

  // Which backend serves the matchmaking graph. 'postgres' (default) uses
  // pgvector + HNSW; 'neo4j' uses the native vector index and additionally
  // requires tools/seed-neo4j-vectors.py to have run, without which the adapter
  // degrades to an in-process fixture.
  //
  // Explicit rather than inferred from NEO4J_URI being set — that variable has
  // a default and is present in every environment, so inferring from it would
  // silently switch the backend for every existing deployment.
  GRAPH_BACKEND: z.enum(['postgres', 'neo4j']).default('postgres'),

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

  // LLM — Cloudflare Workers AI is the only provider. Consumed by ai-service
  // (test generation, the security scan's LLM layer, the XAI judge); declared
  // here so the whole stack has one env schema. The Gemini and OpenAI keys that
  // used to sit here were removed with their adapters.
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  LLM_PROVIDER: z.enum(['cloudflare', 'fake']).default('cloudflare'),

  // Razorpay (test mode).
  //
  // Three distinct values, and mixing them up produces failures that look like
  // signature bugs:
  //   - KEY_ID is public. It ships to the browser so Checkout can open, and the
  //     gateway returns it in the escrow-create response rather than the web app
  //     baking it in at build time — one source of truth, and no rebuild to
  //     rotate it.
  //   - KEY_SECRET authenticates API calls and signs the *checkout* callback
  //     (HMAC over `orderId|paymentId`). Never leaves the server.
  //   - WEBHOOK_SECRET is set independently in the Razorpay dashboard and signs
  //     *webhook* bodies. It is not the key secret; using one where the other
  //     belongs rejects every genuine request.
  //
  // Optional here so the adapter can fall back to FakeRazorpayAdapter offline.
  // The gateway refuses to boot in production without a live `rzp_` key.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // RazorpayX's source account for payouts — a different product from plain
  // Razorpay Payments above, only needed by the payout leg's real adapter.
  // Optional for the same reason: createPayoutAdapter falls back to
  // FakePayoutAdapter when this (or the shared rzp_ credentials) is unset.
  RAZORPAYX_ACCOUNT_NUMBER: z.string().optional(),

  // Public base URL of the web app. Used to build KYC and payout-onboarding
  // return URLs, which were hardcoded to http://localhost:3000 in the gateway
  // and so pointed at the developer's own machine from every deployment.
  WEB_APP_URL: z.string().default('http://localhost:3000'),

  // GitHub webhook HMAC secret. webhook-ingest read this straight off
  // process.env with a hardcoded fallback; schema-declaring it means the
  // default is in one place and assertProductionSecrets can see it.
  GITHUB_WEBHOOK_SECRET: z.string().default('assurecode_github_secret'),

  // Publicly reachable base URL of webhook-ingest — distinct from any
  // internal/compose service name, because this is the address GitHub's
  // servers themselves call, not another AssureCode service. Used only when
  // registering a repo webhook on a freelancer's behalf (POST /repos/.../hooks);
  // unset in local dev, where GitHub cannot reach localhost anyway.
  WEBHOOK_INGEST_PUBLIC_URL: z.string().optional(),

  // Auth — JWT signing secret and the shared token machine callers (CI
  // harnesses, benchmark/verify scripts) present instead of a user login.
  // Defaults are placeholders only; the gateway fails fast on these in
  // production (see server.ts) rather than accept an unauthenticated deploy.
  JWT_SECRET: z.string().default('dev_insecure_jwt_secret_change_me'),
  SERVICE_TOKEN: z.string().default('dev_insecure_service_token_change_me'),
  // A plain number here is interpreted as seconds by fast-jwt (the library
  // @fastify/jwt wraps), not milliseconds — a string without units would
  // silently mean milliseconds instead, so this stays numeric. Also used to
  // compute user_sessions.expires_at, so the DB-backed revocation check and
  // the JWT's own `exp` claim agree on the same lifetime.
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().default(86400), // 24h

  // Symmetric key for pgp_sym_encrypt/_decrypt on mfa_credentials.secret_key —
  // same reasoning as GITHUB_TOKEN_ENCRYPTION_KEY (a TOTP secret has to be
  // recoverable to check a live code against it, so it is encrypted at rest
  // rather than hashed). Unlike the GitHub key, MFA routes are always
  // registered (not gated behind an OAuth app being configured), so this
  // needs a default rather than being optional — production still refuses to
  // boot on the default via assertProductionSecrets.
  MFA_SECRET_ENCRYPTION_KEY: z.string().default('dev_insecure_mfa_key_change_me'),

  // The ML-DSA-87 seed the Merkle root signature is derived from. 32 bytes of
  // hex.
  //
  // Read by Python (packages/ledger-client/src/ml_dsa.py) via os.environ, not
  // by any Node service — declared here anyway, for the same reason the other
  // Python-consumed variables are: a deployment needs one documented place that
  // says the variable exists. Optional, with no default: ml_dsa.py refuses to
  // mint a throwaway key when it is unset, because a signature that verifies
  // against nothing is worse than no signature.
  //
  // Deliberately NOT in assertProductionSecrets. No Node service reads it, so
  // requiring it would crash the gateway over a key it never uses. It belongs
  // only in ai-service's environment — see the ai-service block in
  // infra/docker-compose.yml and the assurecode-ledger-signing Secret in k8s.
  ML_DSA_SEED_HEX: z.string().optional(),

  // S3 / LocalStack
  S3_ENDPOINT: z.string().default('http://localhost:4566'),
  S3_BUCKET_NAME: z.string().default('assurecode-artifacts'),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),

  // ── Previously undeclared ────────────────────────────────────────────────
  // Each of the following was read straight off process.env by exactly one
  // module and appeared in no schema, no .env.example and no k8s ConfigMap.
  // That combination means a deployment has no documented way to set them and
  // a typo produces a silent default rather than a startup error, so they are
  // declared here even though their consumers still read process.env directly.

  // CORS allow-list (comma-separated), read by api-gateway. Falls back to the
  // production hostname when unset in production and to origin-reflection in
  // development, so a missing value in production silently locks out any other
  // front-end host.
  ALLOWED_ORIGINS: z.string().optional(),

  // Where packages/telemetry ships OTLP spans. The default points at the
  // loopback collector convention; in-cluster, with nothing listening on
  // 127.0.0.1:4317, every span is exported into a closed socket and discarded.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4317'),

  // Which sandbox ci-worker executes untrusted code in. 'docker' needs the
  // Docker socket mounted; 'node' uses the Node permission model, which is
  // weaker isolation and is what infra/k8s/07-ci-worker.yaml deliberately pins.
  SANDBOX_RUNNER: z.enum(['docker', 'node']).default('docker'),

  // Rate limiting (plan2.md task 8.5). The global bucket applies to every route
  // except health/ready/metrics; the login bucket is far tighter because that
  // endpoint is unauthenticated and does argon2id work.
  RATE_LIMIT_MAX: z.coerce.number().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().default(10),

  // Whether ci-worker fetches the pushed source for a GitHub webhook event.
  //
  // Off by default, and deliberately opt-in rather than inferred from the
  // presence of a token: turning it on means the audit pipeline makes outbound
  // requests to github.com, which is a deployment decision. While it is off, a
  // webhook-originated push is refused with an explanation rather than audited
  // against substitute code — see apps/ci-worker/src/source-fetcher.ts.
  ENABLE_GITHUB_SOURCE_FETCH: z.enum(['true', 'false']).default('false'),
  // Needed for private repositories, and for a workable rate limit: GitHub
  // allows 60 unauthenticated requests per hour per IP, and one audit costs one
  // request per source file plus one for the tree.
  GITHUB_TOKEN: z.string().optional(),

  // GitHub OAuth App — freelancer login and repo connection (distinct from
  // GITHUB_TOKEN above, which is a single shared PAT ci-worker uses to fetch
  // already-pushed source; these authenticate the OAuth flow that lets a
  // freelancer prove who they are and pick which of their own repos to wire
  // up). Optional so the app still boots with password-only login when unset.
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  // Symmetric key for pgp_sym_encrypt/_decrypt (see
  // infra/migrations/postgres/V017__github_oauth.sql) — a freelancer's OAuth
  // token has to be recoverable (to list their repos, to register a webhook),
  // so it is encrypted at rest rather than hashed.
  GITHUB_TOKEN_ENCRYPTION_KEY: z.string().optional(),

  // The GitHub org AssureCode provisions one private repo into per locked
  // contract (settlement-worker's github-provisioner-client). GITHUB_TOKEN
  // above does double duty here: it must be a classic PAT with 'repo' scope
  // generated by an Owner (or repo-creation-permitted member) of this org --
  // no separate org-token variable, to avoid two credentials meaning "the
  // GitHub identity AssureCode itself acts as."
  GITHUB_ORG: z.string().optional(),
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
    // Outside production, surface the raw ZodError rather than the wrapped
    // message above — it names the offending keys.
    return AppConfigSchema.parse(env);
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

// ── Production secret validation ───────────────────────────────
export {
  PLACEHOLDER_SECRET_VALUES,
  isPlaceholderSecret,
  findInsecureSecrets,
  assertProductionSecrets,
} from './secrets.js';
export type { AssertSecretsOptions } from './secrets.js';
