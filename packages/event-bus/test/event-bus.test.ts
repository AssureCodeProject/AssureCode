import { describe, it, expect } from 'vitest';
import { InMemoryBus } from '../src/index.js';
import { EVENT_TOPICS } from '@assurecode/shared';
import { redisAvailable, announceSkip } from '../../../tools/test-support/infra.js';

// Probed once at module load: the RedisStreamsBus suite drives a live Redis
// connection, and without one ioredis emits an unhandled 'error' that kills the
// vitest worker outright rather than failing a single test.
const REDIS_UP = await redisAvailable();
if (!REDIS_UP) announceSkip('RedisStreamsBus — Bounded Retries & DLQ', 'a running Redis on REDIS_URL');

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

