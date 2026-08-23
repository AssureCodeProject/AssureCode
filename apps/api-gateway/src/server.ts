/**
 * @assurecode/api-gateway — Fastify REST + WebSocket BFF.
 *
 * Task 0.5: Implement Phase-1 endpoints (initialize, generate-tests, lock, escrow)
 * wired to ledger-client with real SHA-256 hashing via Postgres stored procedure.
 *
 * Verify:
 *   curl POST /api/contracts/initialize returns contractId
 *   curl POST /api/contracts/lock returns real hash
 */

import { initTracing, metrics } from '@assurecode/telemetry';
initTracing('api-gateway');

import fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import { randomUUID, createHash } from 'node:crypto';
import net from 'node:net';
import pg from 'pg';
import { ZodError } from 'zod';
import {
  loadConfig,
  createLogger,
  getDatabaseUrl,
  buildDbConfig,
  runWithCorrelationId,
  getCorrelationId,
  assertProductionSecrets,
} from '@assurecode/config';
import { LedgerClient } from '@assurecode/ledger-client';
import { OracleStore, TRUST_SCORE_THRESHOLD } from '@assurecode/oracle';
import {
  createRazorpayAdapter,
  isLiveRazorpayConfig,
  paymentEntityOf,
  orderEntityOf,
  type PaymentPort,
} from '@assurecode/razorpay-adapter';
import { createKycAdapter, type KycPort } from '@assurecode/kyc-adapter';
import { createEventBus, OutboxRelay, eventBusOptionsFromConfig, provisionTopics, type EventBus } from '@assurecode/event-bus';
import {
  InitializeContractSchema,
  LinkGithubRepoSchema,
  ContractLockedSchema,
  TestsGeneratedSchema,
  EVENT_TOPICS,
  type InitializeContract,
  type ContractLocked,
  type TestsGenerated,
  type EventEnvelope,
} from '@assurecode/shared';
import { withIdempotency } from './middleware/idempotency.js';
import { logSecurityAudit, requireRole, requireKycVerified, type AuthUser } from './middleware/rbac.js';
import { registerAuth, verifyPassword } from './middleware/auth.js';
import { extractPdfText, MAX_PDF_BYTES } from './middleware/pdf.js';

// ── Configuration ─────────────────────────────────────────────────────

const config = loadConfig();
const logger = createLogger('api-gateway', config.LOG_LEVEL);

const databaseUrl = getDatabaseUrl(config);
const dbPool = new pg.Pool(buildDbConfig(databaseUrl));
const ledgerClient = new LedgerClient(databaseUrl);
// Read-only here. The settlement worker owns writing oracle state and acting on
// the verdict; the gateway shares the same `evaluate()` so what the UI shows and
// what releases the money cannot disagree.
const oracleStore = new OracleStore(dbPool);
const razorpayConfig = {
  keyId: config.RAZORPAY_KEY_ID ?? '',
  keySecret: config.RAZORPAY_KEY_SECRET ?? '',
  webhookSecret: config.RAZORPAY_WEBHOOK_SECRET ?? '',
};
const payments: PaymentPort = createRazorpayAdapter(razorpayConfig);

// Identity verification is its own seam. It used to hang off the payment
// adapter because Stripe happened to sell Identity and Connect alongside
// payments; Razorpay sells no equivalent, and KYC was never a payment concern.
const kycAdapter: KycPort = createKycAdapter();

// BUG-013: fail fast in production when the payment provider is not really
// configured.
//
// This asks whether the adapter came out *live*, not whether the env var is
// non-empty. The Kubernetes Secret ships `RAZORPAY_KEY_SECRET: "REPLACE_ME"`,
// which is non-empty and passes a truthiness check — under the previous
// `!config.STRIPE_SECRET_KEY` form, an unconfigured production gateway started
// happily and then silently served the *fake* adapter, because the placeholder
// also failed the `sk_` prefix test inside the factory. A deployment that
// believes it is holding real money while every payment id is synthetic is a
// worse outcome than refusing to boot.
if (config.NODE_ENV === 'production' && !isLiveRazorpayConfig(razorpayConfig)) {
  logger.error(
    'RAZORPAY_KEY_ID (rzp_...) and RAZORPAY_KEY_SECRET are required in production. ' +
      'Refusing to start on the fake payment adapter.',
  );
  process.exit(1);
}

// A dev-default JWT secret or service token in production means every login
// token and every "machine caller" bypass is forgeable by anyone who has
// read this source file. The rule now lives in @assurecode/config so the
// other services get the same guard instead of only this one — it also
// catches the REPLACE_ME placeholders shipped in infra/k8s/.
assertProductionSecrets(config as unknown as Record<string, string | undefined>, [
  'JWT_SECRET',
  'SERVICE_TOKEN',
], { onError: (message) => logger.error(message) });

// BUG-009: Pre-parsed Redis URL used by the /readyz health check.
const redisHealthUrl = (() => {
  try { return config.REDIS_URL ? new URL(config.REDIS_URL) : null; } catch { return null; }
})();

/** TCP-level Redis liveness check — does not issue Redis commands, no side-effects. */
async function pingRedis(): Promise<'ok' | 'error' | 'not_configured'> {
  if (!redisHealthUrl) return 'not_configured';
  return new Promise<'ok' | 'error'>((resolve) => {
    // `require` is not defined in an ES module, so this threw ReferenceError on
    // every call and /readyz answered 500 unconditionally — for a probe whose
    // entire job is to report whether the service is ready. An orchestrator
    // would never have routed traffic here. Static import instead; `net` is a
    // builtin, so there is nothing to defer.
    const socket = net.createConnection(
      { host: redisHealthUrl!.hostname, port: Number(redisHealthUrl!.port || 6379), timeout: 2000 },
      () => { socket.destroy(); resolve('ok'); },
    );
    socket.on('error', () => { socket.destroy(); resolve('error'); });
    socket.on('timeout', () => { socket.destroy(); resolve('error'); });
  });
}

// EVENT_BUS_TYPE selects the backend: 'redis' (default), 'kafka', or 'memory'.
// The old `createEventBus(config.REDIS_URL)` call passed a bare string, which
// the factory only ever resolves to RedisStreamsBus/InMemoryBus — Kafka was
// unreachable from here regardless of what any env var said.
const eventBus: EventBus = createEventBus(eventBusOptionsFromConfig(config));

// Kafka only: create every topic (and its .dlq partner) up front. The gateway
// is the system's first publisher, and under Kafka a publish to a topic nobody
// created yet either fails or silently makes a 1-partition topic that caps the
// consumer group at one worker. Awaited nowhere — a broker that is slow to
// answer must not hold up the listener — but started before the outbox relay,
// which is what begins publishing.
void provisionTopics(eventBus, Object.values(EVENT_TOPICS)).catch((err) => {
  logger.error({ err }, 'event topic provisioning failed; publishes may hit missing topics');
});

// Outbox Relay background daemon for zero-loss transactional outbox pumping
const outboxRelay = new OutboxRelay({ databaseUrl, eventBus });
outboxRelay.start();

// ── Downstream Service Clients ─────────────────────────────────────────

// Both come from @assurecode/config, which defaults them to localhost for
// host-based development and lets compose/k8s override them with service names.
//
// This used to be three variables built two different ways: `aiServiceUrl` was
// `http://localhost:${AI_SERVICE_PORT}` while `scorerUrl` read AI_SERVICE_URL,
// so /match, /generate-tests and /rag/ingest addressed the gateway's own
// loopback in any deployment where ai-service is a separate host — which is
// every deployment except a developer's laptop. The two names also let the same
// service be configured to two different addresses, so a correct AI_SERVICE_URL
// fixed the XAI scorer and left the other three broken. One name, one source.
const aiServiceUrl = config.AI_SERVICE_URL;
const scopeGuardUrl = config.SCOPE_GUARD_URL;

/**
 * Headers for every outbound call to ai-service and scope-guard.
 *
 * Both Python services now require `x-service-token` on everything except their
 * probe endpoints (see apps/ai-service/app/ports/service_auth.py). They used to
 * accept unauthenticated calls from anything that could reach them, which under
 * docker-compose was anything on the network.
 *
 * Built per call rather than hoisted to a constant so the correlation id is the
 * current request's, not the first one the process handled.
 */
function serviceCallHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-correlation-id': getCorrelationId() || randomUUID(),
    'x-service-token': config.SERVICE_TOKEN,
    ...extra,
  };
}

/** Fire-and-forget call to ai-service — logs errors but doesn't block. */
async function callAiService(path: string, body: unknown): Promise<void> {
  const cid = getCorrelationId() || randomUUID();
  try {
    const res = await fetch(`${aiServiceUrl}${path}`, {
      method: 'POST',
      headers: serviceCallHeaders({ 'x-correlation-id': cid }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000), // 10s timeout
    });
    if (!res.ok) {
      logger.warn({ path, status: res.status }, 'ai-service returned non-OK');
    }
  } catch (err) {
    logger.warn({ path, err }, 'ai-service call failed (non-blocking)');
  }
}

/**
 * The most recent audit_results payload for a contract, or null if the CI
 * pipeline has never recorded one. Throws if the lookup itself fails — "we
 * could not ask" is not the same answer as "there is nothing", and the two
 * routes that read this map them to different status codes.
 */
async function latestAuditPayload(contractId: string): Promise<Record<string, unknown> | null> {
  const res = await dbPool.query(
    `SELECT payload FROM audit_results
      WHERE contract_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [contractId],
  );
  if (res.rowCount === 0) return null;
  return res.rows[0].payload as Record<string, unknown>;
}

// ── Server Setup ───────────────────────────────────────────────────────

const server = fastify({
  logger: true,
  disableRequestLogging: config.NODE_ENV === 'test',
});
(server as any).ledgerClient = ledgerClient;

// BUG-008: Restrict CORS origin. Set ALLOWED_ORIGINS (comma-separated) in production.
void server.register(fastifyCors, {
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : config.NODE_ENV === 'production'
      ? 'https://app.assurecode.io'
      : true, // reflect Origin header in development
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-correlation-id', 'idempotency-key', 'x-idempotency-key'],
});

// Same workspace-hoisting type friction as @fastify/jwt (see middleware/auth.ts) —
// registers and runs correctly, cast at the boundary rather than fought.
void server.register(fastifyMultipart as any, {
  limits: { fileSize: MAX_PDF_BYTES, files: 1 },
});

// A webhook is signed over the exact bytes the provider sent, so verification
// needs those bytes — this is true of Razorpay's HMAC as it was of Stripe's.
//
// The webhook route once declared `config: { rawBody: true }`, which is the
// option name `fastify-raw-body` reads — but that plugin is not a dependency of
// this workspace and was never registered, so the flag did nothing. The handler
// fell back to `JSON.stringify(request.body)`, re-serialising the parsed object;
// the HMAC over that can never match the HMAC over the original payload, so
// every genuine webhook was rejected with 401. It went unnoticed because the
// fake adapter is what runs in development.
//
// Captured the same way apps/webhook-ingest already does for GitHub: keep the
// buffer alongside the parsed body, so routes that need to verify a signature
// have the original and everything else is unaffected.
server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
  (req as any).rawBody = body;
  if (body.length === 0) {
    done(null, undefined);
    return;
  }
  try {
    done(null, JSON.parse(body.toString('utf8')));
  } catch (err) {
    // Surfaced as 400 by the error handler below, not 500: malformed JSON is
    // the caller's error.
    (err as any).statusCode = 400;
    done(err as Error, undefined);
  }
});

// A rejected request body is the caller's error, not the server's.
//
// Routes parse their bodies with Zod and let a ZodError propagate. Fastify's
// default handler turns any uncaught throw into HTTP 500, so a request missing
// a required field was reported as an internal server error — which sends the
// caller looking at our logs for a fault that is in their payload, and inflates
// the server-error rate in any benchmark or SLO built on status codes.
server.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) {
    request.log.info({ issues: error.issues }, 'Rejected malformed request body');
    return reply.status(400).send({
      error: 'Invalid request body',
      issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  request.log.error({ err: error }, 'Unhandled error');
  return reply.status(error.statusCode ?? 500).send({
    error: error.statusCode && error.statusCode < 500 ? error.message : 'Internal Server Error',
  });
});

// Correlation ID middleware hook
server.addHook('onRequest', (request, reply, done) => {
  const correlationId =
    (request.headers['x-correlation-id'] as string) || randomUUID();
  request.headers['x-correlation-id'] = correlationId;
  reply.header('x-correlation-id', correlationId);

  runWithCorrelationId(correlationId, () => {
    done();
  });
});

// Global rate limit (plan2.md task 8.5). Registered before auth so that an
// unauthenticated flood is rejected at the limiter rather than after a JWT
// verify and a database round-trip — the point of the limit is to cap work done
// on behalf of an unidentified caller.
//
// Keyed on the authenticated subject when there is one, so a shared NAT egress
// or a proxy does not put every user behind one bucket, and falls back to the
// source IP for the anonymous routes. Health and metrics endpoints are exempt:
// Kubernetes liveness/readiness probes and Prometheus scrape on a fixed
// interval, and a limiter that 429s a probe turns a busy service into a
// restarting one.
//
// Disabled under NODE_ENV=test — the integration suites fire hundreds of
// requests from one address in seconds and would otherwise trip the limit and
// fail for a reason unrelated to what they assert.
// Cast at the boundary for the same workspace-hoisting type friction as
// @fastify/jwt and @fastify/multipart above: the plugin resolves a second copy
// of fastify's types from the hoisted root, so the FastifyInstance it declares
// is structurally distinct from ours. It registers and runs correctly.
void server.register(fastifyRateLimit as any, {
  global: true,
  max: Number(process.env.RATE_LIMIT_MAX ?? 300),
  timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
  keyGenerator: (request: FastifyRequest) => {
    const user = (request as any).user as AuthUser | undefined;
    return user?.userId ?? request.ip;
  },
  enableDraftSpec: true, // RateLimit-* response headers so clients can back off
  allowList: (request: FastifyRequest) => {
    if (config.NODE_ENV === 'test') return true;
    return request.url === '/healthz' || request.url === '/readyz' || request.url === '/metrics';
  },
  errorResponseBuilder: (_request: FastifyRequest, context: { after: string }) => ({
    error: 'Too many requests',
    message: `Rate limit exceeded. Retry in ${context.after}.`,
    statusCode: 429,
  }),
});

// JWT bearer auth (or x-service-token for machine callers) on every route
// except the allow-list inside registerAuth (health/ready/metrics/login/
// webhooks). Registered after the correlation-id hook so a 401 still carries
// one.
registerAuth(server, config.JWT_SECRET, config.SERVICE_TOKEN);

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

// ── Auth Endpoints ───────────────────────────────────────────────────────

// A far tighter bucket than the global one. Login is the only unauthenticated
// route that does credential work, so it is where an online password-guessing
// attempt lands; argon2id verification is also deliberately expensive, which
// makes this endpoint the cheapest way to burn gateway CPU. Keyed on IP because
// there is by definition no authenticated subject yet.
server.post<{
  Body: { email: string; password: string };
}>('/auth/login', {
  config: {
    rateLimit: {
      max: Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 10),
      timeWindow: '1 minute',
      keyGenerator: (request: FastifyRequest) => request.ip,
    },
  },
}, async (request, reply) => {
  const { email, password } = request.body || {};
  if (!email || !password) {
    return reply.status(400).send({ error: 'email and password are required' });
  }

  const res = await dbPool.query(
    `SELECT user_id, email, password_hash, role, display_name, kyc_status, mfa_enabled
       FROM users WHERE email = $1`,
    [email],
  );

  // Same response whether the email is unknown or the password is wrong —
  // distinguishing the two would let a caller enumerate registered emails.
  const invalid = () => reply.status(401).send({ error: 'Invalid email or password' });
  if (res.rowCount === 0) return invalid();

  const row = res.rows[0];
  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) {
    await logSecurityAudit(dbPool, {
      userId: row.user_id,
      action: 'LOGIN_FAILED',
      resource: 'auth',
      ipAddress: request.ip,
      status: 'DENIED',
    });
    return invalid();
  }

  const token = (server as any).jwt.sign({
    sub: row.user_id,
    email: row.email,
    role: row.role,
    kycStatus: row.kyc_status,
    mfaEnabled: row.mfa_enabled,
  });

  await logSecurityAudit(dbPool, {
    userId: row.user_id,
    action: 'LOGIN',
    resource: 'auth',
    ipAddress: request.ip,
    status: 'SUCCESS',
  });

  return reply.send({
    token,
    user: {
      userId: row.user_id,
      email: row.email,
      role: row.role,
      displayName: row.display_name,
    },
  });
});

// JWT is stateless and carries no server-side session to revoke; the client
// discards the token. This route exists for API symmetry and audit logging.
server.post('/auth/logout', async (request, reply) => {
  const user = (request as any).user as AuthUser | undefined;
  if (user) {
    await logSecurityAudit(dbPool, {
      userId: user.userId,
      action: 'LOGOUT',
      resource: 'auth',
      ipAddress: request.ip,
      status: 'SUCCESS',
    });
  }
  return reply.send({ success: true });
});

server.get('/auth/me', async (request, reply) => {
  const user = (request as any).user as AuthUser | undefined;
  if (!user) {
    // Reached only via a valid x-service-token, which has no user identity.
    return reply.send({ authenticated: false, serviceCaller: true });
  }
  // The JWT doesn't carry display_name (it wasn't needed at sign time), so
  // this is the one auth route that reads the database rather than the token.
  const res = await dbPool.query(`SELECT display_name FROM users WHERE user_id = $1`, [user.userId]);
  return reply.send({
    authenticated: true,
    userId: user.userId,
    email: user.email,
    role: user.role,
    kycStatus: user.kycStatus,
    displayName: res.rows[0]?.display_name ?? user.email,
  });
});

// ── PDF Requirements Upload ─────────────────────────────────────────────
//
// Standalone, not tied to a contractId: the client uploads before the form
// is submitted, reviews the extracted text, and only then initializes the
// contract with whatever they approved — see ContractInitialization.jsx.
// "The client must see and approve exactly what gets hashed" (plan F3) is
// why extraction returns text for review rather than silently populating
// `requirements` server-side.
const PDF_TOO_LARGE_ERROR = `File too large (max ${MAX_PDF_BYTES / (1024 * 1024)} MB)`;

server.post('/api/pdf/extract', async (request, reply) => {
  let data;
  try {
    // Same cross-version type friction as the plugin registration above —
    // @fastify/multipart's `request.file()` decorator is real at runtime.
    data = await (request as any).file();
  } catch {
    // @fastify/multipart throws when the stream exceeds `limits.fileSize`.
    return reply.status(413).send({ error: PDF_TOO_LARGE_ERROR });
  }

  if (!data) {
    return reply.status(400).send({ error: 'No file uploaded' });
  }
  if (data.mimetype !== 'application/pdf') {
    return reply.status(400).send({ error: `Expected application/pdf, got ${data.mimetype}` });
  }

  const buffer = await data.toBuffer();
  if (data.file.truncated) {
    return reply.status(413).send({ error: PDF_TOO_LARGE_ERROR });
  }

  try {
    const { text, pageCount, truncated } = await extractPdfText(buffer);
    if (!text.trim()) {
      return reply.status(422).send({ error: 'No extractable text found in this PDF (scanned image? empty document?)' });
    }
    return reply.send({ text, pageCount, truncated });
  } catch (err: any) {
    logger.warn({ err: err.message }, 'PDF extraction failed');
    return reply.status(422).send({ error: 'Could not extract text from this PDF — is it a valid, unencrypted PDF?' });
  }
});

// ── Route guards ──────────────────────────────────────────────────────
//
// requireRole and requireKycVerified were written, exported, and never
// attached to anything — dead code since the day they landed. The gap was not
// theoretical: every contract route was reachable by any authenticated user
// regardless of role, so a freelancer could lock a contract, fund its escrow,
// and request its settlement.
//
// Roles: only a client owns the contract lifecycle. Settlement additionally
// admits 'admin' for dispute resolution.
const clientOnly = { preHandler: requireRole(['client']) };
// Money movement additionally requires a verified identity. Both guards run in
// order, so the role failure is reported before the compliance one.
const clientVerified = {
  preHandler: [requireRole(['client']), requireKycVerified(dbPool)],
};
const settlementGuards = {
  preHandler: [requireRole(['client', 'admin']), requireKycVerified(dbPool)],
};

// ── Contract Endpoints ────────────────────────────────────────────────

server.post<{
  Body: InitializeContract;
  Reply: { contractId: string; clientId: string } & InitializeContract;
}>('/api/contracts/initialize', async (request, reply) => {
  return withIdempotency(dbPool, request, reply, async () => {
    const body = InitializeContractSchema.parse(request.body);

    // `AC-${Date.now().toString(36)}` alone collides: two contracts initialized
    // in the same millisecond get the same id, and the second one's INSERT
    // below would fail — or worse, silently attach to the first one's ledger.
    // The random suffix makes the identifier unique rather than merely usually
    // unique.
    const contractId = `AC-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;

    // client_id used to be a fresh randomUUID() per contract — it matched no
    // real user, which is why the V012 migration had 114 rows to backfill
    // before it could add the FK. A logged-in client now owns the contract
    // for real; a SERVICE_TOKEN caller (CI harnesses, benchmark scripts) has
    // no user identity, so it falls back to the seeded legacy-client account
    // rather than being blocked entirely.
    const user = (request as any).user as AuthUser | undefined;
    if (user && user.role !== 'client') {
      return {
        statusCode: 403,
        contractId: '',
        body: { error: `Role '${user.role}' cannot initialize a contract` } as any,
      };
    }
    const clientId = user?.userId ?? 'legacy-client';
    const correlationId = randomUUID();

    // Persist contract to database so downstream endpoints can reference it.
    // pdf_raw_text is the full extracted document (POST /api/pdf/extract),
    // stored separately from `requirements` — the client may have trimmed or
    // edited the summary that gets hashed without losing the source text the
    // lock-time RAG ingest uses.
    await dbPool.query(
      `INSERT INTO contracts (contract_id, client_id, title, requirements, pdf_raw_text, budget_cents, deadline, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT')
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId, clientId, body.title, body.requirements, body.pdfRawText ?? null, body.budgetCents, body.deadline],
    );

    logger.info(
      { contractId, clientId, title: body.title },
      'Contract initialized',
    );

    await eventBus.publish(
      EVENT_TOPICS.CONTRACT_INITIALIZED,
      { contractId, clientId, ...body },
      correlationId,
    );

    const resBody = {
      contractId,
      clientId,
      ...body,
    };

    return {
      statusCode: 201,
      contractId,
      body: resBody,
    };
  });
});

server.post<{
  Params: { contractId: string };
  Body: { requirements: string; topK?: number };
}>('/api/contracts/:contractId/match', async (request, reply) => {
  const { contractId } = request.params;
  const { requirements, topK } = request.body || {};

  try {
    const aiRes = await fetch(`${aiServiceUrl}/match`, {
      method: 'POST',
      headers: serviceCallHeaders(),
      body: JSON.stringify({
        requirements: requirements || '',
        top_k: topK || 5,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (aiRes.ok) {
      const data = await aiRes.json();
      return reply.send(data);
    }
  } catch (err) {
    logger.warn({ contractId, err }, 'AI service match unreachable, querying Postgres directly');
  }

  const pgRes = await dbPool.query(`
    SELECT f.freelancer_id, u.display_name, f.trust_score, f.skills, f.hourly_rate_cents
    FROM freelancer_profiles f
    JOIN users u ON u.user_id = f.freelancer_id
    ORDER BY f.trust_score DESC
    LIMIT $1
  `, [topK || 5]);

  const results = pgRes.rows.map((row) => ({
    freelancer_id: row.freelancer_id,
    freelancer_name: row.display_name,
    trust_score: parseFloat(row.trust_score || 0.5),
    score: parseFloat(row.trust_score || 0.5),
    explanation: {
      skill_score: 0.85,
      trust_score: parseFloat(row.trust_score || 0.5),
      history_score: 0.8,
      matched_skills: Array.isArray(row.skills) ? row.skills : [],
    },
    hourly_rate_cents: parseInt(row.hourly_rate_cents || 0, 10),
  }));

  return reply.send({ results, count: results.length });
});

server.post<{
  Params: { contractId: string };
  Body: { freelancerId: string };
}>('/api/contracts/:contractId/assign', clientOnly, async (request, reply) => {
  return withIdempotency(dbPool, request, reply, async () => {
    const { contractId } = request.params;
    const { freelancerId } = request.body || {};

    if (!freelancerId) {
      return {
        statusCode: 400,
        contractId,
        body: { error: 'freelancerId is required' } as any,
      };
    }

    await dbPool.query(
      `UPDATE contracts SET freelancer_id = $1 WHERE contract_id = $2`,
      [freelancerId, contractId],
    );

    logger.info({ contractId, freelancerId }, 'Freelancer assigned to contract');

    await ledgerClient.append(
      contractId,
      'CONTRACT_ASSIGNED',
      { contractId, freelancerId },
    );

    return {
      statusCode: 200,
      contractId,
      body: { contractId, freelancerId, status: 'ASSIGNED' },
    };
  });
});

/**
 * Link a contract to the GitHub repository the freelancer pushes to.
 *
 * This is what makes a real push auditable. apps/webhook-ingest receives a
 * delivery carrying `repository.full_name` and nothing that identifies a
 * contract — GitHub has no idea this platform exists — so without a stored
 * mapping it cannot name the contract the push belongs to, and the audit it
 * would produce has no valid `contract_id` to be filed under.
 *
 * Separate from /assign rather than a field on it, because the two facts change
 * independently: a repository can be re-pointed mid-contract (wrong repo linked,
 * work moved) without re-assigning the freelancer, and a freelancer can be
 * assigned before the repository exists.
 */
server.patch<{
  Params: { contractId: string };
  Body: { githubRepoFullName: string };
}>('/api/contracts/:contractId/github-repo', clientOnly, async (request, reply) => {
  return withIdempotency(dbPool, request, reply, async () => {
    const { contractId } = request.params;
    // Throws ZodError on a URL or a bare repo name, which the global error
    // handler renders as a 400 naming the field.
    const { githubRepoFullName } = LinkGithubRepoSchema.parse(request.body);

    const result = await dbPool.query(
      `UPDATE contracts SET github_repo_full_name = $1 WHERE contract_id = $2
       RETURNING contract_id`,
      [githubRepoFullName, contractId],
    );

    // An UPDATE that matches nothing is not an error to Postgres, so without
    // this a typo'd contract id reports success and the failure only surfaces
    // on a push weeks later, as a repository that appears linked but is not.
    if (result.rowCount === 0) {
      return {
        statusCode: 404,
        contractId,
        body: { error: 'Not Found', message: `No contract ${contractId}` } as any,
      };
    }

    logger.info({ contractId, githubRepoFullName }, 'GitHub repository linked to contract');

    await ledgerClient.append(contractId, 'CONTRACT_REPO_LINKED', {
      contractId,
      githubRepoFullName,
    });

    return {
      statusCode: 200,
      contractId,
      body: { contractId, githubRepoFullName },
    };
  });
});

/**
 * Guard for routes that name a `userId` in the request rather than deriving it
 * from the session.
 *
 * A `userId` taken from a body or a path parameter is caller-controlled, so
 * without this every such route acts on whatever account it is handed. This
 * was written inline for /api/kyc/verify — where the consequence was that any
 * authenticated user could set kyc_status = 'VERIFIED' on any account and
 * clear the compliance gate on escrow — and the two sibling KYC routes had no
 * equivalent check at all. Sharing it means the next route that takes a
 * `userId` gets the same answer instead of a fourth variation.
 *
 * You may act on yourself; an admin may act on anyone; a service caller acts
 * on behalf of the platform and has no user identity to compare against.
 *
 * Returns true when the request was rejected, so callers `return` on true.
 */
async function denyIfNotSelfOrAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  targetUserId: string,
  auditAction: string,
  message: string,
): Promise<boolean> {
  if ((request as any).isServiceCaller === true) return false;

  const caller = (request as any).user as AuthUser | undefined;
  if (!caller) return false;
  if (caller.role === 'admin' || caller.userId === targetUserId) return false;

  await logSecurityAudit(dbPool, {
    userId: caller.userId,
    action: auditAction,
    resource: `kyc:${targetUserId}`,
    ipAddress: request.ip,
    status: 'DENIED',
  });
  await reply.status(403).send({ error: 'Forbidden', message });
  return true;
}

server.post<{
  Body: { userId: string; idType: 'PASSPORT' | 'DRIVERS_LICENSE' | 'NATIONAL_ID' };
}>('/api/kyc/verify', async (request, reply) => {
  const { userId, idType } = request.body || {};
  if (!userId || !idType) {
    return reply.status(400).send({ error: 'userId and idType are required' });
  }

  if (
    await denyIfNotSelfOrAdmin(
      request,
      reply,
      userId,
      'KYC_VERIFY_DENIED',
      'You can only run identity verification for your own account.',
    )
  ) {
    return;
  }

  // kyc_verifications.user_id is a foreign key onto users(user_id), and
  // `ON CONFLICT DO NOTHING` does not absorb a foreign-key violation — only a
  // uniqueness one. A userId with no users row therefore raised 23503 out of
  // the INSERT below, escaped the handler, and answered 500. Checking first
  // turns an unhandled crash into the 404 it always was, which matters most
  // for freelancers: this route is how they clear the KYC gate, and a 500 gave
  // them nothing to act on.
  const userExists = await dbPool.query(`SELECT 1 FROM users WHERE user_id = $1`, [userId]);
  if (userExists.rowCount === 0) {
    return reply.status(404).send({ error: 'User not found' });
  }

  const session = await kycAdapter.createVerificationSession({
    userId,
    returnUrl: `${config.WEB_APP_URL}/kyc-callback`,
  });

  const docHash = `hash_${randomUUID().slice(0, 8)}`;

  await dbPool.query(
    `INSERT INTO kyc_verifications (user_id, id_type, id_status, document_hash, aml_sanctions_checked, verified_at)
     VALUES ($1, $2, 'APPROVED', $3, true, now())
     ON CONFLICT DO NOTHING`,
    [userId, idType, docHash],
  );

  await dbPool.query(
    `UPDATE users SET kyc_status = 'VERIFIED' WHERE user_id = $1`,
    [userId],
  );

  await logSecurityAudit(dbPool, {
    userId,
    action: 'KYC_VERIFIED',
    resource: `kyc:${session.sessionId}`,
    ipAddress: request.ip,
    status: 'SUCCESS',
  });

  return reply.send({
    success: true,
    sessionId: session.sessionId,
    verificationUrl: session.url,
    kycStatus: 'VERIFIED',
    amlSanctionsChecked: true,
  });
});

server.get<{
  Params: { userId: string };
}>('/api/kyc/status/:userId', async (request, reply) => {
  const { userId } = request.params;

  // This route had no ownership check at all, so any authenticated user could
  // read any other account's email, role, KYC status and identity-document
  // type by walking user IDs. Reading is less damaging than the write on
  // /api/kyc/verify, but it is still someone else's compliance record.
  if (
    await denyIfNotSelfOrAdmin(
      request,
      reply,
      userId,
      'KYC_STATUS_READ_DENIED',
      'You can only read the verification status of your own account.',
    )
  ) {
    return;
  }

  const res = await dbPool.query(
    `SELECT user_id, kyc_status, mfa_enabled, role, display_name FROM users WHERE user_id = $1`,
    [userId],
  );
  if (res.rows.length === 0) {
    return reply.status(404).send({ error: 'User not found' });
  }
  const kycRes = await dbPool.query(
    `SELECT id_type, id_status, aml_sanctions_checked, verified_at FROM kyc_verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return reply.send({
    user: res.rows[0],
    verification: kycRes.rows[0] || null,
  });
});

server.post<{
  Body: { userId: string; email: string };
}>('/api/kyc/connect-onboarding', async (request, reply) => {
  const { userId, email } = request.body || {};
  if (!userId) {
    return reply.status(400).send({ error: 'userId is required' });
  }

  // Same caller-controlled `userId` problem the sibling routes had: without
  // this, any authenticated user could open a payout-account onboarding flow
  // in someone else's name.
  if (
    await denyIfNotSelfOrAdmin(
      request,
      reply,
      userId,
      'CONNECT_ONBOARDING_DENIED',
      'You can only start payout onboarding for your own account.',
    )
  ) {
    return;
  }

  // Same 404-before-500 reasoning as /api/kyc/verify: this is the freelancer's
  // payout-onboarding entry point, and it should not answer 500 for an unknown
  // account.
  const userExists = await dbPool.query(`SELECT 1 FROM users WHERE user_id = $1`, [userId]);
  if (userExists.rowCount === 0) {
    return reply.status(404).send({ error: 'User not found' });
  }

  const account = await kycAdapter.createPayoutAccount({
    userId,
    email: email || 'user@assurecode.io',
  });
  const link = await kycAdapter.createPayoutOnboardingLink({
    accountId: account.accountId,
    // Hardcoded to localhost:3000 before, so every deployed environment sent
    // the user to their own machine.
    refreshUrl: `${config.WEB_APP_URL}/connect/refresh`,
    returnUrl: `${config.WEB_APP_URL}/connect/return`,
  });
  return reply.send({
    accountId: account.accountId,
    onboardingUrl: link.url,
  });
});

// ── Test Generation ─────────────────────────────────────────────────────

/**
 * What /generate-tests answers with when ai-service cannot produce a bundle.
 * `stub: true` is the honest marker: HTTP 200 with an empty bundle would
 * otherwise read as "zero tests were generated for these requirements".
 */
function stubGeneratedTests(contractId: string): { statusCode: number; contractId: string; body: any } {
  return {
    statusCode: 200,
    contractId,
    body: {
      contractId,
      testBundleUrl: '',
      testCount: 0,
      generatedAt: new Date().toISOString(),
      stub: true,
    } as any,
  };
}

server.post<{
  Params: { contractId: string };
  Body: { title: string; requirements: string; framework?: string };
  Reply:
  | {
    contractId: string;
    testBundleUrl: string;
    testCount: number;
    generatedAt: string;
  }
  | { error: string; retryAfter: number };
}>('/api/contracts/:contractId/generate-tests', async (request, reply) => {
  return withIdempotency(dbPool, request, reply, async () => {
    const { contractId } = request.params;
    const { title, requirements, framework } = request.body || {};
    const correlationId = randomUUID();

    logger.info({ contractId }, 'Generating tests via ai-service');

    try {
      const aiRes = await fetch(`${aiServiceUrl}/generate-tests`, {
        method: 'POST',
        headers: serviceCallHeaders(),
        body: JSON.stringify({
          contract_id: contractId,
          title: title || 'untitled',
          requirements: requirements || '',
          framework: framework || 'jest',
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (aiRes.status === 503) {
        const retryAfterHeader = aiRes.headers.get('retry-after');
        const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) || 5 : 5;

        // 503 and a Retry-After, not 202 and a job id.
        //
        // This branch used to insert a row into `jobs` with status 'queued' and
        // hand back a pollUrl. No worker ever transitioned those rows — there
        // was no `UPDATE jobs` anywhere in the repo — so the poll endpoint
        // answered 'queued' forever and the caller waited on work that was
        // never going to start. Saying "unavailable, try again" is the truth;
        // saying "queued" was not.
        logger.warn(
          { contractId, retryAfter },
          'ai-service has no LLM available for test generation; asking the caller to retry',
        );
        return {
          statusCode: 503,
          contractId,
          body: {
            error:
              'Test generation is temporarily unavailable: the AI service has no LLM ' +
              'provider configured or reachable. Retry after the interval below.',
            retryAfter,
          },
        };
      }

      if (!aiRes.ok) {
        logger.warn({ contractId, status: aiRes.status }, 'ai-service generate-tests unavailable, returning stub response');
        return stubGeneratedTests(contractId);
      }

      const genRaw = (await aiRes.json()) as {
        contract_id: string;
        s3_key: string;
        s3_url: string;
        test_count: number;
        framework: string;
        generated_at: string;
      };

      const genData: TestsGenerated = {
        contractId: genRaw.contract_id,
        s3Key: genRaw.s3_key,
        s3Url: genRaw.s3_url,
        testCount: genRaw.test_count,
        framework: genRaw.framework,
        generatedAt: genRaw.generated_at,
      };

      TestsGeneratedSchema.parse(genData);

      await ledgerClient.appendWithOutbox(
        contractId,
        'TESTS_GENERATED',
        {
          s3Key: genData.s3Key,
          s3Url: genData.s3Url,
          testCount: genData.testCount,
          framework: genData.framework,
        },
        EVENT_TOPICS.TESTS_GENERATED,
        {
          ...genData,
        },
        correlationId,
      );

      return {
        statusCode: 200,
        contractId,
        body: {
          contractId,
          testBundleUrl: genData.s3Url,
          testCount: genData.testCount,
          generatedAt: genData.generatedAt,
        },
      };
    } catch (err) {
      logger.warn({ contractId, err }, 'ai-service generate-tests unreachable, returning stub response');
      return stubGeneratedTests(contractId);
    }
  });
});

server.post<{
  Params: { contractId: string };
  Body: InitializeContract;
  Reply: ContractLocked;
}>('/api/contracts/:contractId/lock', clientOnly, async (request, reply) => {
  return withIdempotency(dbPool, request, reply, async () => {
    const { contractId } = request.params;
    const body = InitializeContractSchema.parse(request.body);
    const correlationId = randomUUID();

    const ledgerRow = await ledgerClient.appendWithOutbox(
      contractId,
      'CONTRACT_LOCKED',
      {
        title: body.title,
        requirements: body.requirements,
        budgetCents: body.budgetCents,
        deadline: body.deadline,
      },
      EVENT_TOPICS.CONTRACT_LOCKED,
      {
        contractId,
        title: body.title,
        budgetCents: body.budgetCents,
        deadline: body.deadline,
      },
      correlationId,
    );

    const lockedPayload: ContractLocked = {
      contractId,
      hash: ledgerRow.currentHash,
      timestamp: ledgerRow.createdAt,
      title: body.title,
      budgetCents: body.budgetCents,
      deadline: body.deadline,
    };

    ContractLockedSchema.parse(lockedPayload);

    logger.info(
      { contractId, hash: ledgerRow.currentHash },
      'Contract locked to ledger',
    );

    // Fire-and-forget: ingest contract text into RAG store for scope checking.
    // Prefer the full extracted PDF text over the (possibly trimmed) summary
    // in `requirements` — it gives the scope guard's retrieval real material
    // to match against instead of a one-line brief.
    let ragText = body.requirements;
    try {
      const pdfRes = await dbPool.query(`SELECT pdf_raw_text FROM contracts WHERE contract_id = $1`, [contractId]);
      const pdfRawText = pdfRes.rows[0]?.pdf_raw_text as string | null | undefined;
      if (pdfRawText && pdfRawText.trim()) ragText = pdfRawText;
    } catch (err) {
      logger.warn({ contractId, err }, 'Failed to read pdf_raw_text for RAG ingest, using requirements');
    }
    void callAiService('/rag/ingest', {
      contract_id: contractId,
      text: ragText,
      target_chars: 512,
      overlap_chars: 64,
    });

    return {
      statusCode: 200,
      contractId,
      body: lockedPayload,
    };
  });
});

/**
 * Record a money-movement event in the audit log.
 *
 * This table has never contained a row. The insert it replaces named a
 * `correlation_id` column the table did not have and omitted `payment_intent_id`,
 * which was NOT NULL with no default, so every call raised 42703 straight into
 * a catch block that logged and continued. V014 adds the missing columns and
 * relaxes the constraint; this helper is the single writer.
 *
 * Failures are still swallowed — an audit write must not fail a payment that
 * already happened — but they are logged loudly enough to notice.
 *
 * Returns whether a row was actually inserted, which doubles as the webhook
 * dedupe gate. The unique index on `provider_event_id` means a redelivery
 * conflicts and inserts nothing, so `false` says "this exact provider event has
 * been seen before" atomically, with no read-then-write race. A `false` for an
 * event with no provider id (our own routes, or a failed insert) is treated as
 * "do not skip" by the only caller that checks.
 */
async function recordPaymentEvent(params: {
  contractId: string;
  eventType: string;
  amountMinor: number;
  orderId?: string | null;
  paymentId?: string | null;
  providerEventId?: string | null;
  payload: Record<string, unknown>;
}): Promise<{ inserted: boolean }> {
  try {
    const res = await dbPool.query(
      `INSERT INTO payment_events
         (order_id, payment_id, contract_id, event_type, amount_cents, payload,
          correlation_id, provider_event_id, provider, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'razorpay', NOW())
       -- The WHERE clause is not optional. idx_payment_events_provider_event is
       -- a *partial* unique index, and Postgres will only infer a partial index
       -- as the conflict arbiter when the statement repeats its predicate.
       -- Without it every insert raised 42P10 (infer_arbiter_indexes) straight
       -- into the catch below — which is the precise failure mode this function
       -- was written to fix, so it is worth naming: a swallowed audit write
       -- leaves no trace except an empty table.
       ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING
       RETURNING event_id`,
      [
        params.orderId ?? null,
        params.paymentId ?? null,
        params.contractId,
        params.eventType,
        params.amountMinor,
        JSON.stringify(params.payload),
        getCorrelationId() || null,
        params.providerEventId ?? null,
      ],
    );
    return { inserted: res.rowCount === 1 };
  } catch (auditErr) {
    logger.error(
      { contractId: params.contractId, eventType: params.eventType, auditErr },
      'Failed to record payment event',
    );
    return { inserted: false };
  }
}

/**
 * Fund a contract's escrow.
 *
 * Creates a Razorpay *order*, which is what Checkout opens against. No money is
 * involved yet and no payment exists — the customer creates that by paying. The
 * order is created with `payment_capture: 0` inside the adapter, so when they
 * do, the payment settles at `authorized`: held, not taken. That is the escrow.
 *
 * Amounts are in the currency's minor unit (paise for INR), which is what
 * Razorpay expects and what `escrow.amount_cents` has always stored.
 */
server.post<{
  Params: { contractId: string };
  Body: { amountCents?: number; amountMinor?: number; currency?: string };
  Reply: {
    contractId: string;
    orderId: string;
    amountMinor: number;
    currency: string;
    status: string;
    keyId: string;
  };
}>('/api/contracts/:contractId/escrow', clientVerified, async (request, reply) => {
  return withIdempotency(dbPool, request, reply, async () => {
    const { contractId } = request.params;
    // `amountCents` is accepted alongside `amountMinor` because tools/benchmark.js
    // and tools/test_e2e_project_flow.js post it, and both meant minor units all
    // along. Same number, clearer name.
    const amountMinor = request.body.amountMinor ?? request.body.amountCents ?? 0;
    const currency = request.body.currency ?? 'INR';

    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      return {
        statusCode: 400,
        contractId,
        body: { error: 'amountMinor must be a positive integer in the minor unit (paise)' } as any,
      };
    }

    // Reuse an unpaid order rather than minting another one.
    //
    // Without this, every click of "Fund escrow" creates a fresh Razorpay order
    // — the idempotency middleware only dedupes when the caller sends an
    // Idempotency-Key header, and a user retrying after dismissing Checkout
    // sends nothing of the sort. The result would be a pile of orphan orders
    // per contract and a `SELECT ... LIMIT 1` in the oracle picking arbitrarily
    // between them. Matching on amount and currency means a genuine change of
    // intent still gets a new order; the stale one simply lapses unpaid.
    const reusable = await dbPool.query(
      `SELECT order_id, amount_cents, currency, status FROM escrow
        WHERE contract_id = $1 AND status = 'PENDING'
          AND amount_cents = $2 AND currency = $3
        ORDER BY created_at DESC LIMIT 1`,
      [contractId, amountMinor, currency],
    );

    if (reusable.rowCount === 1) {
      const existing = reusable.rows[0];
      logger.info(
        { contractId, orderId: existing.order_id },
        'Reusing the existing unpaid escrow order',
      );
      return {
        statusCode: 200,
        contractId,
        body: {
          contractId,
          orderId: existing.order_id,
          amountMinor: Number(existing.amount_cents),
          currency: existing.currency,
          status: 'created',
          keyId: config.RAZORPAY_KEY_ID ?? '',
        },
      };
    }

    const order = await payments.createOrder({ amountMinor, currency, contractId });

    logger.info(
      { contractId, orderId: order.orderId, amountMinor, currency, status: order.status },
      'Escrow order created',
    );

    await ledgerClient.append(contractId, 'ESCROW_CREATED', {
      orderId: order.orderId,
      amountMinor,
      currency,
      status: order.status,
    });

    // `order_id` is the primary key and is known now; `payment_id` stays NULL
    // until the customer actually pays. That gap is exactly what distinguishes
    // 'PENDING' from 'AUTHORIZED', and why the oracle must not capture on
    // 'PENDING'.
    await dbPool.query(
      `INSERT INTO escrow (order_id, contract_id, amount_cents, currency, status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       ON CONFLICT (order_id) DO NOTHING`,
      [order.orderId, contractId, amountMinor, currency],
    );

    await recordPaymentEvent({
      contractId,
      eventType: 'escrow.created',
      amountMinor,
      orderId: order.orderId,
      payload: { orderId: order.orderId, currency, status: order.status },
    });

    return {
      statusCode: 200,
      contractId,
      body: {
        contractId,
        orderId: order.orderId,
        amountMinor: order.amountMinor,
        currency: order.currency,
        status: order.status,
        // Public key, returned so the browser can open Checkout. Serving it
        // from here rather than baking it into the web bundle keeps one source
        // of truth and makes rotation a restart rather than a rebuild.
        keyId: config.RAZORPAY_KEY_ID ?? '',
      },
    };
  });
});

/**
 * Confirm escrow funding from the Checkout callback.
 *
 * When a payment succeeds, Razorpay hands the browser `razorpay_payment_id`,
 * `razorpay_order_id` and `razorpay_signature` — an HMAC over `orderId|paymentId`
 * keyed by the API key secret. Verifying it here is what lets funding be
 * confirmed without a publicly reachable webhook URL, which matters because
 * Razorpay cannot deliver webhooks to a developer's localhost.
 *
 * The client is not trusted beyond the signature: the order must belong to this
 * contract, and the payment's status is re-read from Razorpay rather than taken
 * from the browser's word. The webhook remains the authoritative confirmation;
 * this is the fast path, and the two converge on the same row.
 */
server.post<{
  Params: { contractId: string };
  Body: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string };
  Reply:
    | { contractId: string; orderId: string; paymentId: string; status: string; amountMinor: number }
    | { error: string; message?: string };
}>('/api/contracts/:contractId/escrow/verify', clientVerified, async (request, reply) => {
  return withIdempotency(dbPool, request, reply, async () => {
    const { contractId } = request.params;
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = request.body || {};

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return {
        statusCode: 400,
        contractId,
        body: {
          error: 'razorpayOrderId, razorpayPaymentId and razorpaySignature are required',
        } as any,
      };
    }

    if (
      !payments.verifyCheckoutSignature({
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        signature: razorpaySignature,
      })
    ) {
      logger.warn(
        { contractId, orderId: razorpayOrderId },
        'Razorpay checkout signature verification failed',
      );
      return { statusCode: 401, contractId, body: { error: 'Invalid signature' } as any };
    }

    // A valid signature proves Razorpay issued this order/payment pair. It does
    // not prove the order belongs to *this* contract — without this check, a
    // client could confirm one contract's escrow using another's genuine
    // payment.
    const escrowRow = await dbPool.query(
      `SELECT contract_id, amount_cents, currency, status FROM escrow WHERE order_id = $1`,
      [razorpayOrderId],
    );
    if (escrowRow.rowCount === 0) {
      return { statusCode: 404, contractId, body: { error: 'Escrow order not found' } as any };
    }
    if (escrowRow.rows[0].contract_id !== contractId) {
      logger.warn(
        { contractId, orderId: razorpayOrderId, actual: escrowRow.rows[0].contract_id },
        'Checkout callback presented an order belonging to a different contract',
      );
      return {
        statusCode: 403,
        contractId,
        body: { error: 'Order does not belong to this contract' } as any,
      };
    }

    // Re-read from Razorpay rather than trusting the browser about state.
    const payment = await payments.fetchPayment(razorpayPaymentId);
    if (payment.status !== 'authorized' && payment.status !== 'captured') {
      return {
        statusCode: 409,
        contractId,
        body: {
          error: 'Payment is not authorized',
          message: `Razorpay reports status '${payment.status}'`,
        } as any,
      };
    }

    // Guarded on 'PENDING' so a repeat call — or a webhook that already landed
    // — cannot move a RELEASED or FAILED escrow backwards.
    const updated = await dbPool.query(
      `UPDATE escrow
          SET status = 'AUTHORIZED', payment_id = $1, authorized_at = COALESCE(authorized_at, NOW())
        WHERE order_id = $2 AND status = 'PENDING'
        RETURNING amount_cents, currency`,
      [razorpayPaymentId, razorpayOrderId],
    );

    if (updated.rowCount === 1) {
      await ledgerClient.append(contractId, 'ESCROW_AUTHORIZED', {
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        amountMinor: Number(updated.rows[0].amount_cents),
        currency: updated.rows[0].currency,
      });

      await recordPaymentEvent({
        contractId,
        eventType: 'escrow.authorized',
        amountMinor: Number(updated.rows[0].amount_cents),
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        payload: { source: 'checkout_callback', status: payment.status },
      });

      await eventBus.publish(
        EVENT_TOPICS.ESCROW_LOCKED,
        {
          contractId,
          orderId: razorpayOrderId,
          paymentId: razorpayPaymentId,
          type: 'payment.authorized',
        },
        getCorrelationId() || randomUUID(),
      );

      logger.info(
        { contractId, orderId: razorpayOrderId, paymentId: razorpayPaymentId },
        'Escrow funded; funds authorized and held',
      );
    } else {
      // Already advanced past PENDING — the webhook won the race. Idempotent
      // by design, so this is a 200, not a conflict.
      logger.info(
        { contractId, orderId: razorpayOrderId, status: escrowRow.rows[0].status },
        'Escrow already confirmed; checkout callback was a no-op',
      );
    }

    return {
      statusCode: 200,
      contractId,
      body: {
        contractId,
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        status: 'AUTHORIZED',
        amountMinor: Number(escrowRow.rows[0].amount_cents),
      },
    };
  });
});

server.post<{
  Params: { contractId: string };
  Body: { freelancerId: string; amountCents: number };
  Reply: { contractId: string; status: string } | { error: string };
}>('/api/contracts/:contractId/settle', settlementGuards, async (request, reply) => {
  return withIdempotency(dbPool, request, reply, async () => {
    const { contractId } = request.params;
    const { freelancerId, amountCents } = request.body ?? ({} as typeof request.body);

    // Validate before publishing, because the failure lands somewhere far worse
    // than here.
    //
    // This route took both fields on trust. A request with an empty body
    // published `freelancerId: undefined` onto the bus; the settlement worker
    // approved the oracle verdict, captured the client's payment, and only then
    // failed inside commitSettlement — where the RFC 8785 canonicalizer
    // correctly refuses `undefined` because JSON.stringify would silently drop
    // it and the hashed payload would not be the payload that was passed.
    //
    // The result was money captured, no ledger entry, and a settlement row left
    // FAILED. A 400 here costs nothing; discovering it after the capture costs
    // a reconciliation.
    if (typeof freelancerId !== 'string' || freelancerId.trim() === '') {
      return {
        statusCode: 400,
        contractId,
        body: { error: 'freelancerId is required and must be a non-empty string' },
      };
    }
    if (!Number.isInteger(amountCents) || (amountCents as number) <= 0) {
      return {
        statusCode: 400,
        contractId,
        body: { error: 'amountCents is required and must be a positive integer' },
      };
    }

    // Idempotency check: has it already been settled?
    //
    // This looked for 'INVOICE', which nothing writes. commitSettlement in the
    // settlement worker appends 'SETTLEMENT_COMPLETED', so the 409 below never
    // fired and a repeat request got 202 "pending_oracle_verification" — only
    // stopped later, and silently, by the worker's own claim guard.
    const chain = await ledgerClient.getChain(contractId);
    const isSettled = chain.some((entry) => entry.actionType === 'SETTLEMENT_COMPLETED');
    if (isSettled) {
      return {
        statusCode: 409,
        contractId,
        body: { error: 'Contract already settled' },
      };
    }

    const correlationId = randomUUID();
    await eventBus.publish(
      EVENT_TOPICS.SETTLEMENT_REQUESTED,
      { contractId, freelancerId, amountCents, requestedAt: new Date().toISOString() },
      correlationId
    );

    logger.info({ contractId, freelancerId, amountCents }, 'Settlement requested via Oracle');

    return {
      statusCode: 202,
      contractId,
      body: {
        contractId,
        status: 'pending_oracle_verification',
      },
    };
  });
});

// ── Razorpay Webhook ────────────────────────────────────────────────────

/**
 * Razorpay's authoritative confirmation of a payment's state.
 *
 * Public by virtue of the `/webhooks/` prefix in the auth plugin's allow-list —
 * the HMAC *is* the authentication here, so a JWT check would only reject a
 * caller that has no way to hold one.
 *
 * Two Razorpay-specific facts shape this handler:
 *
 *   1. The event id is not in the body. Unlike Stripe, Razorpay carries it in
 *      the `x-razorpay-event-id` header, and it is the only stable dedupe key.
 *   2. Deliveries are retried until Razorpay gets a 2xx, so the same event
 *      arrives more than once as a matter of course — not as an anomaly. Every
 *      write below is therefore either guarded on current status or protected
 *      by the unique index on payment_events.provider_event_id.
 *
 * The route answers 200 for anything it has authenticated, including events it
 * does not act on. Answering non-2xx would make Razorpay retry an event we have
 * already handled correctly.
 */
server.post<{
  Reply: { received: boolean } | { error: string };
}>('/webhooks/razorpay', async (request, reply) => {
  const signature = request.headers['x-razorpay-signature'] ?? '';
  const providerEventId = (request.headers['x-razorpay-event-id'] as string) || null;

  // The bytes as Razorpay sent them, captured by the content-type parser above.
  // Re-serialising the parsed body here is what made every real signature fail
  // under the previous provider.
  const rawBody = (request as any).rawBody as Buffer | undefined;
  // `rawBody.length === 0`, not just `!rawBody`: an empty Buffer is truthy, so
  // the bare guard let a zero-byte request through to signature verification
  // and answered 401 "Invalid signature" for what is really a malformed
  // request. Both reject, but only one of them tells the truth about why.
  if (!rawBody || rawBody.length === 0) {
    return reply.status(400).send({ error: 'Empty request body' });
  }

  const verification = await payments.verifyWebhook(rawBody, String(signature));

  if (!verification.valid) {
    logger.warn({ error: verification.error }, 'Razorpay webhook signature verification failed');
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  const event = verification.event!;
  const paymentEntity = paymentEntityOf(event);
  const orderEntity = orderEntityOf(event);

  const paymentId = paymentEntity?.id ? String(paymentEntity.id) : null;
  const orderId = paymentEntity?.order_id
    ? String(paymentEntity.order_id)
    : orderEntity?.id
      ? String(orderEntity.id)
      : null;

  logger.info({ type: event.event, paymentId, orderId, providerEventId }, 'Razorpay webhook verified');

  if (!orderId && !paymentId) {
    return reply.status(200).send({ received: true });
  }

  // Resolve the contract from our own escrow row rather than from the event's
  // notes. Razorpay copies order notes onto a payment inconsistently, and the
  // escrow table is the record we actually wrote.
  const escrowRow = await dbPool.query(
    `SELECT contract_id, order_id, amount_cents, currency, status FROM escrow
      WHERE order_id = $1 OR payment_id = $2
      LIMIT 1`,
    [orderId, paymentId],
  );

  if (escrowRow.rowCount === 0) {
    logger.warn({ orderId, paymentId }, 'Razorpay webhook for an unknown escrow; ignoring');
    return reply.status(200).send({ received: true });
  }

  const contractId: string = escrowRow.rows[0].contract_id;
  const amountMinor = Number(escrowRow.rows[0].amount_cents);
  const correlationId = getCorrelationId() || randomUUID();

  // The dedupe gate, and the reason it comes before any other write: the unique
  // index on provider_event_id means a redelivery conflicts and inserts nothing,
  // so `inserted === false` identifies a repeat atomically. Checking by reading
  // first would race two concurrent deliveries of the same event straight past
  // each other and append the ledger entry twice.
  const audit = await recordPaymentEvent({
    contractId,
    eventType: event.event,
    amountMinor,
    orderId: escrowRow.rows[0].order_id,
    paymentId,
    providerEventId,
    payload: { source: 'webhook', status: paymentEntity?.status ?? null },
  });

  if (providerEventId && !audit.inserted) {
    logger.info(
      { providerEventId, contractId },
      'Razorpay webhook already processed; ignoring redelivery',
    );
    return reply.status(200).send({ received: true });
  }

  if (event.event === 'payment.authorized' || event.event === 'order.paid') {
    const updated = await dbPool.query(
      `UPDATE escrow
          SET status = 'AUTHORIZED', payment_id = $1, authorized_at = COALESCE(authorized_at, NOW())
        WHERE order_id = $2 AND status = 'PENDING'
        RETURNING order_id`,
      [paymentId, escrowRow.rows[0].order_id],
    );

    // Only append to the ledger if this call is what made the transition. The
    // /escrow/verify route may have got there first, and a hash chain with two
    // entries for one event is a chain that misreports what happened.
    if (updated.rowCount === 1) {
      await ledgerClient.append(contractId, 'ESCROW_AUTHORIZED', {
        orderId: escrowRow.rows[0].order_id,
        paymentId,
        amountMinor,
        currency: escrowRow.rows[0].currency,
      });
      // BUG-002: ESCROW_LOCKED, not CONTRACT_LOCKED — payment webhooks must not
      // re-trigger the contract-lock subscriber flow and corrupt ledger state.
      await eventBus.publish(
        EVENT_TOPICS.ESCROW_LOCKED,
        { contractId, orderId: escrowRow.rows[0].order_id, paymentId, type: 'payment.authorized' },
        correlationId,
      );
    }
  } else if (event.event === 'payment.failed') {
    const updated = await dbPool.query(
      `UPDATE escrow SET status = 'FAILED'
        WHERE order_id = $1 AND status IN ('PENDING', 'AUTHORIZED')
        RETURNING order_id`,
      [escrowRow.rows[0].order_id],
    );

    if (updated.rowCount === 1) {
      await ledgerClient.append(contractId, 'ESCROW_EVENT', {
        orderId: escrowRow.rows[0].order_id,
        paymentId,
        type: event.event,
        errorDescription: paymentEntity?.error_description ?? null,
      });
      await eventBus.publish(
        EVENT_TOPICS.ESCROW_LOCKED,
        { contractId, orderId: escrowRow.rows[0].order_id, paymentId, type: 'payment.failed' },
        correlationId,
      );
      logger.warn({ contractId, paymentId }, 'Escrow payment failed; marked FAILED');
    }
  } else if (event.event === 'payment.captured') {
    // The settlement worker captures and writes RELEASED in the same
    // transaction as the ledger entry, so this is confirmation of something
    // already recorded, not a state change to apply.
    logger.info({ contractId, paymentId }, 'Razorpay confirmed capture of released escrow');
  }

  return reply.status(200).send({ received: true });
});

server.get<{
  Params: { contractId: string };
  Reply: {
    contractId: string;
    chain: Array<{
      ledgerId: number;
      actionType: string;
      previousHash: string;
      currentHash: string;
      createdAt: string;
    }>;
  };
}>('/api/contracts/:contractId', async (request, reply) => {
  const { contractId } = request.params;

  const chain = await ledgerClient.getChain(contractId);

  return reply.status(200).send({
    contractId,
    chain: chain.map((row) => ({
      ledgerId: row.ledgerId,
      actionType: row.actionType,
      previousHash: row.previousHash,
      currentHash: row.currentHash,
      createdAt: row.createdAt,
    })),
  });
});

server.get<{
  Params: { contractId: string };
  Reply: { contractId: string; valid: boolean } | { error: string };
}>('/api/contracts/:contractId/verify', async (request, reply) => {
  const { contractId } = request.params;
  const chain = await ledgerClient.getChain(contractId);
  if (chain.length === 0) {
    return reply.status(404).send({ error: 'Contract not found' });
  }

  const valid = await ledgerClient.verifyChain(contractId);
  if (!valid) {
    return reply.status(409).send({ contractId, valid: false });
  }

  return reply.status(200).send({ contractId, valid: true });
});

// ── Merkle root: read and post-quantum signing ──────────────────────────
//
// Until these routes existed, merkle_roots.signature was written only by
// tools/sign_merkle_root.py, run by hand. No service signed anything, so in
// normal operation every root the system produced had a NULL signature while
// the UI footer asserted "NIST ML-DSA POST-QUANTUM SIGNED" for all of them.
// GET /root is what lets the UI make that claim only when it is true.

server.get<{
  Params: { contractId: string };
  Reply:
    | {
        contractId: string;
        rootHash: string;
        leafCount: number;
        maxLedgerId: number | null;
        chainValid: boolean | null;
        signature: {
          signed: boolean;
          algorithm: string | null;
          signedAt: string | null;
          publicKeyFingerprint: string | null;
        };
      }
    | { error: string; reason: 'no-root' | 'no-contract' | 'unavailable' };
}>('/api/contracts/:contractId/root', async (request, reply) => {
  const { contractId } = request.params;

  let chain: Awaited<ReturnType<typeof ledgerClient.getChain>>;
  let root: Awaited<ReturnType<typeof ledgerClient.getRoot>>;
  try {
    chain = await ledgerClient.getChain(contractId);
    root = chain.length === 0 ? null : await ledgerClient.getRoot(contractId);
  } catch (err) {
    // A failed read means we could not establish whether a root exists. Every
    // other answer this route can give — 404, or a signature verdict — is a
    // claim about the ledger, and we have not learned one. Reporting absence
    // from a failed lookup is the specific mistake this catch exists to
    // prevent, and it is the one the UI would render as "ROOT UNSIGNED".
    request.log.error({ err, contractId }, 'Merkle root lookup failed');
    return reply.status(503).send({ error: 'Ledger lookup unavailable', reason: 'unavailable' });
  }

  if (chain.length === 0) {
    return reply
      .status(404)
      .send({ error: `Contract ${contractId} not found`, reason: 'no-contract' });
  }

  if (!root) {
    // Distinct from "unsigned": a contract that has never settled has no root
    // to sign at all, and the UI must be able to tell those apart rather than
    // rendering both as a missing signature.
    return reply.status(404).send({
      error: `No Merkle root sealed for ${contractId} yet. Roots are computed on settlement.`,
      reason: 'no-root',
    });
  }

  const signed = root.signature !== null && root.signature.length > 0;

  return reply.status(200).send({
    contractId,
    rootHash: root.rootHash,
    leafCount: root.leafCount,
    maxLedgerId: root.maxLedgerId,
    chainValid: await ledgerClient.verifyChain(contractId),
    signature: {
      // Derived from the column, never from the fact that a row exists. It must
      // not be possible for this to answer true without signature bytes.
      signed,
      algorithm: signed ? root.signatureAlg : null,
      signedAt: signed ? root.signedAt : null,
      publicKeyFingerprint:
        signed && root.publicKey
          ? createHash('sha256').update(root.publicKey).digest('hex').slice(0, 32)
          : null,
    },
  });
});

server.post<{
  Params: { contractId: string };
  Reply:
    | { contractId: string; signed: true; alreadySigned: boolean; algorithm: string | null; signedAt: string | null }
    | { error: string };
}>('/api/contracts/:contractId/root/sign', async (request, reply) => {
  // Service callers only. A signature is an assertion by the platform about its
  // own ledger; there is no user whose session should be able to mint one.
  if (!(request as unknown as { isServiceCaller?: boolean }).isServiceCaller) {
    return reply.status(403).send({ error: 'Service callers only' });
  }

  const { contractId } = request.params;

  const root = await ledgerClient.getRoot(contractId);
  if (!root) {
    return reply.status(409).send({
      error:
        `No Merkle root recorded for ${contractId}. Compute one first. ` +
        `Refusing to sign a root that does not exist.`,
    });
  }

  if (root.signature && root.signature.length > 0) {
    // computeAndStoreRoot clears the signature whenever the tree changes, so a
    // signature that is still present necessarily covers the current root.
    // Re-signing would be deterministic anyway; skipping the round trip keeps
    // the retry path from paying for a pure-Python ML-DSA signature each time.
    return reply.status(200).send({
      contractId,
      signed: true,
      alreadySigned: true,
      algorithm: root.signatureAlg,
      signedAt: root.signedAt,
    });
  }

  let signed: { algorithm: string; signature_b64: string; public_key_b64: string };
  try {
    const res = await fetch(`${aiServiceUrl}/ledger/sign-root`, {
      method: 'POST',
      headers: serviceCallHeaders(),
      body: JSON.stringify({
        contract_id: contractId,
        root_hash: root.rootHash,
        leaf_count: root.leafCount,
      }),
      // Generous: dilithium-py is pure Python by design (it installs without a
      // toolchain), and ML-DSA-87 signing there is not fast.
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // 503 is propagated verbatim. "No signing key configured" is a distinct
      // operational answer from "the signer failed", and collapsing them is
      // what lets a permanently unsigned ledger read as a transient blip.
      return reply
        .status(res.status === 503 ? 503 : 502)
        .send({ error: `Root signing unavailable: signer returned ${res.status}. ${detail}` });
    }

    signed = (await res.json()) as typeof signed;
  } catch (err) {
    request.log.error({ contractId, err }, 'ML-DSA signer unreachable');
    return reply.status(502).send({ error: 'Root signing unavailable: signer unreachable' });
  }

  const stored = await ledgerClient.storeRootSignature({
    contractId,
    rootHash: root.rootHash,
    leafCount: root.leafCount,
    signature: Buffer.from(signed.signature_b64, 'base64'),
    publicKey: Buffer.from(signed.public_key_b64, 'base64'),
    algorithm: signed.algorithm,
  });

  if (!stored) {
    // The tree moved between the read and the write. Same refusal as
    // tools/sign_merkle_root.py: never write a signature that covers a root the
    // ledger no longer holds.
    return reply.status(409).send({
      error: 'The root changed while it was being signed; nothing was written. Recompute and retry.',
    });
  }

  const after = await ledgerClient.getRoot(contractId);
  return reply.status(200).send({
    contractId,
    signed: true,
    alreadySigned: false,
    algorithm: signed.algorithm,
    signedAt: after?.signedAt ?? null,
  });
});

// ── Audit / CI Endpoints ────────────────────────────────────────────────

// A demo stand-in only, used when the caller supplies no code of their own —
// there is no real freelancer code-submission flow yet, so this route has no
// other source of "what got pushed". Labeled honestly rather than passed off
// as a real submission: ci-worker's processCodePush refuses to run with no
// code at all (`No code supplied`, enforced by its own tests), so silently
// sending nothing — which this route did before — meant the audit pipeline
// could never produce a result through this path, ever, even fully wired up.
const SIMULATED_PUSH_DEMO_CODE = `// Demo push — no real freelancer submission flow exists yet.
function add(a, b) {
  return a + b;
}

module.exports = { add };
`;

server.post<{
  Params: { contractId: string };
  Body: { code?: string };
  Reply: { message: string; eventId: string } | { error: string };
}>('/api/contracts/:contractId/simulate-push', async (request, reply) => {
  const { contractId } = request.params;
  const callerCode = request.body?.code?.trim();
  const code = callerCode || SIMULATED_PUSH_DEMO_CODE;

  const eventId = randomUUID();

  const chain = await ledgerClient.getChain(contractId);
  if (chain.length === 0) {
    return reply.status(404).send({ error: 'Contract not found' });
  }

  // `demo` travels with the event so ci-worker knows to pair the snippet above
  // with its matching suite rather than with the contract's generated tests —
  // which describe the contract's product and would fail against a two-line
  // adder for reasons that say nothing about the code or the pipeline. The
  // flag is what keeps a demo run labelled as one all the way through.
  await eventBus.publish(
    EVENT_TOPICS.CODE_PUSH_RECEIVED,
    { contractId, repository: 'test-repo', commitSha: 'abc123', eventId, code, demo: !callerCode },
    eventId,
  );

  logger.info({ contractId, eventId, codeSource: callerCode ? 'caller-supplied' : 'demo-fallback' }, 'Simulated GitHub push event');

  return reply.status(200).send({
    message: 'GitHub push event simulated',
    eventId,
  });
});

server.get<{
  Params: { contractId: string };
  Reply: {
    maintainability: number;
    passedTests: number;
    totalTests: number;
    vulnerabilities: number;
    passed: boolean;
    scanDuration: number;
  } | { error: string };
}>('/api/audits/:contractId/results', async (request, reply) => {
  const { contractId } = request.params;

  const chain = await ledgerClient.getChain(contractId);
  if (chain.length === 0) {
    return reply.status(404).send({ error: 'Contract not found' });
  }

  // audit_results is the record of what the pipeline measured. This used to
  // reconstruct the numbers by scanning the ledger for an AUDIT_COMPLETED
  // action and, failing that, returned a body of zeros with HTTP 200 — which
  // reads as "maintainability 0, no vulnerabilities" rather than "never ran".
  let payload: Record<string, unknown>;
  try {
    const latest = await latestAuditPayload(contractId);
    if (latest === null) {
      return reply.status(404).send({ error: `No audit has been run for ${contractId}` });
    }
    payload = latest;
  } catch (err) {
    request.log.error({ err, contractId }, 'Audit results lookup failed');
    return reply.status(503).send({ error: 'Audit results unavailable' });
  }

  const maintainability = Number(payload.maintainability ?? 0);
  const passedTests = Number(payload.passedTests ?? 0);
  const totalTests = Number(payload.totalTests ?? 0);
  const vulnerabilities = Number(payload.vulnerabilities ?? 0);
  const passed = Boolean(
    maintainability >= 10 &&
    passedTests === totalTests &&
    totalTests > 0 &&
    vulnerabilities === 0
  );
  const scanDuration = Number(payload.scanDuration ?? 0);

  return reply.status(200).send({
    maintainability,
    passedTests,
    totalTests,
    vulnerabilities,
    passed,
    scanDuration,
  });
});

// ── XAI Trust Score Endpoint (Task 4.4) ──────────────────────────────────

server.get<{
  Params: { contractId: string };
  Reply:
    | {
        contractId: string;
        freelancerId: string;
        trustScore: number;
        criticalVulns: number;
        scopeMeasured: boolean;
        threshold: number;
        // The per-term arithmetic that produced the score. This is the whole
        // interpretability claim, so it is forwarded rather than reduced to a
        // single number the caller has to take on trust.
        terms: Array<{
          name: string;
          value: number;
          weight: number;
          contribution: number;
          justification: string;
        }>;
        // Advisory explanation of trustScore, generated after it's final.
        // Absent when the LLM is unavailable — the score is unaffected either way.
        narrative: string | null;
        telemetry: {
          maintainability: number;
          cyclomaticComplexity: number;
          passedTests: number;
          totalTests: number;
          vulnerabilities: number;
          criticalVulns: number;
          highVulns: number;
        };
        justifications: string[];
        scoredAt: string;
      }
    | { error: string };
}>('/api/contracts/:contractId/score', async (request, reply) => {
  const { contractId } = request.params;
  const chain = await ledgerClient.getChain(contractId);

  if (chain.length === 0) {
    return reply.status(404).send({ error: 'Contract not found' });
  }

  // ── Real telemetry, or no score at all ────────────────────────────────
  //
  // This endpoint used to post a hardcoded telemetry literal to the AI service
  // and fall back to the constant 0.92 whenever that call failed for any
  // reason — including when it succeeded but returned non-2xx. Every contract
  // in the system therefore scored 0.92, and that number reached the
  // specification as a measured result. Objective 4 says the score comes from
  // telemetry, so the absence of telemetry has to be an error, not a default.
  let audit: {
    maintainability: number;
    cyclomaticComplexity: number;
    passedTests: number;
    totalTests: number;
    vulnerabilities: number;
    criticalVulns: number;
    highVulns: number;
  };
  let freelancerId: string;

  try {
    const auditPayload = await latestAuditPayload(contractId);

    if (auditPayload === null) {
      return reply.status(409).send({
        error:
          `No audit results recorded for ${contractId}. The trust score is computed from CI ` +
          `telemetry; run the pipeline before requesting a score.`,
      });
    }

    audit = {
      maintainability: Number(auditPayload.maintainability),
      cyclomaticComplexity: Number(auditPayload.cyclomaticComplexity),
      passedTests: Number(auditPayload.passedTests),
      totalTests: Number(auditPayload.totalTests),
      vulnerabilities: Number(auditPayload.vulnerabilities),
      criticalVulns: Number(auditPayload.criticalVulns ?? 0),
      highVulns: Number(auditPayload.highVulns ?? 0),
    };

    const contractRes = await dbPool.query(
      `SELECT freelancer_id FROM contracts WHERE contract_id = $1`,
      [contractId],
    );
    freelancerId = contractRes.rows[0]?.freelancer_id ?? '';
  } catch (err) {
    request.log.error({ err, contractId }, 'Failed to read audit telemetry');
    return reply.status(503).send({ error: 'Audit telemetry unavailable' });
  }

  if (!freelancerId) {
    return reply.status(409).send({
      error: `Contract ${contractId} has no assigned freelancer, so there is nobody to score.`,
    });
  }

  let scored: {
    trust_score: number;
    justifications: string[];
    critical_vulnerabilities: number;
    scope_measured: boolean;
    terms: Array<{
      name: string;
      value: number;
      weight: number;
      contribution: number;
      justification: string;
    }>;
    // Advisory only — see apps/ai-service/app/routes/xai.py _generate_narrative.
    // Passed through as-is; nothing here reads it. The oracle gate downstream
    // (packages/oracle) evaluates trust_score alone.
    narrative: string | null;
  };

  try {
    const aiRes = await fetch(`${aiServiceUrl}/xai/score`, {
      method: 'POST',
      headers: serviceCallHeaders(),
      body: JSON.stringify({
        contract_id: contractId,
        freelancer_id: freelancerId,
        telemetry: {
          maintainability: audit.maintainability,
          cyclomatic_complexity: Math.max(1, audit.cyclomaticComplexity),
          passed_tests: audit.passedTests,
          total_tests: audit.totalTests,
          total_vulnerabilities: audit.vulnerabilities,
          critical_vulnerabilities: audit.criticalVulns,
          high_vulnerabilities: audit.highVulns,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!aiRes.ok) {
      // Propagate the scorer's own refusal rather than overriding it. A 409
      // from the scorer means it declined to score, and answering that with a
      // number would defeat the point of it having declined.
      const detail = await aiRes.text().catch(() => '');
      request.log.warn({ contractId, status: aiRes.status, detail }, 'XAI scorer declined');
      return reply
        .status(aiRes.status === 409 || aiRes.status === 422 ? aiRes.status : 502)
        .send({ error: `Trust score unavailable: scorer returned ${aiRes.status}. ${detail}` });
    }

    scored = (await aiRes.json()) as typeof scored;
  } catch (err) {
    request.log.error({ contractId, err }, 'XAI scorer unreachable');
    return reply.status(502).send({ error: 'Trust score unavailable: scorer unreachable' });
  }

  const scoredAt = new Date().toISOString();
  const correlationId = randomUUID();

  // narrative is deliberately not part of this payload — it never enters the
  // event bus, never reaches oracle.recordScore, and cannot affect the
  // settlement gate. It is added to the HTTP reply only, below.
  const scorePayload = {
    contractId,
    freelancerId,
    trustScore: scored.trust_score,
    criticalVulns: scored.critical_vulnerabilities,
    justifications: scored.justifications,
    scoredAt,
  };

  await eventBus.publish(EVENT_TOPICS.XAI_SCORED, scorePayload, correlationId);

  return reply.status(200).send({
    ...scorePayload,
    scopeMeasured: scored.scope_measured,
    threshold: TRUST_SCORE_THRESHOLD,
    terms: scored.terms,
    narrative: scored.narrative,
    telemetry: {
      maintainability: audit.maintainability,
      cyclomaticComplexity: audit.cyclomaticComplexity,
      passedTests: audit.passedTests,
      totalTests: audit.totalTests,
      vulnerabilities: audit.vulnerabilities,
      criticalVulns: audit.criticalVulns,
      highVulns: audit.highVulns,
    },
  });
});

// ── Scope Drift (C1) ────────────────────────────────────────────────────
//
// Assess cumulative drift over the contract's recorded scope decisions, then
// anchor the assessment in the Merkle ledger.
//
// The anchoring is the point, and it is why this route exists in the gateway
// rather than inside the scope guard. A scope flag that freezes a payment has
// to be re-derivable in a dispute: the ledger entry binds the decision to the
// contract's genesis hash and to the statistics that produced it, so a later
// reader can recompute rather than take it on trust. It also keeps the RFC 8785
// canonical serializer a single implementation — a Python copy in the scope
// guard could disagree, and a hash chain with two serializers is exactly the
// defect V009 removed.
server.post<{
  Params: { contractId: string };
  Reply: { assessment: Record<string, unknown>; ledgerId: number; currentHash: string } | { error: string };
}>('/api/contracts/:contractId/drift', async (request, reply) => {
  const { contractId } = request.params;

  let assessment: Record<string, unknown>;
  try {
    const res = await fetch(
      `${scopeGuardUrl}/scope/drift/${encodeURIComponent(contractId)}`,
      { headers: serviceCallHeaders(), signal: AbortSignal.timeout(10_000) },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // 409 (nothing recorded yet) and 503 (no calibration set) are both
      // propagated rather than flattened: "there is no sequence to assess" and
      // "there is no calibrated guarantee available" are different answers and
      // the caller must be able to tell them apart.
      return reply
        .status(res.status === 409 || res.status === 503 ? res.status : 502)
        .send({ error: `Drift assessment unavailable: scope guard returned ${res.status}. ${detail}` });
    }

    assessment = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    request.log.error({ err, contractId }, 'Scope guard unreachable for drift assessment');
    return reply.status(502).send({ error: 'Drift assessment unavailable: scope guard unreachable' });
  }

  const ledgerPayload = assessment.ledger_payload as Record<string, unknown> | undefined;
  if (!ledgerPayload) {
    return reply.status(502).send({ error: 'Scope guard returned no ledger payload to anchor' });
  }

  try {
    const row = await ledgerClient.append(contractId, 'SCOPE_DRIFT_ASSESSED', ledgerPayload);
    return reply.status(200).send({
      assessment,
      ledgerId: row.ledgerId,
      currentHash: row.currentHash,
    });
  } catch (err) {
    // The assessment is not returned if it could not be anchored. An
    // unanchored drift flag is an assertion, and the whole claim of this
    // endpoint is that it is evidence.
    request.log.error({ err, contractId }, 'Failed to anchor drift assessment');
    return reply.status(503).send({
      error: 'Drift assessment computed but could not be anchored to the ledger; not returning an unanchored flag.',
    });
  }
});

// ── Settlement Oracle State ─────────────────────────────────────────────
//
// The settlement UI previously rendered five hardcoded "VERIFIED" oracle cards
// from a mock module, so it showed a passing oracle for contracts that had
// never been audited. This is the same verdict the settlement worker acts on —
// `OracleStore.evaluate` — read through the shared package, so the screen and
// the payment cannot disagree.
server.get<{
  Params: { contractId: string };
  Reply:
    | {
        contractId: string;
        freelancerId: string | null;
        approved: boolean;
        threshold: number;
        signals: {
          astPassed: boolean;
          testsPassed: boolean;
          securityPassed: boolean;
          scopePassed: boolean;
          trustScore: number | null;
          criticalVulns: number | null;
        };
        blockers: string[];
        scopeChecks: { allowed: number; rejected: number; total: number };
        escrow: {
          orderId: string;
          paymentId: string | null;
          amountMinor: number;
          currency: string;
          status: string;
          createdAt: string;
          authorizedAt: string | null;
        } | null;
        settlement: { status: string; transferId: string | null; updatedAt: string } | null;
      }
    | { error: string };
}>('/api/contracts/:contractId/oracle', async (request, reply) => {
  const { contractId } = request.params;

  const chain = await ledgerClient.getChain(contractId);
  if (chain.length === 0) {
    return reply.status(404).send({ error: 'Contract not found' });
  }

  try {
    const verdict = await oracleStore.evaluate(contractId);

    const scopeRes = await dbPool.query(
      `SELECT count(*) FILTER (WHERE allowed)     AS allowed,
              count(*) FILTER (WHERE NOT allowed) AS rejected,
              count(*)                            AS total
         FROM scope_checks WHERE contract_id = $1`,
      [contractId],
    );
    const sc = scopeRes.rows[0] ?? {};

    // Any escrow row, not just PENDING: after a capture the row is RELEASED,
    // and the UI needs to be able to say so. It also drives the funding panel —
    // a row at PENDING means an order exists that nobody has paid yet, which is
    // exactly when the UI should offer Checkout.
    const escrowRes = await dbPool.query(
      `SELECT order_id, payment_id, amount_cents, currency, status, created_at, authorized_at
         FROM escrow WHERE contract_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [contractId],
    );
    const settlementRes = await dbPool.query(
      `SELECT status, transfer_id, updated_at FROM settlements WHERE contract_id = $1`,
      [contractId],
    );

    // The settlement UI needs the payee. It used to send the literal 'f_alex'.
    const contractRes = await dbPool.query(
      `SELECT freelancer_id FROM contracts WHERE contract_id = $1`,
      [contractId],
    );

    const escrowRow = escrowRes.rows[0];
    const settlementRow = settlementRes.rows[0];

    return reply.status(200).send({
      contractId,
      freelancerId: contractRes.rows[0]?.freelancer_id ?? null,
      approved: verdict.approved,
      threshold: TRUST_SCORE_THRESHOLD,
      signals: verdict.signals,
      blockers: verdict.blockers,
      scopeChecks: {
        allowed: Number(sc.allowed ?? 0),
        rejected: Number(sc.rejected ?? 0),
        total: Number(sc.total ?? 0),
      },
      escrow: escrowRow
        ? {
            orderId: escrowRow.order_id,
            // NULL until the customer pays — the difference between an order
            // that exists and funds that are actually held.
            paymentId: escrowRow.payment_id ?? null,
            amountMinor: Number(escrowRow.amount_cents),
            currency: escrowRow.currency ?? 'INR',
            status: escrowRow.status,
            createdAt: new Date(escrowRow.created_at).toISOString(),
            authorizedAt: escrowRow.authorized_at
              ? new Date(escrowRow.authorized_at).toISOString()
              : null,
          }
        : null,
      settlement: settlementRow
        ? {
            status: settlementRow.status,
            transferId: settlementRow.transfer_id,
            updatedAt: new Date(settlementRow.updated_at).toISOString(),
          }
        : null,
    });
  } catch (err) {
    // An unreadable oracle is not an approving one, and it is not an empty one
    // either — returning a body of `false` signals would render as a definite
    // rejection rather than as "we could not find out".
    request.log.error({ err, contractId }, 'Oracle state lookup failed');
    return reply.status(503).send({ error: 'Oracle state unavailable' });
  }
});

// ── Chat & Scope Guard Interceptors (Tasks 3.2 & 3.4) ────────────────────

await server.register(fastifyWebsocket);

server.post<{
  Params: { contractId: string };
  Body: { message: string; sender?: string };
  Reply:
  | { delivered: boolean; message: string; sender: string }
  | { delivered: false; blocked: boolean; reason: string; mediation: string }
  | { error: string };
}>('/api/contracts/:contractId/chat', async (request, reply) => {
  const { contractId } = request.params;
  const { message, sender = 'client' } = request.body || {};

  if (!message) {
    return reply.status(400).send({ error: 'Message is required' });
  }

  // No permissive fallback. This used to deliver the message when the guard was
  // unreachable *and* when it answered with any non-2xx — logging "allowing with
  // default check", which is not a check. Two things went wrong at once: an
  // out-of-scope request got through whenever the guard was down, and because
  // the guard is what writes scope_checks, the trust score's adherence term was
  // computed over a history that silently omitted those messages. An
  // unavailable guard is an unavailable guard; say so.
  let checkResult: {
    allowed: boolean;
    similarity_score: number;
    reason: string;
    suggested_mediation?: string;
  };

  try {
    const scopeRes = await fetch(`${scopeGuardUrl}/scope/check`, {
      method: 'POST',
      headers: serviceCallHeaders(),
      body: JSON.stringify({ contract_id: contractId, message, sender }),
      signal: AbortSignal.timeout(5000),
    });

    if (!scopeRes.ok) {
      const detail = await scopeRes.text().catch(() => '');
      logger.warn({ contractId, status: scopeRes.status, detail }, 'Scope Guard declined to check');
      // 409 means the guard has no indexed contract to compare against — a
      // caller-fixable state, so it is propagated rather than flattened to 503.
      return reply.status(scopeRes.status === 409 ? 409 : 503).send({
        error:
          `Message not delivered: the scope guard returned ${scopeRes.status} and the request ` +
          `was therefore never checked. ${detail}`,
      });
    }

    checkResult = (await scopeRes.json()) as typeof checkResult;
  } catch (err) {
    logger.error({ contractId, err }, 'Scope Guard unreachable');
    return reply.status(503).send({
      error:
        'Message not delivered: the scope guard is unreachable, so this request could not be ' +
        'checked against the contract.',
    });
  }

  if (!checkResult.allowed) {
    logger.warn({ contractId, reason: checkResult.reason }, 'Scope Guard intercepted off-scope message');

    const rejectionId = randomUUID();
    await eventBus.publish(
      EVENT_TOPICS.SCOPE_CHECKED,
      {
        contractId,
        message,
        allowed: false,
        reason: checkResult.reason,
        mediation: checkResult.suggested_mediation,
      },
      rejectionId,
    );

    return reply.status(403).send({
      delivered: false,
      blocked: true,
      reason: checkResult.reason,
      mediation: checkResult.suggested_mediation || 'Off-scope change request blocked by automated Scope Guard.',
    });
  }

  const correlationId = randomUUID();
  await eventBus.publish(
    EVENT_TOPICS.SCOPE_CHECKED,
    { contractId, message, allowed: true, sender },
    correlationId,
  );

  return reply.status(200).send({
    delivered: true,
    message,
    sender,
  });
});

server.get<{
  Params: { contractId: string };
}>('/api/contracts/:contractId/chat/stream', { websocket: true }, async (socket, request) => {
  const { contractId } = request.params;
  logger.info({ contractId }, 'Chat WebSocket stream opened');

  // BUG-010: Store and call the unsubscribe function when the socket closes to prevent
  // handler accumulation and sending to already-closed sockets.
  //
  // groupId is unique per connection: this is an ephemeral fan-out tap, not
  // a durable worker. Subscribing under the shared `assurecode-${topic}`
  // default would make it a competing consumer against any real worker on
  // this topic, and the two would fight over partition ownership instead of
  // both receiving every message.
  const unsubscribe = await eventBus.subscribe(
    EVENT_TOPICS.SCOPE_CHECKED,
    async (event: EventEnvelope) => {
      if (event.payload.contractId === contractId) {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(event.payload));
        }
      }
    },
    { groupId: `assurecode-ws-chat-${randomUUID()}` },
  );

  socket.on('close', () => {
    logger.info({ contractId }, 'Chat WebSocket closed — cleaning up event bus subscription');
    void unsubscribe();
  });
});

// The pipeline step each topic completes, in the order the UI renders them.
// Single source of truth for both what the socket subscribes to and what it
// reports — the two used to be separate lists that had to be kept in step by
// hand. AUDIT_COMPLETED closes the run and is handled separately below.
const AUDIT_STREAM_STEP_BY_TOPIC: Record<string, number> = {
  [EVENT_TOPICS.CODE_PUSH_RECEIVED]: 0,
  [EVENT_TOPICS.CI_SANDBOX_READY]: 1,
  [EVENT_TOPICS.CI_AST_COMPLETED]: 2,
  [EVENT_TOPICS.CI_TESTS_COMPLETED]: 3,
  [EVENT_TOPICS.SECURITY_SCAN_COMPLETED]: 4,
};

/** The frame to push for a pipeline topic, or null if the topic says nothing. */
function auditStreamFrame(topic: string, contractId: string): Record<string, unknown> | null {
  if (topic === EVENT_TOPICS.AUDIT_COMPLETED) {
    return { type: 'audit-complete', contractId };
  }
  const stepId = AUDIT_STREAM_STEP_BY_TOPIC[topic];
  if (stepId === undefined) return null;
  return { type: 'step-complete', stepId, contractId };
}

server.get<{
  Params: { contractId: string };
}>('/api/audits/:contractId/stream', { websocket: true }, async (socket, request) => {
  const { contractId } = request.params;
  logger.info({ contractId }, 'Audit WebSocket stream opened');

  const topicsToWatch = [...Object.keys(AUDIT_STREAM_STEP_BY_TOPIC), EVENT_TOPICS.AUDIT_COMPLETED];

  // Same reasoning as the chat stream above: a unique groupId per connection
  // keeps this fan-out tap from competing with ci-worker's real subscription
  // to the same topics.
  const wsConnectionId = randomUUID();

  // Subscribing sequentially (await in a loop) took ~3s per topic to join
  // its Kafka consumer group — ~18s for all 6, well after a fast pipeline
  // run has already finished and published everything. Subscribe to every
  // topic in parallel so the whole set is ready in ~3s, not 6x that.
  const unsubs: Array<() => Promise<void>> = await Promise.all(
    topicsToWatch.map((topic) =>
      eventBus.subscribe(
        topic,
        async (event: EventEnvelope) => {
          if (event.payload.contractId === contractId && socket.readyState === socket.OPEN) {
            const frame = auditStreamFrame(topic, contractId);
            if (frame) {
              socket.send(JSON.stringify(frame));
            }
          }
        },
        { groupId: `assurecode-ws-audit-${wsConnectionId}-${topic}` },
      ),
    ),
  );

  // Tells the client all consumer groups have joined and it's safe to
  // trigger the push — without this, a client that pushes as soon as the
  // socket opens can beat the subscriptions into existence and miss every
  // event a fast pipeline run publishes before they're ready.
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ type: 'ready' }));
  }

  socket.on('close', () => {
    logger.info({ contractId }, 'Audit WebSocket closed — cleaning up event bus subscriptions');
    for (const u of unsubs) void u();
  });
});

// ── Start Server ───────────────────────────────────────────────────────

// tools/seed-users.py writes this exact argon2id hash (password "demo1234")
// onto every demo account it seeds. It refuses to run when NODE_ENV=production
// itself, but that only guards the one call site — this catches the row
// directly, in case the database was seeded some other way (a stale snapshot
// restored into prod, a script run with the wrong env). Defense in depth for
// a hardcoded-credential backdoor, not a substitute for the seed script's own
// guard.
const KNOWN_DEMO_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$QgV5gQdfEGK4QFgZ/vw1+A$uGWPLqOLWrjcqn3fi29MZ7/FEUvFGh/M7cNmLIkQt+U';

async function refuseIfDemoCredentialsInProduction(): Promise<void> {
  if (config.NODE_ENV !== 'production') return;
  const res = await dbPool.query(`SELECT user_id FROM users WHERE password_hash = $1 LIMIT 5`, [
    KNOWN_DEMO_PASSWORD_HASH,
  ]);
  if (res.rowCount && res.rowCount > 0) {
    const ids = res.rows.map((r) => r.user_id).join(', ');
    logger.error(
      `Refusing to start in production: user(s) [${ids}] have the known demo password hash. ` +
        `Rotate their password_hash before deploying.`,
    );
    process.exit(1);
  }
}

async function start(): Promise<void> {
  try {
    await refuseIfDemoCredentialsInProduction();
    const port = config.GATEWAY_PORT || 4000;
    await server.listen({ port, host: '0.0.0.0' });
    logger.info(`API Gateway listening on port ${port}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down...`);
  await outboxRelay.close();
  await dbPool.end();
  await ledgerClient.close();
  await server.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

if (process.env.NODE_ENV !== 'test') {
  start();
}

export { server };
export default server;
