/**
 * Unit tests for the settlement gate.
 *
 * `OracleStore` is the single definition of the condition that releases money
 * (Objective 4: `trustScore >= 85 && criticalVulns === 0`, plus the four CI
 * signals). It had no tests at all, which meant the one piece of logic whose
 * failure mode is "pays out when it should not" was the least covered code in
 * the repository.
 *
 * These run against a stub `pg.Pool` rather than a live Postgres. The gate is
 * pure decision logic over three query results, so faking the rows exercises
 * every branch — including the ones a seeded database makes awkward to reach,
 * like a null trust score or a missing oracle_state row — and the suite stays
 * runnable from a clean clone with no infrastructure. The SQL itself is
 * covered by the gateway and settlement-worker integration suites.
 */
import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import { OracleStore, TRUST_SCORE_THRESHOLD } from '../src/index.js';

interface StateRow {
  ast_passed: boolean;
  tests_passed: boolean;
  security_passed: boolean;
  trust_score: number | string | null;
  critical_vulns: number | string | null;
}

interface FakeData {
  /** null models "no oracle_state row exists for this contract". */
  state?: StateRow | null;
  scope?: { rejected: number | string; total: number | string };
  escrow?: Array<{ payment_id: string | null; amount_cents: number | string; currency: string | null }>;
}

/** Records every statement so tests can assert on what was actually queried. */
interface FakePool extends Pick<pg.Pool, 'query'> {
  calls: Array<{ sql: string; params: unknown[] }>;
}

function fakePool(data: FakeData): FakePool {
  const calls: Array<{ sql: string; params: unknown[] }> = [];

  const query = (async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });

    if (sql.includes('FROM oracle_state')) {
      const rows = data.state === undefined || data.state === null ? [] : [data.state];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM scope_checks')) {
      const rows = [data.scope ?? { rejected: '0', total: '0' }];
      return { rows, rowCount: 1 };
    }
    if (sql.includes('FROM escrow')) {
      const rows = data.escrow ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('INSERT INTO oracle_state')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  }) as unknown as pg.Pool['query'];

  return { query, calls };
}

/** Every signal satisfied — the only shape that should ever approve. */
const PASSING: StateRow = {
  ast_passed: true,
  tests_passed: true,
  security_passed: true,
  trust_score: 90,
  critical_vulns: 0,
};

function storeWith(data: FakeData) {
  const pool = fakePool(data);
  return { store: new OracleStore(pool as unknown as pg.Pool), pool };
}

describe('OracleStore.evaluate — approval', () => {
  it('approves only when every signal is satisfied', async () => {
    const { store } = storeWith({ state: PASSING });
    const verdict = await store.evaluate('c1');

    expect(verdict.approved).toBe(true);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.signals).toEqual({
      astPassed: true,
      testsPassed: true,
      securityPassed: true,
      scopePassed: true,
      trustScore: 90,
      criticalVulns: 0,
    });
  });

  it('approves exactly at the threshold, not just above it', async () => {
    // The gate is `>= 85`. An off-by-one to `> 85` would strand every contract
    // that scored precisely at the documented bar.
    const { store } = storeWith({ state: { ...PASSING, trust_score: TRUST_SCORE_THRESHOLD } });
    const verdict = await store.evaluate('c1');

    expect(verdict.approved).toBe(true);
    expect(verdict.signals.trustScore).toBe(85);
  });

  it('scopes both queries to the contract id it was asked about', async () => {
    const { store, pool } = storeWith({ state: PASSING });
    await store.evaluate('contract-xyz');

    expect(pool.calls).toHaveLength(2);
    for (const call of pool.calls) {
      expect(call.params).toEqual(['contract-xyz']);
    }
  });
});

describe('OracleStore.evaluate — a missing row is not a permissive default', () => {
  it('blocks a contract with no oracle_state row and says why', async () => {
    const { store } = storeWith({ state: null });
    const verdict = await store.evaluate('c1');

    expect(verdict.approved).toBe(false);
    expect(verdict.signals).toEqual({
      astPassed: false,
      testsPassed: false,
      securityPassed: false,
      scopePassed: true, // no chat traffic means no out-of-scope request
      trustScore: null,
      criticalVulns: null,
    });
    expect(verdict.blockers).toContain('no audit or score has been recorded for this contract');
    expect(verdict.blockers).toContain('no trust score recorded (XAI_SCORED never received)');
    expect(verdict.blockers).toContain('critical vulnerability count unknown');
  });

  it('treats an unscored contract as unscored, never as a pass', async () => {
    // null is "not yet scored". Coercing it through Number() would make it 0,
    // which compares below the threshold and happens to block for the wrong
    // reason; the blocker text is what proves the distinction is preserved.
    const { store } = storeWith({
      state: { ...PASSING, trust_score: null, critical_vulns: null },
    });
    const verdict = await store.evaluate('c1');

    expect(verdict.approved).toBe(false);
    expect(verdict.signals.trustScore).toBeNull();
    expect(verdict.signals.criticalVulns).toBeNull();
    expect(verdict.blockers).toContain('no trust score recorded (XAI_SCORED never received)');
    expect(verdict.blockers).not.toContain(`trust score 0 is below the ${TRUST_SCORE_THRESHOLD} threshold`);
  });
});

describe('OracleStore.evaluate — each signal blocks independently', () => {
  const cases: Array<[string, Partial<StateRow>, string]> = [
    ['AST', { ast_passed: false }, 'AST maintainability signal not satisfied'],
    ['tests', { tests_passed: false }, 'hidden test suite did not fully pass'],
    ['security', { security_passed: false }, 'security scan reported findings'],
  ];

  for (const [name, override, blocker] of cases) {
    it(`blocks when the ${name} signal fails, even with everything else green`, async () => {
      const { store } = storeWith({ state: { ...PASSING, ...override } });
      const verdict = await store.evaluate('c1');

      expect(verdict.approved).toBe(false);
      expect(verdict.blockers).toEqual([blocker]);
    });
  }

  it('blocks a trust score one point below the threshold', async () => {
    const { store } = storeWith({ state: { ...PASSING, trust_score: TRUST_SCORE_THRESHOLD - 1 } });
    const verdict = await store.evaluate('c1');

    expect(verdict.approved).toBe(false);
    expect(verdict.blockers).toEqual([`trust score 84 is below the ${TRUST_SCORE_THRESHOLD} threshold`]);
  });

  it('blocks on a single critical vulnerability regardless of a high score', async () => {
    // criticalVulns is a hard veto, not a term that a good score can outweigh.
    const { store } = storeWith({ state: { ...PASSING, trust_score: 100, critical_vulns: 1 } });
    const verdict = await store.evaluate('c1');

    expect(verdict.approved).toBe(false);
    expect(verdict.blockers).toEqual(['1 critical vulnerability(ies) present']);
  });

  it('reports every failing signal at once rather than only the first', async () => {
    const { store } = storeWith({
      state: {
        ast_passed: false,
        tests_passed: false,
        security_passed: false,
        trust_score: 10,
        critical_vulns: 3,
      },
      scope: { rejected: '2', total: '5' },
    });
    const verdict = await store.evaluate('c1');

    expect(verdict.approved).toBe(false);
    expect(verdict.blockers).toHaveLength(6);
  });
});

describe('OracleStore.evaluate — derived scope signal', () => {
  it('passes when checks exist and none were rejected', async () => {
    const { store } = storeWith({ state: PASSING, scope: { rejected: '0', total: '12' } });
    const verdict = await store.evaluate('c1');

    expect(verdict.signals.scopePassed).toBe(true);
    expect(verdict.approved).toBe(true);
  });

  it('blocks on any rejection and reports the count', async () => {
    const { store } = storeWith({ state: PASSING, scope: { rejected: '3', total: '12' } });
    const verdict = await store.evaluate('c1');

    expect(verdict.signals.scopePassed).toBe(false);
    expect(verdict.blockers).toEqual(['3 scope check(s) were rejected']);
  });

  it('treats no scope checks at all as neutral, matching the documented weakness', async () => {
    // A contract that never used the chat channel has made no out-of-scope
    // request. This is a stated limitation — avoiding the channel avoids the
    // signal — and the test exists so the behaviour cannot change silently.
    const { store } = storeWith({ state: PASSING, scope: { rejected: '0', total: '0' } });
    const verdict = await store.evaluate('c1');

    expect(verdict.signals.scopePassed).toBe(true);
  });

  it('excludes dismissed rows from the rejected count (V026)', async () => {
    // An admin-dismissed row (packages/oracle's evaluate() reads
    // `NOT allowed AND NOT dismissed`) must not count toward the gate — that
    // is the entire point of dismissal existing. The fake pool can't
    // distinguish dismissed from non-dismissed rows itself (it just returns
    // whatever `scope` the test supplies), so this asserts on the query text
    // rather than the resulting verdict: a regression that dropped the
    // `NOT dismissed` clause would still pass every other test in this file.
    const { store, pool } = storeWith({ state: PASSING, scope: { rejected: '0', total: '5' } });
    await store.evaluate('c1');

    const scopeCall = pool.calls.find((c) => c.sql.includes('FROM scope_checks'));
    expect(scopeCall?.sql).toContain('NOT allowed AND NOT dismissed');
  });

  it('does not read the scope signal from a stored column', async () => {
    // The scope verdict is derived from scope_checks on every read precisely so
    // a stored copy cannot disagree with the decisions it summarises.
    const { store, pool } = storeWith({ state: PASSING });
    await store.evaluate('c1');

    expect(pool.calls.some((c) => c.sql.includes('FROM scope_checks'))).toBe(true);
  });
});

describe('OracleStore.evaluate — pg numeric coercion', () => {
  it('handles counts and scores returned as strings', async () => {
    // node-postgres returns bigint counts and numeric columns as strings. If
    // these were compared without Number(), '9' > '85' is true by string
    // ordering and a score of 9 would sail through the gate.
    const { store } = storeWith({
      state: { ...PASSING, trust_score: '9', critical_vulns: '0' },
      scope: { rejected: '0', total: '3' },
    });
    const verdict = await store.evaluate('c1');

    expect(verdict.signals.trustScore).toBe(9);
    expect(verdict.approved).toBe(false);
    expect(verdict.blockers).toEqual([`trust score 9 is below the ${TRUST_SCORE_THRESHOLD} threshold`]);
  });

  it('handles a rejected count returned as a string', async () => {
    const { store } = storeWith({ state: PASSING, scope: { rejected: '1', total: '1' } });
    const verdict = await store.evaluate('c1');

    expect(verdict.signals.scopePassed).toBe(false);
  });

  it('treats a zero trust score as scored-and-failing, not as unscored', async () => {
    const { store } = storeWith({ state: { ...PASSING, trust_score: 0 } });
    const verdict = await store.evaluate('c1');

    expect(verdict.signals.trustScore).toBe(0);
    expect(verdict.blockers).toEqual([`trust score 0 is below the ${TRUST_SCORE_THRESHOLD} threshold`]);
  });
});

describe('OracleStore.findEscrowPayment', () => {
  it('returns the held payment when one is authorized', async () => {
    const { store } = storeWith({
      escrow: [{ payment_id: 'pay_123', amount_cents: '250000', currency: 'INR' }],
    });
    const found = await store.findEscrowPayment('c1');

    expect(found).toEqual({ paymentId: 'pay_123', amountMinor: 250000, currency: 'INR' });
  });

  it('returns null when nothing is authorized', async () => {
    const { store } = storeWith({ escrow: [] });
    expect(await store.findEscrowPayment('c1')).toBeNull();
  });

  it('selects only AUTHORIZED rows with a non-null payment id', async () => {
    // Matching 'PENDING' — which an earlier version did — hands the worker an
    // order no customer has funded, and it then tries to capture money that was
    // never authorised.
    const { store, pool } = storeWith({ escrow: [] });
    await store.findEscrowPayment('c1');

    const sql = pool.calls[0].sql;
    expect(sql).toContain("status = 'AUTHORIZED'");
    expect(sql).toContain('payment_id IS NOT NULL');
    expect(sql).not.toContain("'PENDING'");
  });

  it('takes the most recent escrow row', async () => {
    const { store, pool } = storeWith({
      escrow: [{ payment_id: 'pay_new', amount_cents: 100, currency: 'INR' }],
    });
    await store.findEscrowPayment('c1');

    expect(pool.calls[0].sql).toContain('ORDER BY created_at DESC');
    expect(pool.calls[0].sql).toContain('LIMIT 1');
  });

  it('defaults a null currency to INR', async () => {
    const { store } = storeWith({
      escrow: [{ payment_id: 'pay_1', amount_cents: 500, currency: null }],
    });
    const found = await store.findEscrowPayment('c1');

    expect(found?.currency).toBe('INR');
  });

  it('reads amount_cents as minor units without rescaling', async () => {
    // The column name predates the Razorpay change; it holds paise for INR.
    // Any division by 100 here would under-capture by two orders of magnitude.
    const { store } = storeWith({
      escrow: [{ payment_id: 'pay_1', amount_cents: '999', currency: 'INR' }],
    });
    const found = await store.findEscrowPayment('c1');

    expect(found?.amountMinor).toBe(999);
  });
});

describe('OracleStore writes', () => {
  it('upserts the three CI signals on recordAudit', async () => {
    const { store, pool } = storeWith({});
    await store.recordAudit('c1', { astPassed: true, testsPassed: false, securityPassed: true });

    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toContain('ON CONFLICT (contract_id) DO UPDATE');
    expect(pool.calls[0].params).toEqual(['c1', true, false, true]);
  });

  it('upserts the score and vulnerability count on recordScore', async () => {
    const { store, pool } = storeWith({});
    await store.recordScore('c1', 91, 0);

    expect(pool.calls[0].sql).toContain('ON CONFLICT (contract_id) DO UPDATE');
    // scoredAt is optional and defaults to null, which the SQL COALESCEs to
    // now() — an omitted timestamp must not become an implicit "oldest".
    expect(pool.calls[0].params).toEqual(['c1', 91, 0, null]);
  });

  it('passes the event timestamp through so a late score cannot win', async () => {
    // Two audits in quick succession produce two XAI_SCORED events. Redis
    // Streams delivers them in order; Kafka, which publish() supplies no
    // partition key for, can deliver them on different partitions and so out of
    // order. Without this guard the older score overwrites the newer one and
    // the settlement gate evaluates a stale number.
    const { store, pool } = storeWith({});
    await store.recordScore('c1', 91, 0, '2026-08-22T10:00:00.000Z');

    expect(pool.calls[0].params[3]).toBe('2026-08-22T10:00:00.000Z');
    expect(pool.calls[0].sql).toContain('oracle_state.scored_at <= EXCLUDED.scored_at');
    // IS NULL is the other half: a row created by recordAudit alone has no
    // scored_at, and must still accept its first score.
    expect(pool.calls[0].sql).toContain('oracle_state.scored_at IS NULL');
  });

  it('does not let recordAudit clobber a previously recorded score', async () => {
    // The two writers touch disjoint columns and arrive in either order — the
    // audit event and the scoring event are independent. An upsert that listed
    // every column would reset trust_score to null whichever arrived second.
    const { store, pool } = storeWith({});
    await store.recordAudit('c1', { astPassed: true, testsPassed: true, securityPassed: true });

    const updateClause = pool.calls[0].sql.split('DO UPDATE')[1];
    expect(updateClause).not.toContain('trust_score');
    expect(updateClause).not.toContain('critical_vulns');
  });

  it('does not let recordScore clobber previously recorded CI signals', async () => {
    const { store, pool } = storeWith({});
    await store.recordScore('c1', 91, 0);

    const updateClause = pool.calls[0].sql.split('DO UPDATE')[1];
    expect(updateClause).not.toContain('ast_passed');
    expect(updateClause).not.toContain('tests_passed');
    expect(updateClause).not.toContain('security_passed');
  });
});
