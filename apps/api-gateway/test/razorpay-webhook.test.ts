/**
 * Route-level tests for the Razorpay webhook.
 *
 * These run without a database. The signature check happens before any query,
 * so rejection paths are fully exercisable offline — and they are the paths
 * worth pinning hardest, because a webhook endpoint that accepts unsigned input
 * lets anyone mark an escrow as funded.
 *
 * Both adapters verify real HMACs rather than waving signatures through, so
 * these tests are meaningful whichever one the gateway booted with — the
 * previous Stripe fake returned `valid: false` unconditionally, so no test
 * could reach past the signature gate and the route's success path was never
 * covered at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import server from '../src/server.js';
import { FAKE_WEBHOOK_SECRET } from '@assurecode/razorpay-adapter';
import { loadConfig, buildDbConfig, getDatabaseUrl } from '@assurecode/config';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('Razorpay webhook — escrow lookups', 'a running PostgreSQL on DATABASE_URL');

/**
 * The secret the gateway under test actually loaded.
 *
 * Hardcoding FAKE_WEBHOOK_SECRET here was wrong: it only holds while the key id
 * is not a real `rzp_` one. The moment real credentials land in .env the
 * gateway builds RazorpayPaymentAdapter, which verifies against
 * RAZORPAY_WEBHOOK_SECRET — and every correctly-signed test body started
 * failing with a 401 that looked like a route bug rather than a test that had
 * signed with the wrong key. Read the same value the gateway read.
 */
const WEBHOOK_SECRET = loadConfig().RAZORPAY_WEBHOOK_SECRET || FAKE_WEBHOOK_SECRET;

/** Sign a body the way Razorpay does: hex HMAC-SHA256 over the raw bytes. */
function sign(rawBody: string, secret = WEBHOOK_SECRET): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function webhookBody(event: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    entity: 'event',
    event,
    account_id: 'acc_TEST',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: 'pay_TESTPAYMENT1',
          order_id: 'order_TESTORDER1',
          status: event === 'payment.failed' ? 'failed' : 'authorized',
          amount: 250000,
          currency: 'INR',
          notes: { contractId: 'AC-TEST-1' },
          ...overrides,
        },
      },
    },
    created_at: 1700000000,
  });
}

function inject(payload: string, signature: string, eventId = 'evt_test_1') {
  return server.inject({
    method: 'POST',
    url: '/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
    payload,
  });
}

describe('POST /webhooks/razorpay — authentication', () => {
  it('is reachable without a JWT — the HMAC is the authentication', async () => {
    // /webhooks/ is in the auth plugin's public prefix list. If that regressed,
    // Razorpay could not call us at all and this would be a 401 with an
    // "Unauthorized" body rather than the signature rejection below.
    const res = await inject(webhookBody('payment.authorized'), 'deadbeef');

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Invalid signature' });
  });

  it('rejects a body with no signature header', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: { 'content-type': 'application/json' },
      payload: webhookBody('payment.authorized'),
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const body = webhookBody('payment.authorized');
    const res = await inject(body, sign(body, 'definitely-not-the-webhook-secret'));

    expect(res.statusCode).toBe(401);
  });

  it('rejects a body tampered with after signing', async () => {
    const body = webhookBody('payment.authorized');
    const signature = sign(body);
    const tampered = body.replace('"amount":250000', '"amount":1');

    expect(tampered).not.toBe(body);

    const res = await inject(tampered, signature);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a re-serialised body — the raw bytes are what was signed', async () => {
    // The regression that made every genuine webhook 401 under the previous
    // provider: verifying JSON.stringify(request.body) rather than the bytes on
    // the wire. Same JSON value, different bytes.
    //
    // Pretty-printed on purpose. A body built with JSON.stringify is already
    // compact, so round-tripping it through parse/stringify returns the
    // identical string and proves nothing — the whitespace here is what makes
    // the two byte sequences actually differ.
    const body = [
      '{',
      '  "entity": "event",',
      '  "event": "payment.authorized",',
      '  "payload": {',
      '    "payment": { "entity": { "id": "pay_TEST1", "order_id": "order_TEST1", "amount": 250000 } }',
      '  }',
      '}',
    ].join('\n');
    const signature = sign(body);
    const reSerialised = JSON.stringify(JSON.parse(body));

    expect(reSerialised).not.toBe(body);

    const res = await inject(reSerialised, signature);
    expect(res.statusCode).toBe(401);
  });

  it('rejects an empty body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': sign(''),
      },
      payload: '',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Empty request body' });
  });

  it('does not 500 on a truncated signature', async () => {
    // timingSafeEqual throws on a length mismatch; the adapter must absorb it.
    const body = webhookBody('payment.authorized');
    const res = await inject(body, sign(body).slice(0, 20));

    expect(res.statusCode).toBe(401);
  });
});

describe.skipIf(!PG_UP)('POST /webhooks/razorpay — with a live database', () => {
  it('accepts a correctly signed event for an unknown escrow without erroring', async () => {
    // 200, not 404: answering non-2xx makes Razorpay retry an event we have
    // already decided we cannot act on, forever.
    const body = webhookBody('payment.authorized', { order_id: 'order_DOES_NOT_EXIST' });
    const res = await inject(body, sign(body), `evt_unknown_${Date.now()}`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
  });

  it('is idempotent — a redelivered event id is a no-op', async () => {
    // Razorpay retries until it gets a 2xx, so the same event arriving twice is
    // routine. Both calls must answer 200, and the second must not re-apply
    // anything; the unique index on payment_events.provider_event_id is what
    // makes that atomic.
    const body = webhookBody('payment.authorized', { order_id: 'order_DOES_NOT_EXIST' });
    const signature = sign(body);
    const eventId = `evt_replay_${Date.now()}`;

    const first = await inject(body, signature, eventId);
    const second = await inject(body, signature, eventId);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });
});

/**
 * The audit-trail regression suite.
 *
 * `payment_events` is the money-movement audit log, and it spent its entire
 * existence empty: the original insert named a column the table did not have,
 * and the failure was swallowed by a catch block that logged and continued. The
 * fix reintroduced the same *class* of bug in a new form — `ON CONFLICT
 * (provider_event_id)` cannot infer a partial unique index unless the statement
 * repeats the index predicate, so every insert raised 42P10 into that same
 * catch, and the table stayed empty exactly as before.
 *
 * Both bugs share a shape: the write fails, nothing throws, and no test noticed
 * because no test asserted a row had actually landed. So these assert on rows,
 * not on the absence of an exception.
 */
describe.skipIf(!PG_UP)('payment_events is actually written', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  const contractId = `AC-WEBHOOK-TEST-${Date.now()}`;
  const orderId = `order_test_${Date.now()}`;
  const paymentId = `pay_test_${Date.now()}`;

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO contracts (contract_id, client_id, title, requirements, budget_cents, deadline, status)
       VALUES ($1, 'legacy-client', 'webhook audit test', 'n/a', 250000, '2026-12-31', 'LOCKED')
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId],
    );
    await pool.query(
      `INSERT INTO escrow (order_id, contract_id, amount_cents, currency, status)
       VALUES ($1, $2, 250000, 'INR', 'PENDING')
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, contractId],
    );
  });

  afterAll(async () => {
    // contracts cascades to escrow; payment_events has no FK, so clear it too.
    await pool.query(`DELETE FROM payment_events WHERE contract_id = $1`, [contractId]);
    await pool.query(`DELETE FROM escrow WHERE contract_id = $1`, [contractId]);
    await pool.query(`DELETE FROM merkle_ledger WHERE contract_id = $1`, [contractId]);
    await pool.query(`DELETE FROM contracts WHERE contract_id = $1`, [contractId]);
    await pool.end();
  });

  it('writes a row, and a redelivery does not write a second', async () => {
    const body = webhookBody('payment.authorized', { id: paymentId, order_id: orderId });
    const signature = sign(body);
    const eventId = `evt_audit_${Date.now()}`;

    const first = await inject(body, signature, eventId);
    expect(first.statusCode).toBe(200);

    // The assertion the previous two bugs both slipped past.
    const afterFirst = await pool.query(
      `SELECT event_type, order_id, payment_id, amount_cents, provider, provider_event_id
         FROM payment_events WHERE contract_id = $1`,
      [contractId],
    );
    expect(afterFirst.rowCount).toBe(1);
    expect(afterFirst.rows[0]).toMatchObject({
      event_type: 'payment.authorized',
      order_id: orderId,
      payment_id: paymentId,
      amount_cents: 250000,
      provider: 'razorpay',
      provider_event_id: eventId,
    });

    // Razorpay retries until it gets a 2xx, so this is routine, not exotic.
    const second = await inject(body, signature, eventId);
    expect(second.statusCode).toBe(200);

    const afterSecond = await pool.query(
      `SELECT count(*)::int AS n FROM payment_events WHERE contract_id = $1`,
      [contractId],
    );
    expect(afterSecond.rows[0].n).toBe(1);
  });

  it('moved the escrow to AUTHORIZED exactly once', async () => {
    const escrow = await pool.query(
      `SELECT status, payment_id, authorized_at FROM escrow WHERE order_id = $1`,
      [orderId],
    );
    expect(escrow.rows[0].status).toBe('AUTHORIZED');
    expect(escrow.rows[0].payment_id).toBe(paymentId);
    expect(escrow.rows[0].authorized_at).not.toBeNull();

    // One ledger entry, not two — the redelivery above must not have appended a
    // second ESCROW_AUTHORIZED to the hash chain.
    const ledger = await pool.query(
      `SELECT count(*)::int AS n FROM merkle_ledger
        WHERE contract_id = $1 AND action_type = 'ESCROW_AUTHORIZED'`,
      [contractId],
    );
    expect(ledger.rows[0].n).toBe(1);
  });
});

describe('POST /api/contracts/:id/escrow/verify — authentication', () => {
  it('requires authentication', async () => {
    // Unlike the webhook, this route carries no HMAC of its own until the body
    // is read, so it sits behind the normal JWT guard and the clientVerified
    // KYC gate.
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/AC-TEST-1/escrow/verify',
      payload: {
        razorpayOrderId: 'order_x',
        razorpayPaymentId: 'pay_x',
        razorpaySignature: 'ab'.repeat(32),
      },
    });

    expect(res.statusCode).toBe(401);
  });
});
