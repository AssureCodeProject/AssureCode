/**
 * @assurecode/api-gateway — Fastify REST + WebSocket BFF.
 *
 * Composition root: builds the Fastify instance, registers plugins and
 * cross-cutting hooks, then wires in each domain's routes from ./routes/.
 * Shared singletons (dbPool, config, eventBus, ledgerClient, route guards,
 * etc.) live in ./context.ts — see its header for why initTracing() runs
 * there rather than here.
 *
 * Task 0.5: Implement Phase-1 endpoints (initialize, generate-tests, lock, escrow)
 * wired to ledger-client with real SHA-256 hashing via Postgres stored procedure.
 *
 * Verify:
 *   curl POST /api/contracts/initialize returns contractId
 *   curl POST /api/contracts/lock returns real hash
 */
import fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { runWithCorrelationId } from '@assurecode/config';
import { config, logger, dbPool, ledgerClient, outboxRelay } from './context.js';
import { type AuthUser } from './middleware/rbac.js';
import { registerAuth } from './middleware/auth.js';
import { MAX_PDF_BYTES } from './middleware/pdf.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPdfRoutes } from './routes/pdf.js';
import { registerKycRoutes } from './routes/kyc.js';
import { registerContractsLifecycleRoutes } from './routes/contracts-lifecycle.js';
import { registerContractsEscrowRoutes } from './routes/contracts-escrow.js';
import { registerContractsAuditRoutes } from './routes/contracts-audit.js';
import { registerContractsChatRoutes } from './routes/contracts-chat.js';
import { registerAuditsRoutes } from './routes/audits.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerNotificationsRoutes } from './routes/notifications.js';

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
registerAuth(server, config.JWT_SECRET, config.SERVICE_TOKEN, dbPool, config.JWT_EXPIRES_IN_SECONDS);

// Needed before any route module registers a `{ websocket: true }` route
// (contracts-chat.ts, audits.ts). Moved up from where it used to sit inline,
// mid-file, right before the chat routes — plugin registration order relative
// to routes on the same instance is what matters, not textual position.
await server.register(fastifyWebsocket);

// ── Routes ───────────────────────────────────────────────────────────────

registerHealthRoutes(server);
registerAuthRoutes(server);
registerPdfRoutes(server);
registerKycRoutes(server);
registerContractsLifecycleRoutes(server);
registerContractsEscrowRoutes(server);
registerContractsAuditRoutes(server);
registerContractsChatRoutes(server);
registerAuditsRoutes(server);
registerWebhookRoutes(server);
registerNotificationsRoutes(server);

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
