import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryBus, KafkaBus, RedisStreamsBus, createEventBus, eventBusOptionsFromConfig } from '../src/index.js';
import { EVENT_TOPICS } from '@assurecode/shared';
import { redisAvailable, kafkaAvailable, announceSkip } from '../../../tools/test-support/infra.js';

// Probed once at module load: the RedisStreamsBus suite drives a live Redis
// connection, and without one ioredis emits an unhandled 'error' that kills the
// vitest worker outright rather than failing a single test.
const REDIS_UP = await redisAvailable();
if (!REDIS_UP) announceSkip('RedisStreamsBus — Bounded Retries & DLQ', 'a running Redis on REDIS_URL');

const KAFKA_UP = await kafkaAvailable();
if (!KAFKA_UP) announceSkip('KafkaBus — live broker', 'a running Kafka on KAFKA_BROKERS');

describe('InMemoryBus', () => {
  it('publishes and delivers events to subscribers', async () => {
    const bus = new InMemoryBus();
    const received: string[] = [];

    await bus.subscribe(EVENT_TOPICS.CONTRACT_LOCKED, (e) => {
      received.push(e.topic);
    });

    await bus.publish(EVENT_TOPICS.CONTRACT_LOCKED, { contractId: 'c1' });

    expect(received).toEqual([EVENT_TOPICS.CONTRACT_LOCKED]);
  });

  it('builds envelopes with id, timestamp, and correlationId', async () => {
    const bus = new InMemoryBus();
    let captured: any = null;
    await bus.subscribe('test.topic', (e) => {
      captured = e;
    });
    await bus.publish('test.topic', { foo: 'bar' }, 'corr-123');
    expect(captured.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured.correlationId).toBe('corr-123');
    expect(captured.payload).toEqual({ foo: 'bar' });
    expect(captured.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('supports unsubscribe', async () => {
    const bus = new InMemoryBus();
    const received: string[] = [];
    const unsub = await bus.subscribe('x.topic', (e) => received.push(e.topic));
    await bus.publish('x.topic', {});
    await unsub();
    await bus.publish('x.topic', {});
    expect(received.length).toBe(1);
  });

  it('delivers to multiple independent subscribers', async () => {
    const bus = new InMemoryBus();
    const a: string[] = [];
    const b: string[] = [];
    await bus.subscribe('multi.topic', (e) => a.push(e.id));
    await bus.subscribe('multi.topic', (e) => b.push(e.id));
    await bus.publish('multi.topic', {});
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });
});

describe('eventBusOptionsFromConfig', () => {
  const base = { REDIS_URL: 'redis://localhost:6379', KAFKA_BROKERS: 'a:9092, b:9092' };

  it('defaults to redis when EVENT_BUS_TYPE is unset', () => {
    expect(eventBusOptionsFromConfig({ ...base })).toEqual({
      type: 'redis',
      redisUrl: 'redis://localhost:6379',
    });
  });

  it('returns a kafka-only shape so the factory cannot fall through to redis', () => {
    const opts = eventBusOptionsFromConfig({ ...base, EVENT_BUS_TYPE: 'kafka' });
    expect(opts.type).toBe('kafka');
    expect(opts.kafkaBrokers).toEqual(['a:9092', 'b:9092']);
    expect(opts.redisUrl).toBeUndefined();
  });

  it('returns a memory-only shape carrying no broker or redis fields', () => {
    // createEventBus() checks `kafkaBrokers` before it checks `type`, so a
    // memory/redis options object that still carried brokers would silently
    // select Kafka. These disjoint shapes are what prevent that.
    const opts = eventBusOptionsFromConfig({ ...base, EVENT_BUS_TYPE: 'memory' });
    expect(opts).toEqual({ type: 'memory' });
  });

  it('drops blank entries from a trailing-comma KAFKA_BROKERS', () => {
    const opts = eventBusOptionsFromConfig({
      ...base,
      EVENT_BUS_TYPE: 'kafka',
      KAFKA_BROKERS: 'a:9092,,',
    });
    expect(opts.kafkaBrokers).toEqual(['a:9092']);
  });
});

describe('KafkaBus — publish must never silently drop', () => {
  // Regression guard for the bug documented in docs/HANDOFF_32GB_TESTING.md:
  // kafkajs was loaded with require() inside this ESM package, the resulting
  // ReferenceError was swallowed by a catch, and `producer` stayed undefined.
  // An `if (this.producer)` guard in publish() then made every send a no-op, so
  // EVENT_BUS_TYPE=kafka discarded the whole event stream with zero errors
  // logged. No broker is needed to prove the guard is gone.

  it('rejects an empty broker list at construction', () => {
    expect(() => new KafkaBus([])).toThrow(/at least one broker/);
  });

  it('propagates a broker failure instead of resolving as if it published', async () => {
    const bus = new KafkaBus(['localhost:9092']);
    const boom = new Error('broker unreachable');
    (bus as any).isConnected = true; // skip connect(); this test is about send()
    (bus as any).producer.send = async () => {
      throw boom;
    };

    await expect(bus.publish('test.topic', { a: 1 })).rejects.toThrow('broker unreachable');
  });

  it('sends the envelope keyed by correlation id when the broker accepts it', async () => {
    const bus = new KafkaBus(['localhost:9092']);
    const sent: any[] = [];
    (bus as any).isConnected = true;
    (bus as any).producer.send = async (payload: any) => {
      sent.push(payload);
      return [];
    };

    const envelope = await bus.publish('test.topic', { a: 1 }, 'corr-abc');

    expect(sent).toHaveLength(1);
    expect(sent[0].topic).toBe('test.topic');
    expect(sent[0].messages[0].key).toBe('corr-abc');
    expect(JSON.parse(sent[0].messages[0].value)).toEqual(envelope);
    expect(envelope.correlationId).toBe('corr-abc');
    expect(envelope.payload).toEqual({ a: 1 });
  });
});

describe('KafkaBus — Bounded Retries & DLQ', () => {
  // KafkaBus previously caught every handler error, logged it, and returned.
  // kafkajs auto-commits the offset once eachMessage resolves, so that catch
  // committed past the message: a poison event was dropped from the topic with
  // no DLQ copy and no failing anything. RedisStreamsBus had parked it. These
  // tests pin the two buses to the same behaviour. No broker is needed — the
  // consumer's eachMessage callback is captured and driven directly.

  /** Build a bus whose producer/admin/consumer are inert, and hand back the
   *  `eachMessage` callback `subscribe()` registered plus everything it sent. */
  async function harness(handler: (e: any) => Promise<void>) {
    const bus = new KafkaBus(['localhost:9092']);
    const sent: any[] = [];

    (bus as any).isConnected = true;
    (bus as any).producer.send = async (payload: any) => {
      sent.push(payload);
      return [];
    };
    // ensureTopics short-circuits on a populated set, so no admin client is
    // constructed and no connect() is attempted.
    (bus as any).ensuredTopics.add('test.poison');
    (bus as any).ensuredTopics.add('test.poison.dlq');
    // Collapse the retry backoff; this suite asserts attempt counts, not timing.
    (bus as any).initialBackoffMs = 0;

    let eachMessage: any;
    (bus as any).kafka.consumer = () => ({
      connect: async () => {},
      subscribe: async () => {},
      run: async (cfg: any) => {
        eachMessage = cfg.eachMessage;
      },
      disconnect: async () => {},
    });

    await bus.subscribe('test.poison', handler);
    return { bus, sent, deliver: (message: any, partition = 0) => eachMessage({ partition, message }) };
  }

  const envelope = {
    id: 'evt-123',
    topic: 'test.poison',
    timestamp: new Date().toISOString(),
    correlationId: 'corr-123',
    payload: { bad: true },
  };

  it('retries a failing handler 3 times, then forwards to *.dlq', async () => {
    let attempts = 0;
    const { sent, deliver } = await harness(async () => {
      attempts++;
      throw new Error('Poison message test failure');
    });

    await deliver({ value: Buffer.from(JSON.stringify(envelope)), offset: '42' });

    expect(attempts).toBe(3);

    const dlq = sent.find((s) => s.topic === 'test.poison.dlq');
    expect(dlq).toBeDefined();
    expect(JSON.parse(dlq.messages[0].value)).toEqual(envelope);

    const headers = dlq.messages[0].headers;
    expect(headers.attempts).toBe('3');
    expect(headers.originalStream).toBe('test.poison');
    expect(headers.originalId).toBe('0:42');
    expect(headers.error).toBe('Poison message test failure');
  });

  it('does not touch the DLQ when the handler succeeds', async () => {
    const { sent, deliver } = await harness(async () => {});
    await deliver({ value: Buffer.from(JSON.stringify(envelope)), offset: '7' });
    expect(sent.find((s) => s.topic === 'test.poison.dlq')).toBeUndefined();
  });

  it('parks an unparseable message immediately, without retrying', async () => {
    let called = 0;
    const { sent, deliver } = await harness(async () => {
      called++;
    });

    await deliver({ value: Buffer.from('{not json'), offset: '9' });

    // No retry can fix malformed bytes, so the handler must never see them.
    expect(called).toBe(0);
    const dlq = sent.find((s) => s.topic === 'test.poison.dlq');
    expect(dlq).toBeDefined();
    // The raw bytes survive: discarding them for lacking the expected shape is
    // exactly the drop the DLQ exists to prevent.
    expect(dlq.messages[0].value).toBe('{not json');
    expect(dlq.messages[0].headers.attempts).toBe('0');
  });

  it('rejects when the DLQ send itself fails, so the offset is not committed', async () => {
    // The load-bearing case. Swallowing this would commit past a message that
    // was neither handled nor parked — gone from both the topic and the DLQ.
    const { bus, deliver } = await harness(async () => {
      throw new Error('handler down');
    });
    (bus as any).producer.send = async () => {
      throw new Error('dlq broker unreachable');
    };

    await expect(
      deliver({ value: Buffer.from(JSON.stringify(envelope)), offset: '1' }),
    ).rejects.toThrow('dlq broker unreachable');
  });
});

describe.skipIf(!REDIS_UP)('RedisStreamsBus — Bounded Retries & DLQ', () => {
  it('retries failing handlers up to 3 times before sending to *.dlq and ACKing', async () => {
    const { RedisStreamsBus } = await import('../src/index.js');
    // REDIS_URL, not a hardcoded localhost:6379. The skip guard above probes
    // REDIS_URL; connecting somewhere else means the guard can pass while this
    // line points at a dead port, and an unreachable ioredis emits the
    // unhandled 'error' that kills the worker — the exact failure the guard
    // exists to prevent. Under `npm run test:e2e` these are different ports.
    const bus = new RedisStreamsBus(process.env.REDIS_URL ?? 'redis://localhost:6379');
    const mockClient = (bus as any).client;

    const xaddCalls: Array<{ stream: string; args: any[] }> = [];
    const xackCalls: Array<{ topic: string; group: string; id: string }> = [];

    mockClient.xgroup = async () => 'OK';
    mockClient.xadd = async (stream: string, ...args: any[]) => {
      xaddCalls.push({ stream, args });
      return '1720000000000-0';
    };
    mockClient.xack = async (topic: string, group: string, id: string) => {
      xackCalls.push({ topic, group, id });
      return 1;
    };
    // `quit` is deliberately NOT stubbed. Stubbing it made bus.close() a no-op
    // against the real ioredis socket this test opened, so the connection stayed
    // alive, the event loop never drained, and the vitest worker hung until the
    // pool force-killed it — reported as "Worker exited unexpectedly" with no
    // failing assertion to point at. The stream commands above are stubbed
    // because the test drives them; teardown is not something it needs to fake.

    const envelope = {
      id: 'evt-123',
      topic: 'test.poison',
      timestamp: new Date().toISOString(),
      correlationId: 'corr-123',
      payload: { bad: true },
    };

    let readCount = 0;
    mockClient.xreadgroup = async () => {
      readCount++;
      if (readCount === 1) {
        return [
          [
            'test.poison',
            [['100-0', ['envelope', JSON.stringify(envelope)]]],
          ],
        ];
      }
      return null;
    };

    let attempts = 0;
    const handler = async () => {
      attempts++;
      throw new Error('Poison message test failure');
    };

    const unsub = await bus.subscribe('test.poison', handler);

    await new Promise((r) => setTimeout(r, 600));
    await unsub();
    await bus.close();

    expect(attempts).toBe(3);

    const dlqAdd = xaddCalls.find((c) => c.stream === 'test.poison.dlq');
    expect(dlqAdd).toBeDefined();

    const args = dlqAdd!.args;
    const envelopeIdx = args.indexOf('envelope');
    expect(envelopeIdx).not.toBe(-1);
    expect(JSON.parse(args[envelopeIdx + 1])).toEqual(envelope);

    const attemptsIdx = args.indexOf('attempts');
    expect(args[attemptsIdx + 1]).toBe('3');

    const origStreamIdx = args.indexOf('originalStream');
    expect(args[origStreamIdx + 1]).toBe('test.poison');

    expect(xackCalls).toContainEqual({
      topic: 'test.poison',
      group: 'assurecode',
      id: '100-0',
    });
  });
});

// These do not need REDIS_UP: bypassing the constructor via Object.create
// means no ioredis connection is ever opened (see the unhandled-'error'
// warning on REDIS_UP above), so they run everywhere the class's own logic
// needs covering — including jobs with no Redis service, where the suite
// above is skipped wholesale and this behaviour would otherwise go untested.
function busWithFakeClient(client: Record<string, unknown>): RedisStreamsBus {
  const bus = Object.create(RedisStreamsBus.prototype) as RedisStreamsBus;
  Object.assign(bus as unknown as Record<string, unknown>, {
    client,
    subscribers: [],
    groupName: 'assurecode',
    groupNameEnsured: new Set(),
    maxRetries: 3,
    initialBackoffMs: 1,
    claimIdleMs: 15_000,
  });
  return bus;
}

describe('RedisStreamsBus — processEntry (no live Redis required)', () => {
  it('runs the handler once and acks on success, without touching the DLQ', async () => {
    const xackCalls: unknown[] = [];
    const xaddCalls: unknown[] = [];
    const bus = busWithFakeClient({
      xack: async (...args: unknown[]) => xackCalls.push(args),
      xadd: async (...args: unknown[]) => xaddCalls.push(args),
    });

    const envelope = {
      id: 'evt-1',
      topic: 't',
      timestamp: new Date().toISOString(),
      correlationId: 'c1',
      payload: {},
    };
    let calls = 0;
    await (bus as any).processEntry('t', 'assurecode', '1-0', ['envelope', JSON.stringify(envelope)], async () => {
      calls++;
    });

    expect(calls).toBe(1);
    expect(xaddCalls).toHaveLength(0);
    expect(xackCalls).toEqual([['t', 'assurecode', '1-0']]);
  });

  it('acks immediately without invoking the handler when the entry has no envelope field', async () => {
    const xackCalls: unknown[] = [];
    const bus = busWithFakeClient({
      xack: async (...args: unknown[]) => xackCalls.push(args),
    });

    let calls = 0;
    await (bus as any).processEntry('t', 'assurecode', '1-0', ['someOtherField', 'x'], async () => {
      calls++;
    });

    expect(calls).toBe(0);
    expect(xackCalls).toEqual([['t', 'assurecode', '1-0']]);
  });

  it('retries maxRetries times, forwards to the DLQ, then still acks', async () => {
    const xackCalls: unknown[] = [];
    const xaddCalls: Array<[string, ...unknown[]]> = [];
    const bus = busWithFakeClient({
      xack: async (...args: unknown[]) => xackCalls.push(args),
      xadd: async (...args: [string, ...unknown[]]) => xaddCalls.push(args),
    });

    const envelope = {
      id: 'evt-2',
      topic: 't',
      timestamp: new Date().toISOString(),
      correlationId: 'c2',
      payload: { bad: true },
    };
    let calls = 0;
    await (bus as any).processEntry('t', 'assurecode', '2-0', ['envelope', JSON.stringify(envelope)], async () => {
      calls++;
      throw new Error('always fails');
    });

    expect(calls).toBe(3);
    expect(xaddCalls).toHaveLength(1);
    expect(xaddCalls[0][0]).toBe('t.dlq');
    expect(xackCalls).toEqual([['t', 'assurecode', '2-0']]);
  });
});

describe.skipIf(!KAFKA_UP)('KafkaBus — live broker', () => {
  // Goes through the real factory path (eventBusOptionsFromConfig +
  // createEventBus), not `new KafkaBus(...)` directly — deliberately, because
  // the regression this guards against was in that wiring, not in KafkaBus's
  // own logic. Every service used to call `createEventBus(config.REDIS_URL)`
  // with a bare string, which the factory only ever resolved to
  // RedisStreamsBus: EVENT_BUS_TYPE=kafka silently produced a working Redis
  // bus and no Kafka topic ever saw a message, with nothing anywhere failing
  // loudly. The "KafkaBus — Bounded Retries & DLQ" suite above, against a
  // mocked kafkajs client, could not have caught that — it never asks which
  // class got constructed, only what the class does once it exists.
  //
  // createEventBus() defaults to InMemoryBus under NODE_ENV=test unless
  // EVENT_BUS_FORCE_REAL=true — the same opt-in the golden-path e2e suite
  // uses — so this suite sets it for its own duration and restores whatever
  // was there before, rather than assuming no other file in this run cares.
  const previousForceReal = process.env.EVENT_BUS_FORCE_REAL;

  afterAll(() => {
    if (previousForceReal === undefined) delete process.env.EVENT_BUS_FORCE_REAL;
    else process.env.EVENT_BUS_FORCE_REAL = previousForceReal;
  });

  it(
    'createEventBus(EVENT_BUS_TYPE=kafka) round-trips a real publish through a real broker',
    async () => {
      process.env.EVENT_BUS_FORCE_REAL = 'true';

      const options = eventBusOptionsFromConfig({
        EVENT_BUS_TYPE: 'kafka',
        REDIS_URL: 'redis://localhost:6379',
        KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
      });
      const bus = createEventBus(options);
      // The assertion that actually matters: given EVENT_BUS_TYPE=kafka, the
      // factory built a Kafka bus, not a Redis or in-memory one.
      expect(bus).toBeInstanceOf(KafkaBus);

      const topic = `test.kafka-live.${randomUUID()}`;
      const received: unknown[] = [];
      const unsubscribe = await bus.subscribe(topic, async (event) => {
        received.push(event.payload);
      });

      try {
        await bus.publish(topic, { marker: 'live-kafka-roundtrip' });

        // Consumer group join and partition assignment are not instantaneous
        // on a cold broker — poll rather than assume a fixed sleep covers it.
        const deadline = Date.now() + 15_000;
        while (received.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
      } finally {
        await unsubscribe();
        await bus.close?.();
      }

      expect(received).toEqual([{ marker: 'live-kafka-roundtrip' }]);
    },
    20_000,
  );
});

describe('RedisStreamsBus — reclaimStale (no live Redis required)', () => {
  it('claims idle pending entries via XAUTOCLAIM and runs them through processEntry', async () => {
    const envelope = {
      id: 'evt-3',
      topic: 't',
      timestamp: new Date().toISOString(),
      correlationId: 'c3',
      payload: { reclaimed: true },
    };
    const xackCalls: unknown[] = [];
    const xautoclaimCalls: unknown[] = [];
    const bus = busWithFakeClient({
      xack: async (...args: unknown[]) => xackCalls.push(args),
      xautoclaim: async (...args: unknown[]) => {
        xautoclaimCalls.push(args);
        return ['0-0', [['3-0', ['envelope', JSON.stringify(envelope)]]]];
      },
    });

    let calls = 0;
    await (bus as any).reclaimStale('t', 'assurecode', 'consumer-1', async () => {
      calls++;
    });

    expect(xautoclaimCalls).toEqual([['t', 'assurecode', 'consumer-1', 15_000, '0-0', 'COUNT', 10]]);
    expect(calls).toBe(1);
    expect(xackCalls).toEqual([['t', 'assurecode', '3-0']]);
  });

  it('is non-fatal when XAUTOCLAIM itself fails — the normal read path must still run', async () => {
    const bus = busWithFakeClient({
      xautoclaim: async () => {
        throw new Error('redis blip');
      },
    });

    let calls = 0;
    await expect(
      (bus as any).reclaimStale('t', 'assurecode', 'consumer-1', async () => {
        calls++;
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });
});

