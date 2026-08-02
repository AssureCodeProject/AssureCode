import { initTracing, metrics } from '@assurecode/telemetry';
initTracing('webhook-ingest');

import crypto from 'node:crypto';
import Fastify from 'fastify';
import { loadConfig, runWithCorrelationId } from '@assurecode/config';
import { createEventBus } from '@assurecode/event-bus';
import { EVENT_TOPICS } from '@assurecode/shared';

const config = loadConfig();
const fastify = Fastify({
  logger: { level: config.LOG_LEVEL || 'info' },
});

const eventBus = createEventBus(config.REDIS_URL);
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || 'assurecode_github_secret';

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

  const payload = request.body as Record<string, any>;
  const contractId = payload.contract_id || payload.repository?.name || 'unknown-contract';
  const commitHash = payload.after || payload.head_commit?.id || '0000000000000000000000000000000000000000';
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

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3002;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`[webhook-ingest] Listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

if (process.env.NODE_ENV !== 'test') {
  start();
}

export { fastify };
