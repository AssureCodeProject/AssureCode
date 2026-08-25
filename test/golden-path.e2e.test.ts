/**
 * The golden path: one contract, initialize to settled, with nothing mocked.
 *
 * Every other suite in this repository tests a piece. This is the only one that
 * drives a contract through the whole lifecycle and asserts what the system was
 * built to guarantee — that a push can reach a released escrow with no human in
 * the loop, that the ledger still verifies afterwards, and that settling twice
 * is impossible.
 *
 * plan2 DoD #3, #5 and #6 all point here.
 *
 * How it runs
 * -----------
 * The gateway and both workers are imported into this process and share one
 * Redis bus — `EVENT_BUS_FORCE_REAL=true`, set by scripts/e2e.mjs, is what
 * disables the in-memory-bus shortcut that would otherwise give each of them a
 * private bus and make the whole test meaningless. ai-service and scope-guard
 * run as host processes started by the same script; the trust score has no
 * fallback path, so without a real scorer this test cannot exist.
 *
 * The gateway is driven through `server.inject()` rather than over TCP: it is
 * the same Fastify request pipeline, and it removes a listening port from the
 * set of things that can flake.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import { buildDbConfig, getDatabaseUrl, loadConfig } from '@assurecode/config';

const CLIENT_EMAIL = 'client@acme.com';
const CLIENT_PASSWORD = 'demo1234';

/** The pipeline is asynchronous; poll rather than sleep a fixed amount. */
async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null>,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last !== null) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
}

describe('golden path — a contract from initialization to settlement', () => {
  let server: any;
  let pool: pg.Pool;
  let token: string;
  let contractId: string;
  let freelancerId: string;
  let orderId: string;

  beforeAll(async () => {
    // Imported here, not at module scope: importing the gateway constructs its
    // pool and bus, and that must happen after the harness env is in place.
    server = (await import('../apps/api-gateway/src/server.js')).default;

    // The gateway has to be listening on a real port, not just `ready()`.
    // settlement-worker's automatic scoring trigger is an *HTTP* call to
    // GATEWAY_URL — driving the gateway through inject() alone leaves that URL
    // pointing at whatever happens to occupy the default :4000, which is how
    // this first ran: the worker got a 401 from an unrelated dev gateway and
    // reported a SERVICE_TOKEN mismatch.
    await server.listen({ port: 0, host: '127.0.0.1' });
    const port = (server.server.address() as { port: number }).port;
    process.env.GATEWAY_URL = `http://127.0.0.1:${port}`;

    // Imported only now: both workers read their config at module scope, so
    // GATEWAY_URL must already be correct.
    const ci = await import('../apps/ci-worker/src/worker.js');
    const settlement = await import('../apps/settlement-worker/src/worker.js');
    await ci.start();
    await settlement.start();

    pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));

    const login = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: CLIENT_EMAIL, password: CLIENT_PASSWORD },
    });
    expect(login.statusCode, `login failed: ${login.body}`).toBe(200);
    token = login.json().token;
    expect(token).toBeTruthy();
  }, 180_000);

  afterAll(async () => {
    if (contractId) {
      await pool?.query('DELETE FROM settlements WHERE contract_id = $1', [contractId]);
      await pool?.query('DELETE FROM oracle_state WHERE contract_id = $1', [contractId]);
      await pool?.query('DELETE FROM merkle_roots WHERE contract_id = $1', [contractId]);
      await pool?.query('DELETE FROM merkle_ledger WHERE contract_id = $1', [contractId]);
      await pool?.query('DELETE FROM escrow WHERE contract_id = $1', [contractId]);
      await pool?.query('DELETE FROM audit_results WHERE contract_id = $1', [contractId]);
      await pool?.query('DELETE FROM contracts WHERE contract_id = $1', [contractId]);
    }
    await pool?.end();
    await server?.close();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  it('initializes a contract and anchors it in the ledger', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/initialize',
      headers: auth(),
      payload: {
        title: 'Golden path contract',
        requirements: 'Build a small utility module with an add function and unit tests.',
        budgetCents: 250000,
        deadline: '2026-12-31',
      },
    });

    expect(res.statusCode, res.body).toBe(201);
    contractId = res.json().contractId;
    expect(contractId).toBeTruthy();

    const { rows } = await pool.query(
      `SELECT status FROM contracts WHERE contract_id = $1`,
      [contractId],
    );
    expect(rows).toHaveLength(1);
  }, 60_000);

  it('assigns a freelancer from the matchmaker', async () => {
    const match = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/match`,
      headers: auth(),
      payload: { requirements: 'utility module with unit tests', topK: 3 },
    });
    expect(match.statusCode, match.body).toBe(200);

    const results = match.json().results ?? [];
    expect(results.length).toBeGreaterThan(0);
    freelancerId = results[0].freelancer_id ?? results[0].freelancerId;

    const assign = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/assign`,
      headers: auth(),
      payload: { freelancerId },
    });
    expect(assign.statusCode, assign.body).toBe(200);

    // The contract's first ledger append happens here, not at initialize. Its
    // current_hash is H0 — the identifier every later scope decision anchors
    // to, so that a decision stays checkable against the contract as it was
    // hashed rather than as the text reads later.
    const { rows } = await pool.query(
      `SELECT previous_hash, action_type FROM merkle_ledger
        WHERE contract_id = $1 ORDER BY ledger_id ASC LIMIT 1`,
      [contractId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].previous_hash).toBe('GENESIS');
    // The real embedder is in play, so matching is not instant.
  }, 120_000);

  it('generates a test bundle and locks the contract', async () => {
    const gen = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/generate-tests`,
      headers: auth(),
      payload: {
        title: 'Golden path contract',
        requirements: 'Build a small utility module with an add function and unit tests.',
        framework: 'jest',
      },
    });
    expect(gen.statusCode, gen.body).toBe(200);

    const lock = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/lock`,
      headers: auth(),
      payload: {
        title: 'Golden path contract',
        requirements: 'Build a small utility module with an add function and unit tests.',
        budgetCents: 250000,
        deadline: '2026-12-31',
      },
    });
    expect(lock.statusCode, lock.body).toBe(200);
    expect(lock.json().hash).toMatch(/^[0-9a-f]{64}$/);

    // /lock kicks off the RAG ingest fire-and-forget, so the corpus the scope
    // guard retrieves against arrives after the response. Without waiting, a
    // scope check races it and the guard correctly refuses for want of an
    // indexed contract — which looks like a scope decision and is not one.
    await waitFor('rag_embeddings chunks', async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM rag_embeddings WHERE contract_id = $1`,
        [contractId],
      );
      return rows[0].n > 0 ? rows[0].n : null;
    }, 60_000);
  }, 120_000);

  it('funds the escrow', async () => {
    const escrow = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/escrow`,
      headers: auth(),
      payload: { amountMinor: 250000, currency: 'INR' },
    });
    expect(escrow.statusCode, escrow.body).toBe(200);

    // FakeRazorpayAdapter is in play (the key id is not an `rzp_` key), so the
    // authorization that a real Checkout would produce is simulated here. The
    // gateway still verifies the HMAC — the fake computes a real one.
    const { rows } = await pool.query(
      `SELECT order_id, status FROM escrow WHERE contract_id = $1`,
      [contractId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PENDING');
    orderId = rows[0].order_id;

    // Razorpay authorizes the payment out-of-band and tells the gateway over a
    // signed webhook — the browser's word is worth exactly the HMAC attached to
    // it, so the gateway re-derives that server-side. Driving the real webhook
    // route rather than writing 'AUTHORIZED' into the table is the difference
    // between testing the escrow and testing an UPDATE statement.
    const paymentId = `pay_golden_${Date.now()}`;
    const body = JSON.stringify({
      entity: 'event',
      event: 'payment.authorized',
      account_id: 'acc_TEST',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: orderId,
            status: 'authorized',
            amount: 250000,
            currency: 'INR',
            notes: { contractId },
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    });
    const signature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET as string)
      .update(body)
      .digest('hex');

    const hook = await server.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': `evt_golden_${Date.now()}`,
      },
      payload: body,
    });
    expect(hook.statusCode, hook.body).toBe(200);

    // ESCROW_LOCKED travels over the bus to settlement-worker, which is what
    // moves the row to AUTHORIZED. Until it does, there is no captured payment
    // for the oracle to release.
    await waitFor('escrow AUTHORIZED', async () => {
      const { rows: e } = await pool.query(
        `SELECT status, payment_id FROM escrow WHERE contract_id = $1 AND status = 'AUTHORIZED'`,
        [contractId],
      );
      return e[0] ?? null;
    }, 60_000);
  }, 120_000);

  // The assertion this whole file exists for: a push, and nothing else, ends
  // with both an audit and a trust score. Before the automatic scoring trigger
  // the score only appeared when a human opened the XAI tab in a browser.
  it('audits and scores the push with no human in the loop', async () => {
    const push = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/simulate-push`,
      headers: auth(),
      payload: {},
    });
    expect(push.statusCode, push.body).toBe(200);

    // The sandbox's own execution budget is 120s (docker-sandbox.ts's default
    // timeoutMs) before it even reports a result, so this wait needs headroom
    // above that rather than the file's generic 120s default — otherwise the
    // two waitFor calls in this test can together exceed the outer it()
    // timeout below even when the pipeline is working, not broken.
    const audit = await waitFor(
      'audit_results row',
      async () => {
        // Everything the pipeline measured lives in a single JSONB payload —
        // audit_results has only (audit_id, contract_id, payload, passed).
        const { rows } = await pool.query(
          `SELECT payload FROM audit_results
          WHERE contract_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [contractId],
        );
        return rows[0]?.payload ?? null;
      },
      140_000,
    );
    // A run that executed no tests is indeterminate, never a pass — so a
    // golden path that reached 0/0 has not demonstrated anything.
    expect(Number(audit.totalTests)).toBeGreaterThan(0);
    expect(Number(audit.passedTests)).toBe(Number(audit.totalTests));

    // Scoring only needs an AI-service round trip once the audit lands, so
    // this stays well under the file's 120s default.
    const state = await waitFor(
      'oracle_state.trust_score',
      async () => {
        const { rows } = await pool.query(
          `SELECT ast_passed, tests_passed, security_passed, trust_score, critical_vulns
           FROM oracle_state WHERE contract_id = $1 AND trust_score IS NOT NULL`,
          [contractId],
        );
        return rows[0] ?? null;
      },
      60_000,
    );

    expect(Number(state.trust_score)).toBeGreaterThanOrEqual(0);
    expect(state.ast_passed).toBe(true);
    expect(state.tests_passed).toBe(true);
  }, 240_000);

  it('settles, and the settlement is single-fire', async () => {
    const oracle = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/oracle`,
      headers: auth(),
    });
    expect(oracle.statusCode, oracle.body).toBe(200);
    const verdict = oracle.json();

    // Reported rather than silently tolerated: if the gate refuses, the reason
    // belongs in the failure message, not buried in a log.
    expect(verdict.approved, `oracle refused: ${JSON.stringify(verdict.blockers)}`).toBe(true);

    // Five concurrent settle calls. Exactly one settlement row must exist.
    const settles = await Promise.all(
      Array.from({ length: 5 }, () =>
        server.inject({
          method: 'POST',
          url: `/api/contracts/${contractId}/settle`,
          headers: auth(),
          payload: { freelancerId, amountCents: 250000 },
        }),
      ),
    );
    expect(settles.some((r: any) => r.statusCode === 202)).toBe(true);

    // The same route with no body must be refused before anything is
    // published — a settle that reaches the worker with an undefined
    // freelancerId captures the payment and then fails to write the ledger.
    const noBody = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/settle`,
      headers: auth(),
      payload: {},
    });
    expect(noBody.statusCode).toBe(400);

    const settlement = await waitFor('settlement COMPLETED', async () => {
      const { rows } = await pool.query(
        `SELECT status FROM settlements WHERE contract_id = $1 AND status = 'COMPLETED'`,
        [contractId],
      );
      return rows[0] ?? null;
    });
    expect(settlement.status).toBe('COMPLETED');

    const { rows: all } = await pool.query(
      `SELECT contract_id FROM settlements WHERE contract_id = $1`,
      [contractId],
    );
    expect(all).toHaveLength(1);
  }, 180_000);

  it('leaves a ledger that still verifies, sealed under a Merkle root', async () => {
    const verify = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/verify`,
      headers: auth(),
    });
    expect(verify.statusCode, verify.body).toBe(200);
    expect(verify.json().valid).toBe(true);

    const root = await waitFor('merkle root', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/contracts/${contractId}/root`,
        headers: auth(),
      });
      return res.statusCode === 200 ? res.json() : null;
    });

    expect(root.rootHash).toMatch(/^[0-9a-f]{64}$/);
    expect(root.leafCount).toBeGreaterThan(0);
    expect(root.chainValid).toBe(true);
    // Signing needs ML_DSA_SEED_HEX, which this harness does not set. The point
    // is that the route reports the truth either way rather than asserting a
    // signature that is not there.
    expect(typeof root.signature.signed).toBe('boolean');
  }, 120_000);

  it('refuses an out-of-scope request through the scope guard', async () => {
    // The gateway allows the scope guard 5 seconds. scope-guard loads
    // sentence-transformers lazily on its first embed, which costs more than
    // that on a cold process — so the first call times out and the gateway
    // correctly reports the guard unreachable rather than guessing.
    //
    // Retried rather than given a longer budget, because the timeout is the
    // gateway's real production behaviour and this test should not pretend
    // otherwise. Each attempt leaves the model further along; in practice the
    // second or third succeeds. A cold start being visible here is a finding
    // worth keeping, not one to paper over — see the 300s startupProbe on
    // ai-service in infra/k8s/09-ai-service.yaml for the deployed equivalent.
    const ask = () =>
      server.inject({
        method: 'POST',
        url: `/api/contracts/${contractId}/chat`,
        headers: auth(),
        payload: { message: 'Also design a new company logo and set up our office wifi.' },
      });

    let res = await ask();
    for (let attempt = 0; attempt < 5 && res.statusCode === 503; attempt += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      res = await ask();
    }

    // 403 is the mediated refusal: the gateway declines to relay a request the
    // guard judged outside the contract, and returns the mediation text the UI
    // shows. A 2xx would mean it was let through, which for this message is the
    // one outcome that must never happen.
    expect(res.statusCode, res.body).toBe(403);
    const body = res.json();
    expect(body.blocked).toBe(true);
    expect(body.delivered).toBe(false);
    // The refusal names the contract hash it judged against — H0, not the
    // current text. That anchoring is the point of the design.
    expect(body.mediation).toMatch(/contract hash/i);

    const { rows } = await pool.query(
      `SELECT allowed, genesis_hash FROM scope_checks WHERE contract_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [contractId],
    );
    expect(rows).toHaveLength(1);
    // Every decision is anchored to H0 — the contract as hashed, not as it
    // reads now. That anchoring is the point of the design.
    expect(rows[0].genesis_hash).toBeTruthy();
  }, 180_000);
});
