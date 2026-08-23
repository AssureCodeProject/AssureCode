/**
 * The automatic XAI scoring trigger.
 *
 * Before this trigger existed, the settlement gate's `trustScore >= 85` term was
 * satisfiable only when a human opened the XAI tab in the browser, because that
 * React effect was the sole caller of the one route that publishes XAI_SCORED.
 * These tests pin the behaviour that replaced it.
 *
 * Everything here injects `fetchImpl` and `sleep`, so the suite needs no
 * Postgres, no Redis and no gateway. That is the reason triggerScoring lives in
 * its own module rather than inside worker.ts, which opens real sockets at
 * import time.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  triggerScoring,
  requestRootSignature,
  logTriggerOutcome,
  type TriggerDeps,
} from '../src/gateway-client.js';

const GATEWAY = 'http://gateway.test:4000';
const TOKEN = 'test-service-token';

/** A fetch stub that replays the given responses in order. */
function stubFetch(...responses: Array<Response | Error>): {
  fn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    // The last response repeats, so "persistent 502" needs one entry.
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const err = (status: number, body = 'nope') => new Response(body, { status });

/**
 * A sleep stub that advances a virtual clock instead of waiting, and reports
 * the total. The deadline in triggerScoring is measured with Date.now(), so the
 * clock has to be faked too or "does it respect the budget" is untestable
 * without actually spending twenty seconds.
 */
function fakeClock() {
  let now = 1_000_000;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    sleep: async (ms: number) => {
      now += ms;
    },
    /** Charge elapsed time for an attempt that timed out or errored. */
    advance: (ms: number) => {
      now += ms;
    },
    elapsed: () => now - 1_000_000,
    restore: () => spy.mockRestore(),
  };
}

function deps(over: Partial<TriggerDeps> = {}): TriggerDeps {
  return { gatewayUrl: GATEWAY, serviceToken: TOKEN, enabled: true, ...over };
}

describe('triggerScoring', () => {
  it('returns the score and calls the gateway route with the service token', async () => {
    const { fn, calls } = stubFetch(ok({ trustScore: 91.5, criticalVulns: 0 }));

    const outcome = await triggerScoring('AC-123', deps({ fetchImpl: fn }));

    expect(outcome).toEqual({ kind: 'scored', trustScore: 91.5, criticalVulns: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${GATEWAY}/api/contracts/AC-123/score`);
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Record<string, string>)['x-service-token']).toBe(TOKEN);
    // The correlation id is what stitches audit -> score -> XAI_SCORED into one
    // trace; asserting it is present stops it being dropped in a refactor.
    expect((calls[0].init.headers as Record<string, string>)['x-correlation-id']).toBeTruthy();
  });

  // The load-bearing assertion of this file. A terminal refusal must cost
  // exactly one request: 409 "no assigned freelancer" is a real, reachable
  // state (/simulate-push does not require an assignment), and retrying it
  // would burn the whole budget stalling AUDIT_COMPLETED consumption on an
  // answer that cannot change.
  it.each([400, 404, 409, 422])('does not retry a terminal %i', async (status) => {
    const { fn, calls } = stubFetch(err(status, 'no assigned freelancer'));

    const outcome = await triggerScoring('AC-123', deps({ fetchImpl: fn }));

    expect(outcome).toMatchObject({ kind: 'declined', status });
    expect(calls).toHaveLength(1);
  });

  it.each([401, 403])('reports %i as misconfigured after one attempt', async (status) => {
    const { fn, calls } = stubFetch(err(status));

    const outcome = await triggerScoring('AC-123', deps({ fetchImpl: fn }));

    expect(outcome).toMatchObject({ kind: 'misconfigured', status });
    expect(calls).toHaveLength(1);
  });

  it('retries a 502 and succeeds on the second attempt', async () => {
    const clock = fakeClock();
    try {
      const { fn, calls } = stubFetch(err(502), ok({ trustScore: 88, criticalVulns: 0 }));

      const outcome = await triggerScoring('AC-123', deps({ fetchImpl: fn, sleep: clock.sleep }));

      expect(outcome).toEqual({ kind: 'scored', trustScore: 88, criticalVulns: 0 });
      expect(calls).toHaveLength(2);
      expect(clock.elapsed()).toBe(1_000); // one backoff, the first entry
    } finally {
      clock.restore();
    }
  });

  it('gives up on a persistent 502 without exceeding the deadline', async () => {
    const clock = fakeClock();
    try {
      const { fn, calls } = stubFetch(err(503, 'telemetry unavailable'));

      const outcome = await triggerScoring(
        'AC-123',
        deps({ fetchImpl: fn, sleep: clock.sleep, deadlineMs: 20_000 }),
      );

      expect(outcome).toMatchObject({ kind: 'unavailable' });
      expect((outcome as { detail: string }).detail).toContain('503');
      expect(calls.length).toBeGreaterThan(1);
      // The point of a wall-clock budget: the AUDIT_COMPLETED topic stalls for
      // a stateable duration rather than an emergent one.
      expect(clock.elapsed()).toBeLessThan(20_000);
    } finally {
      clock.restore();
    }
  });

  it('treats a timeout as transient and retries it', async () => {
    const clock = fakeClock();
    try {
      const timeout = Object.assign(new Error('The operation was aborted'), {
        name: 'TimeoutError',
      });
      const { fn, calls } = stubFetch(timeout, ok({ trustScore: 90, criticalVulns: 0 }));

      const outcome = await triggerScoring('AC-123', deps({ fetchImpl: fn, sleep: clock.sleep }));

      expect(outcome).toMatchObject({ kind: 'scored' });
      expect(calls).toHaveLength(2);
    } finally {
      clock.restore();
    }
  });

  it('makes no request at all when disabled', async () => {
    const { fn, calls } = stubFetch(ok({ trustScore: 99, criticalVulns: 0 }));

    const outcome = await triggerScoring('AC-123', deps({ enabled: false, fetchImpl: fn }));

    expect(outcome).toEqual({ kind: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  // A contract id is not guaranteed to be path-safe. Interpolating one raw
  // would let a crafted id address a different gateway route.
  it('percent-encodes the contract id', async () => {
    const { fn, calls } = stubFetch(ok({ trustScore: 90, criticalVulns: 0 }));

    await triggerScoring('AC/../admin 1', deps({ fetchImpl: fn }));

    expect(calls[0].url).toBe(`${GATEWAY}/api/contracts/AC%2F..%2Fadmin%201/score`);
  });
});

describe('requestRootSignature', () => {
  it('reports a freshly signed root', async () => {
    const { fn, calls } = stubFetch(
      ok({ contractId: 'AC-1', signed: true, alreadySigned: false, algorithm: 'ML-DSA-87' }),
    );

    const outcome = await requestRootSignature('AC-1', { ...deps(), fetchImpl: fn });

    expect(outcome).toEqual({ kind: 'signed', algorithm: 'ML-DSA-87', alreadySigned: false });
    expect(calls[0].url).toBe(`${GATEWAY}/api/contracts/AC-1/root/sign`);
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['x-service-token']).toBe(TOKEN);
  });

  it('reports an already-signed root as signed, not as an error', async () => {
    const { fn } = stubFetch(
      ok({ contractId: 'AC-1', signed: true, alreadySigned: true, algorithm: 'ML-DSA-87' }),
    );

    const outcome = await requestRootSignature('AC-1', { ...deps(), fetchImpl: fn });

    expect(outcome).toMatchObject({ kind: 'signed', alreadySigned: true });
  });

  // 503 is the gateway propagating "no signing key configured" from ai-service.
  // It must surface as unsigned rather than being swallowed, because an
  // unsigned ledger that nobody notices is exactly the state this whole change
  // exists to end.
  it.each([503, 502, 409])('reports HTTP %i as unsigned, once', async (status) => {
    const { fn, calls } = stubFetch(err(status, 'no signing key configured'));

    const outcome = await requestRootSignature('AC-1', { ...deps(), fetchImpl: fn });

    expect(outcome).toMatchObject({ kind: 'unsigned', status });
    expect(calls).toHaveLength(1);
  });

  it('never throws when the signer is unreachable', async () => {
    const { fn } = stubFetch(new Error('ECONNREFUSED'));

    const outcome = await requestRootSignature('AC-1', { ...deps(), fetchImpl: fn });

    // status 0 distinguishes "no response at all" from any HTTP answer.
    expect(outcome).toMatchObject({ kind: 'unsigned', status: 0 });
    expect((outcome as { detail: string }).detail).toContain('ECONNREFUSED');
  });

  it('percent-encodes the contract id', async () => {
    const { fn, calls } = stubFetch(ok({ signed: true, alreadySigned: false }));

    await requestRootSignature('AC/../admin', { ...deps(), fetchImpl: fn });

    expect(calls[0].url).toBe(`${GATEWAY}/api/contracts/AC%2F..%2Fadmin/root/sign`);
  });
});

describe('logTriggerOutcome', () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it('logs an unreachable gateway at error, naming the manual recovery', () => {
    const log = logger();
    logTriggerOutcome(log, 'AC-1', { kind: 'unavailable', attempts: 3, detail: 'timed out' });

    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error.mock.calls[0][1]).toContain('cannot settle');
  });

  it('logs a token mismatch at error, not warn', () => {
    const log = logger();
    logTriggerOutcome(log, 'AC-1', { kind: 'misconfigured', status: 401, detail: '' });

    expect(log.error).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs a terminal refusal at warn, since nothing is broken', () => {
    const log = logger();
    logTriggerOutcome(log, 'AC-1', { kind: 'declined', status: 409, detail: 'no freelancer' });

    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('says nothing when the trigger is disabled', () => {
    const log = logger();
    logTriggerOutcome(log, 'AC-1', { kind: 'disabled' });

    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
