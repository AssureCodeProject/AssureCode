/**
 * @assurecode/event-bus — Publisher/Subscriber port with InMemory + Redis
 * Streams adapters.
 */
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@assurecode/shared';
import { Redis } from 'ioredis';
import { Kafka, type Admin, type Consumer, type Producer } from 'kafkajs';
import { getCorrelationId, runWithCorrelationId } from '@assurecode/config';
import { trace, context, propagation, type Context } from '@opentelemetry/api';
import { metrics } from '@assurecode/telemetry';

const tracer = trace.getTracer('assurecode-event-bus');

// ── Port ───────────────────────────────────────────────────────

export type EventHandler = (event: EventEnvelope) => Promise<void> | void;

export interface SubscribeOptions {
  /**
   * Consumer/group id to subscribe under. Defaults to a name derived from
   * the topic, which is what durable competing-consumer workers (ci-worker,
   * settlement-worker) want — multiple instances share one group and load-
   * balance the topic's messages between them.
   *
   * Ephemeral fan-out listeners (a WebSocket relay tapping a topic for one
   * browser connection) must NOT default to that shared group: joining it
   * makes them a competing consumer against the real worker, so Kafka/Redis
   * hands each message to only one of the two, and the two constantly
   * rebalance against each other. Pass a unique groupId (e.g. per
   * connection) to get an independent broadcast copy instead.
   */
  groupId?: string;
}

export interface EventBus {
  /** Publish an event to a topic. */
  publish(topic: string, payload: Record<string, unknown>, correlationId?: string): Promise<EventEnvelope>;
  /** Subscribe to a topic. Returns an unsubscribe function. */
  subscribe(topic: string, handler: EventHandler, options?: SubscribeOptions): Promise<() => Promise<void>>;
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

  async subscribe(topic: string, handler: EventHandler, _options?: SubscribeOptions): Promise<() => Promise<void>> {
    // Every subscriber already gets its own independent copy of each
    // published event (see publish() above) — no group concept needed.
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
  // How long a message may sit unacked in another consumer's PEL before this
  // consumer will claim and process it. Covers the case xack cannot: a
  // consumer that dies (crash, redeploy, or — as found in the golden-path
  // e2e suite — a short-lived process from an earlier test file/run that
  // registered under the shared group and then exited) leaves its claimed
  // messages permanently stuck, since XREADGROUP '>' only ever hands out
  // messages nobody has been given yet. Without a reclaim, that stream
  // entry is gone in practice even though it is still sitting in Redis.
  private readonly claimIdleMs = 15_000;

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

  async subscribe(topic: string, handler: EventHandler, options?: SubscribeOptions): Promise<() => Promise<void>> {
    const groupName = options?.groupId ?? this.groupName;
    const consumer = randomUUID();

    const groupKey = `${topic}::${groupName}`;
    if (!this.groupNameEnsured.has(groupKey)) {
      try {
        await this.client.xgroup('CREATE', topic, groupName, '$', 'MKSTREAM');
      } catch (err) {
        if (!String(err).includes('BUSYGROUP')) throw err;
      }
      this.groupNameEnsured.add(groupKey);
    }

    const sub = { topic, consumer, stop: false };
    this.subscribers.push(sub);

    void this.poll(topic, groupName, consumer, handler, sub);

    return async () => {
      sub.stop = true;
    };
  }

  /** Process one stream entry: run the handler with retries, DLQ on final failure, then ack. */
  private async processEntry(
    topic: string,
    groupName: string,
    id: string,
    fields: string[],
    handler: EventHandler,
  ): Promise<void> {
    const idx = fields.indexOf('envelope');
    if (idx === -1) {
      // Not one of our messages (malformed or from something else writing to
      // the same stream) — ack it so it does not sit in the PEL forever and
      // get reclaimed on every future pass.
      await this.client.xack(topic, groupName, id);
      return;
    }
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
      const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
      const errorStack = lastError instanceof Error ? lastError.stack ?? '' : '';

      metrics.dlqMessagesTotal.inc({ stream: dlqTopic });

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

    await this.client.xack(topic, groupName, id);
  }

  /**
   * Claim and process entries idle in the group's PEL for longer than
   * claimIdleMs, regardless of which (possibly dead) consumer they were
   * originally delivered to. Runs once per poll iteration; cheap when there
   * is nothing to claim (XAUTOCLAIM returns an empty batch).
   */
  private async reclaimStale(
    topic: string,
    groupName: string,
    consumer: string,
    handler: EventHandler,
  ): Promise<void> {
    try {
      const [, entries] = (await this.client.xautoclaim(
        topic,
        groupName,
        consumer,
        this.claimIdleMs,
        '0-0',
        'COUNT',
        10,
      )) as [string, Array<[string, string[]]>, string[]?];

      for (const [id, fields] of entries) {
        await this.processEntry(topic, groupName, id, fields, handler);
      }
    } catch (err) {
      // Non-fatal: a claim failure (e.g. group briefly missing during a
      // fresh MKSTREAM race) should not stop the normal read path below.
      console.error({ msg: 'event-bus reclaim error', topic, err });
    }
  }

  private async poll(
    topic: string,
    groupName: string,
    consumer: string,
    handler: EventHandler,
    sub: { stop: boolean },
  ): Promise<void> {
    while (!sub.stop) {
      try {
        await this.reclaimStale(topic, groupName, consumer, handler);

        const res = (await this.client.xreadgroup(
          'GROUP',
          groupName,
          consumer,
          'COUNT',
          10,
          'BLOCK',
          2000,
          'STREAMS',
          topic,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!res) {
          // Yield to the event loop before polling again.
          //
          // `continue` alone assumes xreadgroup always parks — true only while
          // BLOCK 2000 is honoured. Whenever the call returns immediately the
          // await resolves as a microtask, so this loop spins without ever
          // reaching the timers phase: it pegs a core AND starves every
          // setTimeout in the process, including this class's own retry
          // backoff. A consumer that polls an empty stream would silently stop
          // any timer-driven work elsewhere in the same worker.
          //
          // setImmediate costs nothing in the blocking case (one check-phase
          // tick per two seconds) and bounds the non-blocking case to one
          // iteration per event-loop turn.
          await new Promise((r) => setImmediate(r));
          continue;
        }
        for (const [, messages] of res) {
          for (const [id, fields] of messages) {
            await this.processEntry(topic, groupName, id, fields, handler);
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
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly consumers = new Map<string, Consumer>();
  private admin: Admin | null = null;
  private isConnected = false;
  /**
   * Mirrors RedisStreamsBus deliberately. Both buses must give up after the
   * same number of attempts, or "how many times is a handler retried before
   * the message is parked" becomes a property of which broker happens to be
   * configured rather than of the system.
   */
  private readonly maxRetries = 3;
  private readonly initialBackoffMs = 100;
  private readonly ensuredTopics = new Set<string>();

  constructor(brokers: string[], clientId = 'assurecode-bus') {
    if (brokers.length === 0) {
      // Refusing here rather than constructing a broker-less client: kafkajs
      // accepts an empty list and then fails at connect() time, deep inside a
      // publish, which is the harder failure to trace back to its cause.
      throw new Error('KafkaBus requires at least one broker (check KAFKA_BROKERS)');
    }
    this.kafka = new Kafka({ clientId, brokers });
    this.producer = this.kafka.producer();
  }

  private async ensureProducerConnected(): Promise<void> {
    if (!this.isConnected) {
      await this.producer.connect();
      this.isConnected = true;
    }
  }

  /**
   * Create any of `topics` the cluster does not already have.
   *
   * Not redundant with the broker's `auto.create.topics.enable`. That setting
   * is off on most managed clusters, and where it is on, an auto-created topic
   * takes the broker's `num.partitions` default — usually 1 — so every consumer
   * group on that topic is pinned to a single partition and adding worker
   * replicas buys no parallelism at all. Declaring the partition count here
   * makes the topology a property of this package rather than of whichever
   * broker it happens to land on.
   *
   * Call this once at service boot with `EVENT_TOPICS`. It is deliberately NOT
   * called from `publish()`: an admin connect on the first publish to each
   * topic puts a broker handshake on the path that carries settlement events,
   * and it blocks there for the full connection timeout even in the common case
   * where the topic already exists and the send would have succeeded. Boot is
   * where that round-trip is free; publish is where it is most expensive.
   *
   * A create failure is logged, not thrown: the topic may already exist and be
   * owned by an operator who never granted this client create rights, and
   * refusing to start in that case is worse than trying and finding out.
   */
  async ensureTopics(topics: string[]): Promise<void> {
    const missing = topics.filter((t) => !this.ensuredTopics.has(t));
    if (missing.length === 0) return;
    // Recorded before the await, not after. Two concurrent callers would
    // otherwise both observe an empty set and both issue a create.
    for (const t of missing) this.ensuredTopics.add(t);
    try {
      this.admin ??= this.kafka.admin();
      await this.admin.connect();
      await this.admin.createTopics({
        topics: missing.map((topic) => ({
          topic,
          numPartitions: Number(process.env.KAFKA_TOPIC_PARTITIONS ?? 3),
          replicationFactor: Number(process.env.KAFKA_TOPIC_REPLICATION ?? 1),
        })),
        waitForLeaders: true,
      });
    } catch (err) {
      // createTopics resolves false (rather than throwing) when every topic
      // already exists, so reaching here means something else went wrong.
      console.error({ msg: 'kafka-bus topic ensure failed', topics: missing, err });
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
      // No `if (this.producer)` guard. An earlier version loaded kafkajs with
      // require() inside this ESM package; that threw ReferenceError, a catch
      // swallowed it, and `producer` stayed undefined — so this guard turned
      // every publish into a silent no-op and EVENT_BUS_TYPE=kafka dropped the
      // entire event stream with nothing logged. kafkajs is a static import and
      // a declared dependency now, so the producer always exists; a genuine
      // broker failure must surface as a rejected publish, not a dropped event.
      await this.ensureProducerConnected();
      await this.producer.send({
        topic,
        messages: [{ value: JSON.stringify(envelope), key: cid }],
      });
      return envelope;
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Run `handler` up to `maxRetries` times with exponential backoff. Resolves
   * null on success, or the attempt count and last error on exhaustion — the
   * same contract RedisStreamsBus's inline loop implements.
   */
  private async runWithRetries(
    topic: string,
    envelope: EventEnvelope,
    handler: EventHandler,
  ): Promise<{ attempts: number; lastError: unknown } | null> {
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt < this.maxRetries) {
      attempt++;
      try {
        await runWithCorrelationId(envelope.correlationId, async () => {
          await handler(envelope);
        });
        return null;
      } catch (err) {
        lastError = err;
        // Single object arg so a non-literal `topic` cannot be read as a
        // printf-style format specifier.
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
    return { attempts: attempt, lastError };
  }

  /**
   * Forward a message this consumer could not process to `<topic>.dlq`.
   *
   * This method throwing is load-bearing. kafkajs auto-commits the offset once
   * `eachMessage` resolves, so swallowing a failed DLQ send would commit past a
   * message that was neither handled nor parked — it would be gone from both
   * the topic and the dead-letter queue, which is the exact silent-drop this
   * whole path exists to prevent. Letting the rejection escape leaves the
   * offset uncommitted so the broker redelivers.
   */
  private async sendToDlq(
    topic: string,
    envelope: EventEnvelope | null,
    raw: string,
    meta: { attempts: number; lastError: unknown; partition: number; offset: string },
  ): Promise<void> {
    const dlqTopic = `${topic}.dlq`;
    const { lastError } = meta;
    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    const errorStack = lastError instanceof Error ? lastError.stack ?? '' : '';

    metrics.dlqMessagesTotal.inc({ stream: dlqTopic });

    console.error(
      `[event-bus] Message ${meta.partition}:${meta.offset} failed after ${meta.attempts} attempts on ${topic}. Forwarding to ${dlqTopic}`,
    );

    await this.producer.send({
      topic: dlqTopic,
      messages: [
        {
          // The envelope when it parsed, the raw bytes when it did not. An
          // unparseable message is precisely the kind that needs to reach a
          // DLQ; discarding it for lacking the shape we hoped for is the bug.
          value: envelope ? JSON.stringify(envelope) : raw,
          key: envelope?.correlationId ?? null,
          // Headers rather than a wrapper object, so a DLQ consumer can replay
          // the value byte-for-byte onto the original topic without unwrapping.
          headers: {
            error: errorMessage,
            errorStack,
            failedAt: new Date().toISOString(),
            attempts: String(meta.attempts),
            originalStream: topic,
            originalId: `${meta.partition}:${meta.offset}`,
          },
        },
      ],
    });
  }

  async subscribe(topic: string, handler: EventHandler, options?: SubscribeOptions): Promise<() => Promise<void>> {
    // Likewise no `if (!this.kafka) return async () => {}` escape hatch here:
    // it returned a subscription that was never subscribed to anything.
    const consumerId = randomUUID();
    const consumer = this.kafka.consumer({ groupId: options?.groupId ?? `assurecode-${topic}` });

    // The DLQ path publishes, so the producer has to be live before the first
    // message arrives — not lazily on the first failure, which is the moment
    // least able to absorb a connect round-trip.
    await this.ensureProducerConnected();
    // Both the topic and its dead-letter partner, up front: sendToDlq() runs at
    // the worst possible moment to discover the target does not exist.
    await this.ensureTopics([topic, `${topic}.dlq`]);

    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });
    this.consumers.set(consumerId, consumer);

    await consumer.run({
      eachMessage: async ({
        partition,
        message,
      }: {
        partition: number;
        message: { value: Buffer | null; offset: string };
      }) => {
        if (!message.value) return;
        const raw = message.value.toString();

        let envelope: EventEnvelope;
        try {
          envelope = JSON.parse(raw) as EventEnvelope;
        } catch (err) {
          // Unparseable: no number of retries can help, so park it immediately
          // rather than logging and committing past it.
          await this.sendToDlq(topic, null, raw, {
            attempts: 0,
            lastError: err,
            partition,
            offset: message.offset,
          });
          return;
        }

        const lagSeconds = consumerLagSeconds(envelope);
        metrics.eventBusLagSeconds.observe({ topic }, lagSeconds);
        metrics.eventLagGauge.set({ topic }, lagSeconds);

        let failure: { attempts: number; lastError: unknown } | null = null;

        await context.with(parentContextOf(envelope), async () => {
          const consumeSpan = tracer.startSpan(`event_bus.consume ${topic}`, {
            attributes: {
              'messaging.system': 'kafka',
              'messaging.destination': topic,
              'correlation_id': envelope.correlationId,
            },
          });

          try {
            failure = await this.runWithRetries(topic, envelope, handler);
            if (failure) consumeSpan.recordException((failure as { lastError: unknown }).lastError as Error);
          } finally {
            consumeSpan.end();
          }
        });

        if (failure) {
          const { attempts, lastError } = failure as { attempts: number; lastError: unknown };
          await this.sendToDlq(topic, envelope, raw, {
            attempts,
            lastError,
            partition,
            offset: message.offset,
          });
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
    if (this.admin) {
      try {
        await this.admin.disconnect();
      } catch {}
      this.admin = null;
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

/**
 * Pre-create every topic the system publishes to, plus its `.dlq` partner.
 *
 * A no-op on every backend but Kafka: Redis streams spring into existence on
 * first `XADD`, and the in-memory bus has no notion of a topic at all. Kafka is
 * the one backend where publishing to a topic nobody has created yet either
 * fails outright (`auto.create.topics.enable=false`, the managed default) or
 * quietly produces a single-partition topic that caps consumer parallelism at
 * one worker forever.
 *
 * Call it once during service boot, before the first publish. It is separate
 * from `createEventBus` because it does broker I/O, and a factory that opens a
 * network connection is a factory that cannot be called in a test.
 */
export async function provisionTopics(bus: EventBus, topics: readonly string[]): Promise<void> {
  if (!(bus instanceof KafkaBus)) return;
  await bus.ensureTopics([...topics, ...topics.map((t) => `${t}.dlq`)]);
}

export function createEventBus(redisUrlOrOptions?: string | EventBusOptions): EventBus {
  // NODE_ENV=test means an in-memory bus, so unit suites need no broker.
  //
  // EVENT_BUS_FORCE_REAL is the one exception, and it exists for exactly one
  // caller: the golden-path suite, which imports the gateway *and* both workers
  // into a single process and needs them on the same bus. Without it each
  // createEventBus() call hands back a *fresh* InMemoryBus, so the gateway
  // would publish into a bus the workers were not listening on and the test
  // would pass or fail for reasons unrelated to the pipeline.
  //
  // Deliberately an opt-in rather than inferring from EVENT_BUS_TYPE: every
  // existing suite sets that variable through scripts/e2e.mjs and must keep
  // getting the in-memory bus.
  if (process.env.NODE_ENV === 'test' && process.env.EVENT_BUS_FORCE_REAL !== 'true') {
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
