/**
 * Deliver a signed Razorpay webhook to a local gateway.
 *
 * Razorpay cannot reach localhost, so the webhook handler is the one part of
 * the payment path a developer cannot exercise without a tunnel. This script
 * removes that constraint: it builds the event body Razorpay would send, signs
 * it with RAZORPAY_WEBHOOK_SECRET exactly as Razorpay does (hex HMAC-SHA256
 * over the raw bytes, in `x-razorpay-signature`), and POSTs it to the gateway.
 *
 * It is a *delivery* mechanism, not a mock. The gateway verifies the signature
 * for real, dedupes on the real header, and takes the real database path — so a
 * signature bug or a broken dedupe fails here exactly as it would in production.
 * What it cannot tell you is whether Razorpay's dashboard configuration is
 * right; only a tunnel proves that.
 *
 * Usage:
 *   node tools/razorpay-webhook-replay.mjs --order order_xxx --payment pay_xxx
 *   node tools/razorpay-webhook-replay.mjs --order order_xxx --event payment.failed
 *   node tools/razorpay-webhook-replay.mjs --order order_xxx --replay
 *
 * Flags:
 *   --order    <id>   Razorpay order id. Required — it is how the gateway finds the escrow.
 *   --payment  <id>   Payment id. Defaults to a generated pay_replay_* value.
 *   --event    <name> payment.authorized (default) | payment.failed | payment.captured | order.paid
 *   --amount   <n>    Minor units (paise). Display only; the gateway trusts its own escrow row.
 *   --event-id <id>   The x-razorpay-event-id used for dedupe. Defaults to a fresh one.
 *   --replay          Send the same event twice, to prove the second is a no-op.
 *   --url      <url>  Gateway base URL. Defaults to GATEWAY_URL or http://localhost:4000.
 */
import crypto from 'node:crypto';
import { loadConfig } from '@assurecode/config';

const config = loadConfig();

// ── Arguments ──────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const orderId = flag('order');
const paymentId = flag('payment', `pay_replay_${Date.now()}`);
const eventName = flag('event', 'payment.authorized');
const amountMinor = Number(flag('amount', '250000'));
const eventId = flag('event-id', `evt_replay_${Date.now()}`);
const baseUrl = (flag('url', process.env.GATEWAY_URL || config.GATEWAY_URL) || '').replace(/\/$/, '');

const VALID_EVENTS = ['payment.authorized', 'payment.failed', 'payment.captured', 'order.paid'];

if (!orderId) {
  console.error('error: --order is required.\n');
  console.error('Find it in the escrow table or the escrow-create response:');
  console.error("  psql $DATABASE_URL -c \"SELECT order_id, status FROM escrow ORDER BY created_at DESC LIMIT 5\"");
  process.exit(1);
}

if (!VALID_EVENTS.includes(eventName)) {
  console.error(`error: --event must be one of: ${VALID_EVENTS.join(', ')}`);
  process.exit(1);
}

const webhookSecret = config.RAZORPAY_WEBHOOK_SECRET;
if (!webhookSecret) {
  console.error('error: RAZORPAY_WEBHOOK_SECRET is not set.\n');
  console.error('It must match what the gateway loaded, or every delivery is rejected 401.');
  console.error('Set the same value in .env and in the Razorpay dashboard (Settings → Webhooks).');
  process.exit(1);
}

// ── Build the event ────────────────────────────────────────────────────

/**
 * The shape Razorpay actually posts. Note there is no event id in the body —
 * it travels in the x-razorpay-event-id header, which is why the gateway reads
 * it from there and why this script sets it explicitly.
 */
function buildBody() {
  const failed = eventName === 'payment.failed';
  const entity = {
    id: paymentId,
    entity: 'payment',
    amount: amountMinor,
    currency: 'INR',
    status: failed ? 'failed' : eventName === 'payment.captured' ? 'captured' : 'authorized',
    order_id: orderId,
    captured: eventName === 'payment.captured',
    method: 'card',
    ...(failed
      ? { error_code: 'BAD_REQUEST_ERROR', error_description: 'Replayed failure from tools/razorpay-webhook-replay.mjs' }
      : {}),
  };

  return JSON.stringify({
    entity: 'event',
    account_id: 'acc_replay',
    event: eventName,
    contains: eventName === 'order.paid' ? ['order', 'payment'] : ['payment'],
    payload: {
      payment: { entity },
      ...(eventName === 'order.paid'
        ? { order: { entity: { id: orderId, entity: 'order', amount: amountMinor, currency: 'INR', status: 'paid' } } }
        : {}),
    },
    created_at: Math.floor(Date.now() / 1000),
  });
}

async function deliver(body, id, label) {
  // Sign the exact bytes being sent. Serialising once and reusing the string is
  // the whole point — signing one representation and sending another is the
  // classic way to make every genuine webhook fail verification.
  const signature = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');

  const res = await fetch(`${baseUrl}/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': id,
    },
    body,
  });

  const text = await res.text();
  const ok = res.status === 200;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: HTTP ${res.status} ${text}`);
  return ok;
}

// ── Run ────────────────────────────────────────────────────────────────

console.log(`\nDelivering ${eventName} to ${baseUrl}/webhooks/razorpay`);
console.log(`  order   ${orderId}`);
console.log(`  payment ${paymentId}`);
console.log(`  event   ${eventId}\n`);

const body = buildBody();

let allOk = false;
try {
  allOk = await deliver(body, eventId, 'delivery');

  if (has('replay')) {
    // Razorpay retries until it gets a 2xx, so the same event id arriving twice
    // is routine rather than exceptional. Both must answer 200, and the second
    // must not append a second ledger entry — check the gateway log for
    // "ignoring redelivery".
    const second = await deliver(body, eventId, 'redelivery (same event id)');
    allOk = allOk && second;
    console.log('\n  Redelivery should be a no-op. Confirm with:');
    console.log(
      `    psql $DATABASE_URL -c "SELECT event_type, count(*) FROM payment_events WHERE order_id = '${orderId}' GROUP BY event_type"`,
    );
  }
} catch (err) {
  console.error(`\n✗ Could not reach the gateway at ${baseUrl}: ${err.message}`);
  console.error('  Is it running? `npm run dev:gateway` or `npm run infra:up`.');
  process.exit(1);
}

if (!allOk) {
  console.error('\n✗ The gateway rejected the delivery.');
  console.error('  A 401 means RAZORPAY_WEBHOOK_SECRET here differs from the one the gateway loaded.');
  console.error('  Restart the gateway after changing .env — it reads config once, at boot.');
  process.exit(1);
}

console.log('\n✓ Delivered. Check the escrow row:');
console.log(
  `    psql $DATABASE_URL -c "SELECT order_id, payment_id, status, authorized_at FROM escrow WHERE order_id = '${orderId}'"`,
);
