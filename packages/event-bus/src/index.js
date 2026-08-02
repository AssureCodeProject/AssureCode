/**
 * @assurecode/event-bus — Publisher/Subscriber port with InMemory + Redis
 * Streams adapters.
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { getCorrelationId, runWithCorrelationId } from '@assurecode/config';
import { trace, context, propagation } from '@opentelemetry/api';
import { metrics } from '@assurecode/telemetry';

const tracer = trace.getTracer('assurecode-event-bus');

// ── Helper: build the envelope ─────────────────────────────────

export function buildEnvelope(topic, payload, correlationId) {
  const carrier = {};
  propagation.inject(context.active(), carrier);

  return {
    id: randomUUID(),
    topic,
    timestamp: new Date().toISOString(),
    correlationId,
    payload: {
      ...payload,
      _traceContext: carrier,
    },
  };
}

// ── InMemoryBus (tests + local dev) ────────────────────────────

export class InMemoryBus {
  constructor() {
    this.handlers = new Map();
  }

  async publish(topic, payload, correlationId) {
    const cid = correlationId || getCorrelationId() || randomUUID();
    const envelope = buildEnvelope(topic, payload, cid);
    const handlers = this.handlers.get(topic);

    const span = tracer.startSpan(`event_bus.publish ${topic}`, {
      attributes: {
        'messaging.system': 'inmemory',
        'messaging.destination': topic,
        'correlation_id': cid,
      },
    });

    if (handlers) {
      await Promise.all(
        [...handlers].map(async (h) => {
          const publishedAt = new Date(envelope.timestamp).getTime();
          const lagSeconds = Math.max(0, (Date.now() - publishedAt) / 1000);
          metrics.eventBusLagSeconds.observe({ topic }, lagSeconds);
          metrics.eventLagGauge.set({ topic }, lagSeconds);

          const traceContext = envelope.payload?._traceContext || {};
          const parentContext = propagation.extract(context.active(), traceContext);

          await context.with(parentContext, async () => {
            const consumeSpan = tracer.startSpan(`event_bus.consume ${topic}`, {
              attributes: {
                'messaging.system': 'inmemory',
                'messaging.destination': topic,
                'correlation_id': envelope.correlationId,
              },
            });
            try {
              await runWithCorrelationId(envelope.correlationId, async () => {
                await h(envelope);
              });
            } catch (err) {
              consumeSpan.recordException(err);
              throw err;
            } finally {
              consumeSpan.end();
            }
          });
        }),
      );
    }
    span.end();
    return envelope;
  }

  async subscribe(topic, handler) {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler);
    return async () => {
      set?.delete(handler);
    };
  }
}

// ── RedisStreamsBus (default dev) ──────────────────────────────

export class RedisStreamsBus {
  constructor(redisUrl) {
    this.client = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
    this.subscribers = [];
    this.groupName = 'assurecode';
    this.groupNameEnsured = new Set();
    this.maxRetries = 3;
    this.initialBackoffMs = 100;
  }

  async publish(topic, payload, correlationId) {
    const cid = correlationId || getCorrelationId() || randomUUID();
    const envelope = buildEnvelope(topic, payload, cid);

    const span = tracer.startSpan(`event_bus.publish ${topic}`, {
      attributes: {
        'messaging.system': 'redis_streams',
        'messaging.destination': topic,
        'correlation_id': cid,
      },
    });

    try {
      await this.client.xadd(topic, '*', 'envelope', JSON.stringify(envelope));
      return envelope;
    } finally {
      span.end();
    }
  }

  async subscribe(topic, handler) {
    const consumer = randomUUID();

    if (!this.groupNameEnsured.has(topic)) {
      try {
        await this.client.xgroup('CREATE', topic, this.groupName, '$', 'MKSTREAM');
      } catch (err) {
        if (!String(err).includes('BUSYGROUP')) throw err;
      }
      this.groupNameEnsured.add(topic);
    }

    const sub = { topic, consumer, stop: false };
    this.subscribers.push(sub);

    void this.poll(topic, consumer, handler, sub);

    return async () => {
      sub.stop = true;
    };
  }

  async poll(topic, consumer, handler, sub) {
    while (!sub.stop) {
      try {
        const res = await this.client.xreadgroup(
          'GROUP',
          this.groupName,
          consumer,
          'COUNT',
          10,
          'BLOCK',
          2000,
          'STREAMS',
          topic,
          '>',
        );

        if (!res) continue;
        for (const [, messages] of res) {
          for (const [id, fields] of messages) {
            const idx = fields.indexOf('envelope');
            if (idx === -1) continue;
            const envelope = JSON.parse(fields[idx + 1]);

            const publishedAt = new Date(envelope.timestamp).getTime();
            const lagSeconds = Math.max(0, (Date.now() - publishedAt) / 1000);
            metrics.eventBusLagSeconds.observe({ topic }, lagSeconds);
            metrics.eventLagGauge.set({ topic }, lagSeconds);

            let attempt = 0;
            let success = false;
            let lastError = null;

            const traceContext = envelope.payload?._traceContext || {};
            const parentContext = propagation.extract(context.active(), traceContext);

            await context.with(parentContext, async () => {
              const consumeSpan = tracer.startSpan(`event_bus.consume ${topic}`, {
                attributes: {
                  'messaging.system': 'redis_streams',
                  'messaging.destination': topic,
                  'correlation_id': envelope.correlationId,
                },
              });

              try {
                while (attempt < this.maxRetries) {
                  attempt++;
                  try {
                    await runWithCorrelationId(envelope.correlationId, async () => {
                      await handler(envelope);
                    });
                    success = true;
                    break;
                  } catch (err) {
                    lastError = err;
                    console.error({
                      msg: 'event-bus handler error',
                      topic,
                      attempt,
                      maxRetries: this.maxRetries,
                      err,
                    });
                    if (attempt < this.maxRetries) {
                      const backoff = this.initialBackoffMs * Math.pow(2, attempt - 1);
                      await new Promise((r) => setTimeout(r, backoff));
                    }
                  }
                }
              } catch (err) {
                consumeSpan.recordException(err);
              } finally {
                consumeSpan.end();
              }
            });

            if (!success) {
              const dlqTopic = `${topic}.dlq`;
              const errorMessage =
                lastError instanceof Error ? lastError.message : String(lastError);
              const errorStack =
                lastError instanceof Error ? lastError.stack : '';

              metrics.dlqDepth.inc({ stream: dlqTopic });

              console.error(
                `[event-bus] Message ${id} failed after ${this.maxRetries} attempts on ${topic}. Forwarding to ${dlqTopic}`,
              );

              await this.client.xadd(
                dlqTopic,
                '*',
                'envelope',
                JSON.stringify(envelope),
                'error',
                errorMessage,
                'errorStack',
                errorStack || '',
                'failedAt',
                new Date().toISOString(),
                'attempts',
                String(attempt),
                'originalStream',
                topic,
                'originalId',
                id,
              );
            }

            await this.client.xack(topic, this.groupName, id);
          }
        }
      } catch (err) {
        if (!sub.stop) console.error({ msg: 'event-bus poll error', topic, err });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async close() {
    for (const sub of this.subscribers) sub.stop = true;
    await this.client.quit();
  }
}

export function createEventBus(redisUrlOrOptions) {
  if (process.env.NODE_ENV === 'test' || process.env.USE_IN_MEMORY_BUS === 'true' || process.env.REDIS_DISABLED === 'true') {
    return new InMemoryBus();
  }
  if (typeof redisUrlOrOptions === 'string' && redisUrlOrOptions) {
    const bus = new RedisStreamsBus(redisUrlOrOptions);
    bus.client.on('error', () => {
      // Ignore initial connection errors gracefully
    });
    return bus;
  }
  if (redisUrlOrOptions?.type === 'redis' || redisUrlOrOptions?.redisUrl) {
    const bus = new RedisStreamsBus(redisUrlOrOptions.redisUrl || 'redis://localhost:6379');
    bus.client.on('error', () => {});
    return bus;
  }
  return new InMemoryBus();
}

export * from './outbox-relay.js';
