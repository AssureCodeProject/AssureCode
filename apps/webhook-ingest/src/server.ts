import { initTracing, metrics } from '@assurecode/telemetry';
initTracing('webhook-ingest');

import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import {
  loadConfig,
  runWithCorrelationId,
  assertProductionSecrets,
  getDatabaseUrl,
  buildDbConfig,
} from '@assurecode/config';
import { createEventBus, eventBusOptionsFromConfig } from '@assurecode/event-bus';
import { EVENT_TOPICS } from '@assurecode/shared';

const config = loadConfig();
const fastify = Fastify({
  logger: { level: config.LOG_LEVEL || 'info' },
});

// The signature check below is only as good as this secret. It used to fall
// back to a literal published in this repository, so a production deploy that
// forgot the env var would accept any push event an attacker cared to sign —
// and would look completely healthy doing it. Refuse to boot instead.
assertProductionSecrets(config as unknown as Record<string, string | undefined>, [
  'GITHUB_WEBHOOK_SECRET',
], { onError: (message) => fastify.log.error(message) });

const eventBus = createEventBus(eventBusOptionsFromConfig(config));
const GITHUB_WEBHOOK_SECRET = config.GITHUB_WEBHOOK_SECRET;

// A delivery from GitHub identifies a repository and nothing else — it has no
// idea this platform exists — so the contract it belongs to has to be looked
// up. pg.Pool connects lazily, so constructing it here costs nothing until the
// first push arrives and does not make the process depend on Postgres to boot.
const dbPool = new pg.Pool(buildDbConfig(getDatabaseUrl(config)));

// Correlation ID hook
fastify.addHook('onRequest', (request, reply, done) => {
  const correlationId =
    (request.headers['x-correlation-id'] as string) || crypto.randomUUID();
  request.headers['x-correlation-id'] = correlationId;
  reply.header('x-correlation-id', correlationId);

  runWithCorrelationId(correlationId, () => {
    done();
  });
});

/**
 * Verify GitHub webhook HMAC SHA-256 signature using constant-time comparison
 */
export function verifyGitHubSignature(payload: string | Buffer, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const signature = signatureHeader.slice(7);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const expectedSignature = hmac.digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'));
  } catch {
    return false;
  }
}

/**
 * The minimum of `pg.Pool` that {@link resolveContractId} uses, so the lookup's
 * ordering rule can be tested without a live database.
 */
export interface ContractQueryable {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Array<{ contract_id: string }>; rowCount?: number | null }>;
}

/** GitHub's sentinel for "there is no commit here" — a deleted branch. */
const NULL_SHA = '0'.repeat(40);

/**
 * Find the contract a repository's pushes belong to, or null.
 *
 * `github_repo_full_name` is deliberately not unique (see V015): the same
 * repository is commonly reused for a follow-on contract with the same client.
 * That makes "which contract" a real question rather than a lookup, and the
 * answer has to be deterministic — resolving it differently on two pushes of
 * the same commit would file the audits under different contracts.
 *
 * Work in progress wins over history, most recent wins over older. A push
 * belongs to the engagement that is currently running, and when none is
 * running it belongs to the newest one rather than to whichever row Postgres
 * happened to return first.
 */
export async function resolveContractId(
  pool: ContractQueryable,
  repoFullName: string,
): Promise<string | null> {
  const result = await pool.query(
    `SELECT contract_id FROM contracts
      WHERE github_repo_full_name = $1
      ORDER BY (status IN ('LOCKED','IN_PROGRESS')) DESC, created_at DESC
      LIMIT 1`,
    [repoFullName],
  );
  return result.rows[0]?.contract_id ?? null;
}

// Add raw body parser for signature verification
fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
  try {
    const json = JSON.parse(body.toString('utf-8'));
    (req as any).rawBody = body;
    done(null, json);
  } catch (err: any) {
    done(err, undefined);
  }
});

fastify.get('/healthz', async () => ({ status: 'ok', service: 'webhook-ingest' }));

fastify.get('/readyz', async () => ({ status: 'ready', service: 'webhook-ingest', timestamp: new Date().toISOString() }));

fastify.get('/metrics', async (_request, reply) => {
  reply.header('Content-Type', metrics.getMetricsContentType());
  return metrics.getMetrics();
});

fastify.post('/webhooks/github', async (request, reply) => {
  const signature = request.headers['x-hub-signature-256'] as string;
  const rawBody = (request as any).rawBody || Buffer.from(JSON.stringify(request.body));

  if (!verifyGitHubSignature(rawBody, signature, GITHUB_WEBHOOK_SECRET)) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid HMAC signature' });
  }

  // Only pushes carry code to audit. GitHub sends a `ping` the moment a
  // webhook is created and will disable a hook that answers it with anything
  // other than a 2xx, so an unknown event type is acknowledged rather than
  // rejected — but nothing is published for it. Previously every event type
  // was processed as a push, so creating the webhook immediately queued an
  // audit for a payload with no commit in it.
  //
  // Deliberately after the signature check: an unsigned request is still a 401
  // whatever it claims to be.
  const eventType = (request.headers['x-github-event'] as string) || '';
  if (eventType !== 'push') {
    request.log.info({ eventType }, 'Ignoring non-push GitHub event');
    return reply.status(200).send({ status: 'ignored', ignored: true, event: eventType });
  }

  const payload = request.body as Record<string, any>;

  // A branch deletion is a push whose `after` is the null SHA. That is 40 hex
  // characters, so it satisfies ci-worker's commit-SHA check and would send it
  // to the GitHub API for a commit that does not exist — a fetch failure
  // reported as if the audit had been attempted.
  const commitHash = payload.after || payload.head_commit?.id || NULL_SHA;
  if (payload.deleted === true || commitHash === NULL_SHA) {
    request.log.info({ ref: payload.ref }, 'Ignoring branch deletion push');
    return reply
      .status(200)
      .send({ status: 'ignored', ignored: true, reason: 'branch deleted' });
  }

  // The repository is the only handle on identity a real delivery gives us.
  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) {
    return reply.status(400).send({
      error: 'Bad Request',
      message: 'push payload has no repository.full_name',
    });
  }

  let contractId: string | null;
  try {
    contractId = await resolveContractId(dbPool, repoFullName);
  } catch (err) {
    // Fail closed. Publishing with a guessed contract id is precisely the
    // failure this lookup exists to remove, and GitHub retries a 5xx.
    request.log.error({ err, repoFullName }, 'Contract lookup failed');
    return reply.status(503).send({
      error: 'Service Unavailable',
      message: 'Could not resolve the contract for this repository; retry later',
    });
  }

  if (!contractId) {
    // An honest rejection rather than the old 'unknown-contract' fallback,
    // which published an event that could only ever fail downstream on the
    // audit_results foreign key — invisibly, long after the 202.
    request.log.warn({ repoFullName }, 'Push for a repository no contract is linked to');
    return reply.status(404).send({
      error: 'Not Found',
      message:
        `No contract is linked to ${repoFullName}. ` +
        'Link it with PATCH /api/contracts/:contractId/github-repo.',
    });
  }

  const repoUrl = payload.repository?.clone_url || payload.repository?.html_url || '';

  const eventPayload = {
    contractId,
    commitHash,
    repoUrl,
    ref: payload.ref || 'refs/heads/main',
    pusher: payload.pusher?.name || payload.sender?.login || 'unknown',
    timestamp: new Date().toISOString(),
  };

  const correlationId = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();
  const envelope = await eventBus.publish(EVENT_TOPICS.CODE_PUSH_RECEIVED, eventPayload, correlationId);

  return reply.status(202).send({
    status: 'accepted',
    eventId: envelope.id,
    correlationId,
    topic: EVENT_TOPICS.CODE_PUSH_RECEIVED,
  });
});

async function start(): Promise<void> {
  try {
    // WEBHOOK_INGEST_PORT is what the config schema, .env.example and the
    // Kubernetes ConfigMap all name — but this read `process.env.PORT` and
    // otherwise fell back to 3002, a port nothing else in the repo mentions.
    // Setting the documented variable had no effect, so the service listened
    // somewhere its own manifests did not point at. PORT still wins when
    // present, since some platforms inject it and nothing else.
    const port = Number(process.env.PORT) || config.WEBHOOK_INGEST_PORT;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`[webhook-ingest] Listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  start();
}

// `eventBus` is exported for tests. createEventBus() hands back a *new*
// InMemoryBus on every call under NODE_ENV=test, so a test that builds its own
// and subscribes to it observes nothing this server publishes — and, since the
// usual assertion is that an event did or did not arrive, it fails or passes
// for a reason unrelated to the code under test. Subscribing to this instance
// is the only way to actually watch what the handler emits.
export { fastify, eventBus };
