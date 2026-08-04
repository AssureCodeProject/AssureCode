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
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import pg from 'pg';
import { ZodError } from 'zod';
import {
  loadConfig,
  createLogger,
  getDatabaseUrl,
  runWithCorrelationId,
  getCorrelationId,
} from '@assurecode/config';
import { LedgerClient } from '@assurecode/ledger-client';
import { OracleStore, TRUST_SCORE_THRESHOLD } from '@assurecode/oracle';
import { createEscrowAdapter, type EscrowPort } from '@assurecode/stripe-adapter';
import { createEventBus, OutboxRelay, InMemoryBus } from '@assurecode/event-bus';
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

// ── Configuration ─────────────────────────────────────────────────────

const config = loadConfig();
const logger = createLogger('api-gateway', config.LOG_LEVEL);

const databaseUrl = getDatabaseUrl(config);
const dbPool = new pg.Pool({ connectionString: databaseUrl });
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


// Use InMemoryBus for Sprint 0; will be RedisStreamsBus in production
const eventBus = createEventBus(config.REDIS_URL) as InMemoryBus;

// Outbox Relay background daemon for zero-loss transactional outbox pumping
const outboxRelay = new OutboxRelay({ databaseUrl, eventBus });
outboxRelay.start();

// ── AI Service Client ──────────────────────────────────────────────────

const aiServiceUrl = `http://localhost:${config.AI_SERVICE_PORT}`;

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

// ── Contract Endpoints ────────────────────────────────────────────────

server.post<{
  Body: InitializeContract;
  Reply: { contractId: string; clientId: string } & InitializeContract;
}>('/api/contracts/initialize', async (request, reply) => {
  return withIdempotency(dbPool, request, reply, async () => {
    const body = InitializeContractSchema.parse(request.body);

    const contractId = `AC-${Date.now().toString(36).toUpperCase()}`;
    const clientId = randomUUID();
    const correlationId = randomUUID();

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
        logger.error({ contractId, status: aiRes.status }, 'ai-service generate-tests failed');
        return {
          statusCode: 502,
          contractId,
          body: {
            contractId,
            testBundleUrl: '',
            testCount: 0,
            generatedAt: new Date().toISOString(),
          } as any,
        };
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
      logger.error({ contractId, err }, 'ai-service generate-tests failed');
      return {
        statusCode: 502,
        contractId,
        body: {
          contractId,
          testBundleUrl: '',
          testCount: 0,
          generatedAt: new Date().toISOString(),
        } as any,
      };
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
    void callAiService('/rag/ingest', {
      contract_id: contractId,
      text: body.requirements,
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

server.post<{
  Params: { contractId: string };
  Reply: { message: string; eventId: string } | { error: string };
}>('/api/contracts/:contractId/simulate-push', async (request, reply) => {
  const { contractId } = request.params;

  const eventId = randomUUID();

  const chain = await ledgerClient.getChain(contractId);
  if (chain.length === 0) {
    return reply.status(404).send({ error: 'Contract not found' });
  }

  await eventBus.publish(
    EVENT_TOPICS.CODE_PUSH_RECEIVED,
    { contractId, repository: 'test-repo', commitSha: 'abc123', eventId },
    eventId,
  );

  logger.info({ contractId, eventId }, 'Simulated GitHub push event');

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
  let res: Record<string, unknown>;
  try {
    const auditRes = await dbPool.query(
      `SELECT payload FROM audit_results
        WHERE contract_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [contractId],
    );
    if (auditRes.rowCount === 0) {
      return reply.status(404).send({ error: `No audit has been run for ${contractId}` });
    }
    res = auditRes.rows[0].payload as Record<string, unknown>;
  } catch (err) {
    request.log.error({ err, contractId }, 'Audit results lookup failed');
    return reply.status(503).send({ error: 'Audit results unavailable' });
  }

  const maintainability = Number(res.maintainability ?? 0);
  const passedTests = Number(res.passedTests ?? 0);
  const totalTests = Number(res.totalTests ?? 0);
  const vulnerabilities = Number(res.vulnerabilities ?? 0);
  const passed = Boolean(
    maintainability >= 10 &&
    passedTests === totalTests &&
    totalTests > 0 &&
    vulnerabilities === 0
  );
  const scanDuration = Number(res.scanDuration ?? 0);

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
    const auditRes = await dbPool.query(
      `SELECT payload FROM audit_results
        WHERE contract_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [contractId],
    );

    if (auditRes.rowCount === 0) {
      return reply.status(409).send({
        error:
          `No audit results recorded for ${contractId}. The trust score is computed from CI ` +
          `telemetry; run the pipeline before requesting a score.`,
      });
    }

    const p = auditRes.rows[0].payload as Record<string, unknown>;
    audit = {
      maintainability: Number(p.maintainability),
      cyclomaticComplexity: Number(p.cyclomaticComplexity),
      passedTests: Number(p.passedTests),
      totalTests: Number(p.totalTests),
      vulnerabilities: Number(p.vulnerabilities),
      criticalVulns: Number(p.criticalVulns ?? 0),
      highVulns: Number(p.highVulns ?? 0),
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

  const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
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
  };

  try {
    const aiRes = await fetch(`${aiServiceUrl}/xai/score`, {
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
  const scopeGuardUrl = process.env.SCOPE_GUARD_URL || 'http://localhost:8001';

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
      escrow:
        escrowRes.rowCount === 0
          ? null
          : {
              paymentIntentId: escrowRes.rows[0].payment_intent_id,
              amountCents: Number(escrowRes.rows[0].amount_cents),
              status: escrowRes.rows[0].status,
              createdAt: new Date(escrowRes.rows[0].created_at).toISOString(),
            },
      settlement:
        settlementRes.rowCount === 0
          ? null
          : {
              status: settlementRes.rows[0].status,
              transferId: settlementRes.rows[0].transfer_id,
              updatedAt: new Date(settlementRes.rows[0].updated_at).toISOString(),
            },
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

void server.register(fastifyWebsocket);

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

  const scopeGuardUrl = process.env.SCOPE_GUARD_URL || 'http://localhost:8001';

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
}>('/api/contracts/:contractId/chat/stream', { websocket: true }, async (connection, request) => {
  const { contractId } = request.params;
  logger.info({ contractId }, 'Chat WebSocket stream opened');

  // BUG-010: Store and call the unsubscribe function when the socket closes to prevent
  // handler accumulation and sending to already-closed sockets.
  const unsubscribe = await eventBus.subscribe(EVENT_TOPICS.SCOPE_CHECKED, async (event: EventEnvelope) => {
    if (event.payload.contractId === contractId) {
      if (connection.socket.readyState === connection.socket.OPEN) {
        connection.socket.send(JSON.stringify(event.payload));
      }
    }
  });

  connection.socket.on('close', () => {
    logger.info({ contractId }, 'Chat WebSocket closed — cleaning up event bus subscription');
    void unsubscribe();
  });
});

// ── Start Server ───────────────────────────────────────────────────────

const start = async () => {
  try {
    const port = config.GATEWAY_PORT || 4000;
    await server.listen({ port, host: '0.0.0.0' });
    logger.info(`API Gateway listening on port ${port}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  await outboxRelay.close();
  await dbPool.end();
  await ledgerClient.close();
  await server.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  await outboxRelay.close();
  await dbPool.end();
  await ledgerClient.close();
  await server.close();
  process.exit(0);
});

if (process.env.NODE_ENV !== 'test') {
  start();
}

export default server;

