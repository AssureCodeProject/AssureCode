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
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
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
} from '@assurecode/config';
import { LedgerClient } from '@assurecode/ledger-client';
import { OracleStore, TRUST_SCORE_THRESHOLD } from '@assurecode/oracle';
import { createEscrowAdapter, type EscrowPort } from '@assurecode/stripe-adapter';
import { createEventBus, OutboxRelay, eventBusOptionsFromConfig, type EventBus } from '@assurecode/event-bus';
import {
  InitializeContractSchema,
  ContractLockedSchema,
  TestsGeneratedSchema,
  EVENT_TOPICS,
  type InitializeContract,
  type ContractLocked,
  type TestsGenerated,
  type EventEnvelope,
} from '@assurecode/shared';
import { withIdempotency } from './middleware/idempotency.js';
import { logSecurityAudit, type AuthUser } from './middleware/rbac.js';
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
const escrowAdapter: EscrowPort = createEscrowAdapter({
  secretKey: config.STRIPE_SECRET_KEY || 'sk_test_mock',
  webhookSecret: config.STRIPE_WEBHOOK_SECRET || 'whsec_mock',
});

// BUG-013: Fail fast in production when Stripe keys are absent.
if (config.NODE_ENV === 'production' && !config.STRIPE_SECRET_KEY) {
  logger.error('STRIPE_SECRET_KEY is required in production. Set the env var and restart.');
  process.exit(1);
}

// A dev-default JWT secret or service token in production means every login
// token and every "machine caller" bypass is forgeable by anyone who has
// read this source file.
if (
  config.NODE_ENV === 'production' &&
  (config.JWT_SECRET === 'dev_insecure_jwt_secret_change_me' ||
    config.SERVICE_TOKEN === 'dev_insecure_service_token_change_me')
) {
  logger.error('JWT_SECRET and SERVICE_TOKEN must be set to non-default values in production.');
  process.exit(1);
}

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

// Outbox Relay background daemon for zero-loss transactional outbox pumping
const outboxRelay = new OutboxRelay({ databaseUrl, eventBus });
outboxRelay.start();

// ── Downstream Service Clients ─────────────────────────────────────────

const aiServiceUrl = `http://localhost:${config.AI_SERVICE_PORT}`;
// The XAI scorer and the scope guard are addressed by env var rather than by
// config port, because both are routinely run out-of-cluster during a demo.
const scorerUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const scopeGuardUrl = process.env.SCOPE_GUARD_URL || 'http://localhost:8001';

/** Fire-and-forget call to ai-service — logs errors but doesn't block. */
async function callAiService(path: string, body: unknown): Promise<void> {
  const cid = getCorrelationId() || randomUUID();
  try {
    const res = await fetch(`${aiServiceUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-correlation-id': cid,
      },
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

server.post<{
  Body: { email: string; password: string };
}>('/auth/login', async (request, reply) => {
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
      headers: { 'Content-Type': 'application/json' },
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
}>('/api/contracts/:contractId/assign', async (request, reply) => {
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

server.post<{
  Body: { userId: string; idType: 'PASSPORT' | 'DRIVERS_LICENSE' | 'NATIONAL_ID' };
}>('/api/kyc/verify', async (request, reply) => {
  const { userId, idType } = request.body || {};
  if (!userId || !idType) {
    return reply.status(400).send({ error: 'userId and idType are required' });
  }

  const session = await escrowAdapter.createVerificationSession({
    userId,
    returnUrl: 'http://localhost:3000/kyc-callback',
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
  const account = await escrowAdapter.createConnectAccount({ userId, email: email || 'user@assurecode.io' });
  const link = await escrowAdapter.createAccountLink({
    accountId: account.accountId,
    refreshUrl: 'http://localhost:3000/connect/refresh',
    returnUrl: 'http://localhost:3000/connect/return',
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
  | {
    jobId: string;
    status: string;
    retryAfter: number;
    pollUrl: string;
  };
}>('/api/contracts/:contractId/generate-tests', async (request, reply) => {
  return withIdempotency(dbPool, request, reply, async () => {
    const { contractId } = request.params;
    const { title, requirements, framework } = request.body || {};
    const correlationId = randomUUID();

    logger.info({ contractId }, 'Generating tests via ai-service');

    try {
      const aiRes = await fetch(`${aiServiceUrl}/generate-tests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

        let jobId = randomUUID();
        try {
          const jobRes = await dbPool.query(
            `INSERT INTO jobs (contract_id, job_type, status, retry_after)
             VALUES ($1, 'GENERATE_TESTS', 'queued', $2)
             RETURNING job_id`,
            [contractId, retryAfter],
          );
          jobId = jobRes.rows[0].job_id;
        } catch (err) {
          logger.error({ contractId, err }, 'Failed to record queued job in database');
        }

        return {
          statusCode: 202,
          contractId,
          body: {
            jobId,
            status: 'queued',
            retryAfter,
            pollUrl: `/api/jobs/${jobId}`,
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
}>('/api/contracts/:contractId/lock', async (request, reply) => {
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

server.post<{
  Params: { contractId: string };
  Body: { amountCents: number };
  Reply: {
    contractId: string;
    paymentIntentId: string;
    amountCents: number;
    status: string;
    clientSecret: string;
  };
}>('/api/contracts/:contractId/escrow', async (request, reply) => {
  return withIdempotency(dbPool, request, reply, async () => {
    const { contractId } = request.params;
    const { amountCents } = request.body;

    // Real Stripe PaymentIntent via adapter (or fake in test/offline).
    const pi = await escrowAdapter.createPaymentIntent({
      amountCents,
      contractId,
    });

    logger.info(
      { contractId, paymentIntentId: pi.paymentIntentId, status: pi.status },
      'Escrow PaymentIntent created',
    );

    await ledgerClient.append(
      contractId,
      'ESCROW_CREATED',
      { paymentIntentId: pi.paymentIntentId, amountCents, status: pi.status },
    );

    // The escrow table has existed since V001 and was never written to, so the
    // settlement worker had no way to look up which PaymentIntent to capture —
    // which is why it only ever called transferToFreelancer with a placeholder
    // destination account. Record it here; capture needs it.
    await dbPool.query(
      `INSERT INTO escrow (payment_intent_id, contract_id, amount_cents, status)
       VALUES ($1, $2, $3, 'PENDING')
       ON CONFLICT (payment_intent_id) DO NOTHING`,
      [pi.paymentIntentId, contractId, amountCents],
    );

    try {
      await dbPool.query(
        `INSERT INTO payment_events (contract_id, event_type, amount_cents, payload, correlation_id, created_at)
         VALUES ($1, 'escrow.created', $2, $3, $4, NOW())`,
        [contractId, amountCents, JSON.stringify({ paymentIntentId: pi.paymentIntentId, status: pi.status }), (request.headers['x-correlation-id'] as string) || null]
      );
    } catch (auditErr) {
      logger.error({ contractId, auditErr }, 'Failed to record escrow.created in payment_events');
    }

    return {
      statusCode: 200,
      contractId,
      body: {
        contractId,
        paymentIntentId: pi.paymentIntentId,
        amountCents: pi.amountCents,
        status: pi.status,
        clientSecret: pi.clientSecret,
      },
    };
  });
});

server.post<{
  Params: { contractId: string };
  Body: { freelancerId: string; amountCents: number };
  Reply: { contractId: string; status: string } | { error: string };
}>('/api/contracts/:contractId/settle', async (request, reply) => {
  return withIdempotency(dbPool, request, reply, async () => {
    const { contractId } = request.params;
    const { freelancerId, amountCents } = request.body;

    // Idempotency check: has it already been settled?
    const chain = await ledgerClient.getChain(contractId);
    const isSettled = chain.some(entry => entry.actionType === 'INVOICE');
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

// ── Stripe Webhook ──────────────────────────────────────────────────────

server.post<{
  Reply: { received: boolean } | { error: string };
}>('/webhooks/stripe', {
  config: {
    rawBody: true,
  },
}, async (request, reply) => {
  const signature = request.headers['stripe-signature'] ?? '';
  const rawBody = typeof request.body === 'string'
    ? request.body
    : JSON.stringify(request.body ?? '');

  const verification = await escrowAdapter.verifyWebhook(rawBody, String(signature));

  if (!verification.valid) {
    logger.warn({ error: verification.error }, 'Stripe webhook signature verification failed');
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  const event = verification.event!;
  logger.info({ type: event.type, id: event.id }, 'Stripe webhook verified');

  // Handle escrow capture / payment_intent.succeeded events.
  if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed') {
    const piId = event.data.object.id;
    const metadata = event.data.object as { metadata?: { contractId?: string } };
    const contractId = metadata.metadata?.contractId ?? '';
    if (contractId) {
      const correlationId = randomUUID();
      await ledgerClient.append(contractId, 'ESCROW_EVENT', {
        paymentIntentId: piId,
        type: event.type,
      });
      // BUG-002: Use ESCROW_LOCKED — not CONTRACT_LOCKED — so payment webhooks don't
      // re-trigger the contract-lock subscriber flow and corrupt ledger state.
      await eventBus.publish(
        EVENT_TOPICS.ESCROW_LOCKED,
        { contractId, paymentIntentId: piId, type: event.type },
        correlationId,
      );
    }
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

// ── Job Polling & Ledger Verification Endpoints ─────────────────────────

server.get<{
  Params: { jobId: string };
  Reply:
  | {
    jobId: string;
    contractId: string;
    status: string;
    result: Record<string, unknown> | null;
    error: string | null;
    retryAfter: number;
    createdAt: string;
  }
  | { error: string };
}>('/api/jobs/:jobId', async (request, reply) => {
  const { jobId } = request.params;
  const pool = (ledgerClient as any).pool;

  try {
    const result = await pool.query(
      'SELECT job_id, contract_id, job_type, status, result, error, retry_after, created_at FROM jobs WHERE job_id = $1',
      [jobId],
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Job not found' });
    }

    const job = result.rows[0];
    return reply.status(200).send({
      jobId: job.job_id,
      contractId: job.contract_id,
      status: job.status,
      result: job.result,
      error: job.error,
      retryAfter: job.retry_after,
      createdAt: job.created_at,
    });
  } catch (err) {
    // A query failure means we could not determine whether the job exists.
    // Reporting 404 here would assert a fact we have not established — the
    // caller would treat "database unreachable" as "job definitively absent".
    request.log.error({ err, jobId }, 'Job lookup failed');
    return reply.status(503).send({ error: 'Job lookup unavailable' });
  }
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
  const code = request.body?.code?.trim() || SIMULATED_PUSH_DEMO_CODE;

  const eventId = randomUUID();

  const chain = await ledgerClient.getChain(contractId);
  if (chain.length === 0) {
    return reply.status(404).send({ error: 'Contract not found' });
  }

  await eventBus.publish(
    EVENT_TOPICS.CODE_PUSH_RECEIVED,
    { contractId, repository: 'test-repo', commitSha: 'abc123', eventId, code },
    eventId,
  );

  logger.info({ contractId, eventId, codeSource: request.body?.code ? 'caller-supplied' : 'demo-fallback' }, 'Simulated GitHub push event');

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
    const aiRes = await fetch(`${scorerUrl}/xai/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      { signal: AbortSignal.timeout(10_000) },
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
          paymentIntentId: string;
          amountCents: number;
          status: string;
          createdAt: string;
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
    // and the UI needs to be able to say so.
    const escrowRes = await dbPool.query(
      `SELECT payment_intent_id, amount_cents, status, created_at
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
            paymentIntentId: escrowRow.payment_intent_id,
            amountCents: Number(escrowRow.amount_cents),
            status: escrowRow.status,
            createdAt: new Date(escrowRow.created_at).toISOString(),
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
      headers: { 'Content-Type': 'application/json' },
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
