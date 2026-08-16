/**
 * Tests for correlation propagation and the metric definitions.
 *
 * `packages/telemetry` had no test script and no tests. Two things here are
 * worth pinning:
 *
 *   1. Correlation ids must survive `await`. They are how a single contract is
 *      followed across the gateway, the bus and the workers, and an
 *      AsyncLocalStorage context that is lost at an await boundary fails
 *      silently — logs simply stop carrying the id.
 *
 *   2. No metric may carry an unbounded label. `contract_id` was deliberately
 *      excluded from these definitions; an assertion is what stops it being
 *      added back by someone who wants a per-contract dashboard.
 */
import { describe, it, expect } from 'vitest';
import { getCorrelationId, runWithCorrelationId } from '../src/correlation.js';
import { metrics, metricsRegistry } from '../src/metrics.js';

describe('correlation context', () => {
  it('exposes the id inside the scope', () => {
    runWithCorrelationId('corr-1', () => {
      expect(getCorrelationId()).toBe('corr-1');
    });
  });

  it('is undefined outside any scope', () => {
    expect(getCorrelationId()).toBeUndefined();
  });

  it('does not leak out of the scope', () => {
    runWithCorrelationId('corr-1', () => getCorrelationId());
    expect(getCorrelationId()).toBeUndefined();
  });

  it('survives an await boundary', async () => {
    // The failure this guards against is silent: logs after the first await
    // simply stop carrying the id, and a trace looks truncated rather than
    // broken.
    await runWithCorrelationId('corr-async', async () => {
      expect(getCorrelationId()).toBe('corr-async');
      await new Promise((r) => setTimeout(r, 1));
      expect(getCorrelationId()).toBe('corr-async');
    });
  });

  it('keeps concurrent operations isolated', async () => {
    // Two in-flight requests must not see each other's id. A module-level
    // variable would pass every test above and fail this one.
    const seen: string[] = [];
    const task = (id: string, delay: number) =>
      runWithCorrelationId(id, async () => {
        await new Promise((r) => setTimeout(r, delay));
        seen.push(getCorrelationId()!);
      });

    await Promise.all([task('a', 10), task('b', 1), task('c', 5)]);

    expect(seen.sort()).toEqual(['a', 'b', 'c']);
  });

  it('nests, restoring the outer id afterwards', () => {
    runWithCorrelationId('outer', () => {
      runWithCorrelationId('inner', () => {
        expect(getCorrelationId()).toBe('inner');
      });
      expect(getCorrelationId()).toBe('outer');
    });
  });

  it('returns the callback value', () => {
    expect(runWithCorrelationId('x', () => 42)).toBe(42);
  });
});

describe('metric label cardinality', () => {
  it('gives no metric an unbounded label', async () => {
    // The reasoning is recorded in metrics.ts: per-contract data belongs in
    // traces, because one series per contract is how a Prometheus server dies.
    const forbidden = ['contract_id', 'contractId', 'user_id', 'freelancer_id', 'email', 'payment_id'];
    const exposition = await metricsRegistry.metrics();

    for (const label of forbidden) {
      expect(exposition).not.toContain(`${label}=`);
    }
  });

  it('registers every metric on the shared registry', async () => {
    const exposition = await metricsRegistry.metrics();
    for (const name of [
      'assurecode_ledger_appends_total',
      'assurecode_event_bus_lag_seconds',
      'assurecode_settlement_operations_total',
    ]) {
      expect(exposition).toContain(name);
    }
  });
});

describe('metrics facade', () => {
  it('exposes the Prometheus content type', () => {
    expect(metrics.getMetricsContentType()).toContain('text/plain');
  });

  it('renders an exposition body', async () => {
    const body = await metrics.getMetrics();
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(0);
  });

  it('emits HELP and TYPE lines for each family', async () => {
    // Without these a Prometheus scrape still works but the metric is
    // undocumented in every UI that reads it.
    const body = await metrics.getMetrics();
    expect(body).toContain('# HELP');
    expect(body).toContain('# TYPE');
  });

  it('counts a ledger append under its action type and status', async () => {
    metrics.ledgerAppendsTotal.labels({ action_type: 'CONTRACT_LOCKED', status: 'success' }).inc();
    const body = await metrics.getMetrics();
    expect(body).toContain('action_type="CONTRACT_LOCKED"');
    expect(body).toContain('status="success"');
  });

  it('observes event-bus lag by topic', async () => {
    metrics.eventBusLagSeconds.observe({ topic: 'contract.locked' }, 0.25);
    const body = await metrics.getMetrics();
    expect(body).toContain('assurecode_event_bus_lag_seconds_bucket');
    expect(body).toContain('topic="contract.locked"');
  });
});
