/**
 * @assurecode/event-bus — Publisher/Subscriber port with InMemory + Redis
 * Streams adapters.
 */
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@assurecode/shared';
import { Redis } from 'ioredis';
import { getCorrelationId, runWithCorrelationId } from '@assurecode/config';
import { trace, context, propagation, type Context } from '@opentelemetry/api';
import { metrics } from '@assurecode/telemetry';

const tracer = trace.getTracer('assurecode-event-bus');

// ── Port ───────────────────────────────────────────────────────

export type EventHandler = (event: EventEnvelope) => Promise<void> | void;

export interface EventBus {
  /** Publish an event to a topic. */
  publish(topic: string, payload: Record<string, unknown>, correlationId?: string): Promise<EventEnvelope>;
  /** Subscribe to a topic. Returns an unsubscribe function. */
  subscribe(topic: string, handler: EventHandler): Promise<() => Promise<void>>;
  /** Graceful shutdown of consumers/connections. */
  close?(): Promise<void>;
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Seconds between when the envelope was published and now, floored at zero —
 * clocks can disagree across producer and consumer, and a negative lag reading
 * is noise rather than information.
 */
function consumerLagSeconds(envelope: EventEnvelope): number {
  return Math.max(0, (Date.now() - new Date(envelope.timestamp).getTime()) / 1000);
}

/** The producer's trace context, so consume spans hang off the publish span. */
function parentContextOf(envelope: EventEnvelope): Context {
  return propagation.extract(context.active(), envelope.traceContext ?? {});
}

export function buildEnvelope(
  topic: string,
  payload: Record<string, unknown>,
  correlationId: string,
): EventEnvelope {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  return {
    id: randomUUID(),
    topic,
    timestamp: new Date().toISOString(),
    correlationId,
    payload,
    traceContext: carrier,
  };
}

// ── InMemoryBus (tests + local dev) ────────────────────────────

export class InMemoryBus implements EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  async publish(topic: string, payload: Record<string, unknown>, correlationId?: string): Promise<EventEnvelope> {
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
          const lagSeconds = consumerLagSeconds(envelope);
          metrics.eventBusLagSeconds.observe({ topic }, lagSeconds);
          metrics.eventLagGauge.set({ topic }, lagSeconds);

          await context.with(parentContextOf(envelope), async () => {
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
              consumeSpan.recordException(err as Error);
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

  async subscribe(topic: string, handler: EventHandler): Promise<() => Promise<void>> {
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

export class RedisStreamsBus implements EventBus {
  private client: InstanceType<typeof Redis>;
  private subscribers: Array<{ topic: string; consumer: string; stop: boolean }> = [];
  private readonly groupName = 'assurecode';
  private readonly groupNameEnsured = new Set<string>();
  private readonly maxRetries = 3;
  private readonly initialBackoffMs = 100;

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
  }

  async publish(topic: string, payload: Record<string, unknown>, correlationId?: string): Promise<EventEnvelope> {
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

  async subscribe(topic: string, handler: EventHandler): Promise<() => Promise<void>> {
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

  private async poll(
    topic: string,
    consumer: string,
    handler: EventHandler,
    sub: { stop: boolean },
  ): Promise<void> {
    while (!sub.stop) {
      try {
        const res = (await this.client.xreadgroup(
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
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!res) continue;
        for (const [, messages] of res) {
          for (const [id, fields] of messages) {
            const idx = fields.indexOf('envelope');
            if (idx === -1) continue;
            const envelope = JSON.parse(fields[idx + 1]) as EventEnvelope;

            const lagSeconds = consumerLagSeconds(envelope);
            metrics.eventBusLagSeconds.observe({ topic }, lagSeconds);
            metrics.eventLagGauge.set({ topic }, lagSeconds);

            let attempt = 0;
            let success = false;
            let lastError: unknown = null;

            await context.with(parentContextOf(envelope), async () => {
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
                    // Single object arg so non-literal `topic` cannot be
                    // interpreted as a printf-style format specifier.
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
                consumeSpan.recordException(err as Error);
              } finally {
                consumeSpan.end();
              }
            });

            if (!success) {
              const dlqTopic = `${topic}.dlq`;
              const errorMessage =
                lastError instanceof Error ? lastError.message : String(lastError);
              const errorStack =
                lastError instanceof Error ? lastError.stack ?? '' : '';

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
                errorStack,
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

  async close(): Promise<void> {
    for (const sub of this.subscribers) sub.stop = true;
    await this.client.quit();
  }
}

// ── KafkaBus (Sprint 2 task 2.1) ───────────────────────────────

export class KafkaBus implements EventBus {
  private kafka: any;
  private producer: any;
  private readonly consumers = new Map<string, any>();
  private isConnected = false;

  constructor(brokers: string[], clientId = 'assurecode-bus') {
    try {
      const { Kafka } = require('kafkajs');
      this.kafka = new Kafka({ clientId, brokers });
      this.producer = this.kafka.producer();
    } catch {
      this.kafka = null;
      this.producer = null;
    }
  }

  private async ensureProducerConnected(): Promise<void> {
    if (!this.producer) return;
    if (!this.isConnected) {
      await this.producer.connect();
      this.isConnected = true;
    }
  }

  async publish(topic: string, payload: Record<string, unknown>, correlationId?: string): Promise<EventEnvelope> {
    const cid = correlationId || getCorrelationId() || randomUUID();
    const envelope = buildEnvelope(topic, payload, cid);

    const span = tracer.startSpan(`event_bus.publish ${topic}`, {
      attributes: {
        'messaging.system': 'kafka',
        'messaging.destination': topic,
        'correlation_id': cid,
      },
    });

    try {
      if (this.producer) {
        await this.ensureProducerConnected();
        await this.producer.send({
          topic,
          messages: [{ value: JSON.stringify(envelope), key: cid }],
        });
      }
      return envelope;
    } finally {
      span.end();
    }
  }

  async subscribe(topic: string, handler: EventHandler): Promise<() => Promise<void>> {
    if (!this.kafka) {
      return async () => {};
    }
    const consumerId = randomUUID();
    const consumer = this.kafka.consumer({ groupId: `assurecode-${topic}` });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });
    this.consumers.set(consumerId, consumer);

    await consumer.run({
      eachMessage: async ({ message }: { message: { value: Buffer | null } }) => {
        if (!message.value) return;
        try {
          const envelope = JSON.parse(message.value.toString()) as EventEnvelope;
          metrics.eventBusLagSeconds.observe({ topic }, consumerLagSeconds(envelope));

          await context.with(parentContextOf(envelope), async () => {
            const consumeSpan = tracer.startSpan(`event_bus.consume ${topic}`, {
              attributes: {
                'messaging.system': 'kafka',
                'messaging.destination': topic,
                'correlation_id': envelope.correlationId,
              },
            });

            try {
              await runWithCorrelationId(envelope.correlationId, async () => {
                await handler(envelope);
              });
            } catch (err) {
              consumeSpan.recordException(err as Error);
              throw err;
            } finally {
              consumeSpan.end();
            }
          });
        } catch (err) {
          console.error({ msg: 'kafka-bus message handling error', topic, err });
        }
      },
    });

    return async () => {
      try {
        await consumer.disconnect();
      } catch {}
      this.consumers.delete(consumerId);
    };
  }

  async close(): Promise<void> {
    if (this.producer && this.isConnected) {
      await this.producer.disconnect();
      this.isConnected = false;
    }
    for (const consumer of this.consumers.values()) {
      try {
        await consumer.disconnect();
      } catch {}
    }
    this.consumers.clear();
  }
}

// ── Factory ────────────────────────────────────────────────────

export interface EventBusOptions {
  type?: 'memory' | 'redis' | 'kafka';
  redisUrl?: string;
  kafkaBrokers?: string[];
}

/**
 * Build createEventBus()'s options object from AppConfig, so EVENT_BUS_TYPE
 * actually reaches the factory's `type` branch. Every service used to call
 * `createEventBus(config.REDIS_URL)` — a bare string always resolves to
 * RedisStreamsBus (or InMemoryBus if empty), so KafkaBus's branch below was
 * unreachable from any real caller regardless of what EVENT_BUS_TYPE said.
 */
export function eventBusOptionsFromConfig(config: {
  EVENT_BUS_TYPE?: 'memory' | 'redis' | 'kafka';
  REDIS_URL: string;
  KAFKA_BROKERS: string;
}): EventBusOptions {
  const type = config.EVENT_BUS_TYPE ?? 'redis';
  // Only the field for the chosen type is populated. createEventBus() below
  // picks Kafka whenever `kafkaBrokers` is present at all, before it even
  // looks at `type` — so an options object that always carried a default
  // kafkaBrokers array would silently force Kafka regardless of what
  // EVENT_BUS_TYPE actually said. Building three disjoint shapes here avoids
  // that trap instead of relying on the factory's field-precedence order.
  if (type === 'kafka') {
    return {
      type: 'kafka',
      kafkaBrokers: config.KAFKA_BROKERS.split(',').map((b) => b.trim()).filter(Boolean),
    };
  }
  if (type === 'memory') {
    return { type: 'memory' };
  }
  return { type: 'redis', redisUrl: config.REDIS_URL };
}

export function createEventBus(redisUrlOrOptions?: string | EventBusOptions): EventBus {
  if (process.env.NODE_ENV === 'test') {
    return new InMemoryBus();
  }
  if (typeof redisUrlOrOptions === 'string') {
    return redisUrlOrOptions ? new RedisStreamsBus(redisUrlOrOptions) : new InMemoryBus();
  }
  if (redisUrlOrOptions?.type === 'kafka' || redisUrlOrOptions?.kafkaBrokers) {
    return new KafkaBus(redisUrlOrOptions.kafkaBrokers || ['localhost:9092']);
  }
  if (redisUrlOrOptions?.type === 'redis' || redisUrlOrOptions?.redisUrl) {
    return new RedisStreamsBus(redisUrlOrOptions.redisUrl || 'redis://localhost:6379');
  }
  return new InMemoryBus();
}

export * from './outbox-relay.js';
