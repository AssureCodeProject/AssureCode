/**
 * @assurecode/api-gateway — shared singletons and route guards.
 *
 * The composition root (server.ts) and every route module import from here
 * rather than constructing their own copies. Most of this file is pure
 * relocation from server.ts's old top-of-file setup; the route guards below
 * additionally now enforce per-contract ownership (requireContractParty), not
 * just role — see the security-review fix that added it.
 *
 * initTracing() is called first, before this file's own `pg`/event-bus
 * imports are evaluated — matching the exact relative order server.ts used
 * to have between tracing init and `new pg.Pool()` / `new Redis()`
 * construction. Module evaluation happens once (ESM caching), so as long as
 * this file is the only place those get constructed, that order is
 * preserved regardless of which file imports context.ts first.
 */
import { initTracing, metrics } from '@assurecode/telemetry';
initTracing('api-gateway');

import { randomUUID } from 'node:crypto';
import net from 'node:net';
import pg from 'pg';
import {
  loadConfig,
  createLogger,
  getDatabaseUrl,
  buildDbConfig,
  getCorrelationId,
  assertProductionSecrets,
} from '@assurecode/config';
import { LedgerClient } from '@assurecode/ledger-client';
import { OracleStore } from '@assurecode/oracle';
import {
  createRazorpayAdapter,
  isLiveRazorpayConfig,
  type PaymentPort,
} from '@assurecode/razorpay-adapter';
import { createKycAdapter, type KycPort } from '@assurecode/kyc-adapter';
import { createEmailAdapter, type EmailPort } from '@assurecode/email-adapter';
import { createEventBus, OutboxRelay, eventBusOptionsFromConfig, provisionTopics, type EventBus } from '@assurecode/event-bus';
import { EVENT_TOPICS } from '@assurecode/shared';
import { requireRole, requireKycVerified, requireContractParty } from './middleware/rbac.js';

export { metrics };

// ── Configuration ─────────────────────────────────────────────────────

export const config = loadConfig();
export const logger = createLogger('api-gateway', config.LOG_LEVEL);

const databaseUrl = getDatabaseUrl(config);
export const dbPool = new pg.Pool(buildDbConfig(databaseUrl));
export const ledgerClient = new LedgerClient(databaseUrl);
// Read-only here. The settlement worker owns writing oracle state and acting on
// the verdict; the gateway shares the same `evaluate()` so what the UI shows and
// what releases the money cannot disagree.
export const oracleStore = new OracleStore(dbPool);
const razorpayConfig = {
  keyId: config.RAZORPAY_KEY_ID ?? '',
  keySecret: config.RAZORPAY_KEY_SECRET ?? '',
  webhookSecret: config.RAZORPAY_WEBHOOK_SECRET ?? '',
};
export const payments: PaymentPort = createRazorpayAdapter(razorpayConfig);

// Identity verification is its own seam. It used to hang off the payment
// adapter because Stripe happened to sell Identity and Connect alongside
// payments; Razorpay sells no equivalent, and KYC was never a payment concern.
export const kycAdapter: KycPort = createKycAdapter();

// Transactional email is its own seam too, for the same reason KYC is: no
// existing adapter has anything to do with sending mail. There is exactly
// one implementation (FakeEmailAdapter, see @assurecode/email-adapter) —
// no real provider is wired, matching this project's existing, documented
// posture on KYC (ARCHITECTURE.md's Status & Limitations).
export const emailAdapter: EmailPort = createEmailAdapter();

// BUG-013: fail fast in production when the payment provider is not really
// configured.
//
// This asks whether the adapter came out *live*, not whether the env var is
// non-empty. The Kubernetes Secret ships `RAZORPAY_KEY_SECRET: "REPLACE_ME"`,
// which is non-empty and passes a truthiness check — under the previous
// `!config.STRIPE_SECRET_KEY` form, an unconfigured production gateway started
// happily and then silently served the *fake* adapter, because the placeholder
// also failed the `sk_` prefix test inside the factory. A deployment that
// believes it is holding real money while every payment id is synthetic is a
// worse outcome than refusing to boot.
if (config.NODE_ENV === 'production' && !isLiveRazorpayConfig(razorpayConfig)) {
  logger.error(
    'RAZORPAY_KEY_ID (rzp_...) and RAZORPAY_KEY_SECRET are required in production. ' +
      'Refusing to start on the fake payment adapter.',
  );
  process.exit(1);
}

// A dev-default JWT secret or service token in production means every login
// token and every "machine caller" bypass is forgeable by anyone who has
// read this source file. The rule now lives in @assurecode/config so the
// other services get the same guard instead of only this one — it also
// catches the REPLACE_ME placeholders shipped in infra/k8s/.
//
// GitHub OAuth's two secrets are required only when GITHUB_CLIENT_ID is set:
// the feature is opt-in (a deployment can run password-only login forever),
// so unconditionally requiring them would refuse to boot every production
// deployment that simply never enabled GitHub login at all.
const requiredProductionSecrets = ['JWT_SECRET', 'SERVICE_TOKEN', 'MFA_SECRET_ENCRYPTION_KEY'];
if (config.GITHUB_CLIENT_ID) {
  requiredProductionSecrets.push('GITHUB_CLIENT_SECRET', 'GITHUB_TOKEN_ENCRYPTION_KEY');
}
assertProductionSecrets(config as unknown as Record<string, string | undefined>, requiredProductionSecrets, {
  onError: (message) => logger.error(message),
});

// BUG-009: Pre-parsed Redis URL used by the /readyz health check.
const redisHealthUrl = (() => {
  try { return config.REDIS_URL ? new URL(config.REDIS_URL) : null; } catch { return null; }
})();

/** TCP-level Redis liveness check — does not issue Redis commands, no side-effects. */
export async function pingRedis(): Promise<'ok' | 'error' | 'not_configured'> {
  if (!redisHealthUrl) return 'not_configured';
  return new Promise<'ok' | 'error'>((resolve) => {
    // `require` is not defined in an ES module, so this threw ReferenceError on
    // every call and /readyz answered 500 unconditionally — for a probe whose
    // entire job is to report whether the service is ready. An orchestrator
    // would never have routed traffic here. Static import instead; `net` is a
    // builtin, so there is nothing to defer.
    const socket = net.createConnection(
      { host: redisHealthUrl!.hostname, port: Number(redisHealthUrl!.port || 6379), timeout: 2000 },
      () => { socket.destroy(); resolve('ok'); },
    );
    socket.on('error', () => { socket.destroy(); resolve('error'); });
    socket.on('timeout', () => { socket.destroy(); resolve('error'); });
  });
}

// EVENT_BUS_TYPE selects the backend: 'redis' (default), 'kafka', or 'memory'.
// The old `createEventBus(config.REDIS_URL)` call passed a bare string, which
// the factory only ever resolves to RedisStreamsBus/InMemoryBus — Kafka was
// unreachable from here regardless of what any env var said.
export const eventBus: EventBus = createEventBus(eventBusOptionsFromConfig(config));

// Kafka only: create every topic (and its .dlq partner) up front. The gateway
// is the system's first publisher, and under Kafka a publish to a topic nobody
// created yet either fails or silently makes a 1-partition topic that caps the
// consumer group at one worker. Awaited nowhere — a broker that is slow to
// answer must not hold up the listener — but started before the outbox relay,
// which is what begins publishing.
void provisionTopics(eventBus, Object.values(EVENT_TOPICS)).catch((err) => {
  logger.error({ err }, 'event topic provisioning failed; publishes may hit missing topics');
});

// Outbox Relay background daemon for zero-loss transactional outbox pumping
export const outboxRelay = new OutboxRelay({ databaseUrl, eventBus });
outboxRelay.start();

// ── Downstream Service Clients ─────────────────────────────────────────

// Both come from @assurecode/config, which defaults them to localhost for
// host-based development and lets compose/k8s override them with service names.
//
// This used to be three variables built two different ways: `aiServiceUrl` was
// `http://localhost:${AI_SERVICE_PORT}` while `scorerUrl` read AI_SERVICE_URL,
// so /match, /generate-tests and /rag/ingest addressed the gateway's own
// loopback in any deployment where ai-service is a separate host — which is
// every deployment except a developer's laptop. The two names also let the same
// service be configured to two different addresses, so a correct AI_SERVICE_URL
// fixed the XAI scorer and left the other three broken. One name, one source.
export const aiServiceUrl = config.AI_SERVICE_URL;
export const scopeGuardUrl = config.SCOPE_GUARD_URL;

/**
 * Headers for every outbound call to ai-service and scope-guard.
 *
 * Both Python services now require `x-service-token` on everything except their
 * probe endpoints (see apps/ai-service/app/ports/service_auth.py). They used to
 * accept unauthenticated calls from anything that could reach them, which under
 * docker-compose was anything on the network.
 *
 * Built per call rather than hoisted to a constant so the correlation id is the
 * current request's, not the first one the process handled.
 */
export function serviceCallHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-correlation-id': getCorrelationId() || randomUUID(),
    'x-service-token': config.SERVICE_TOKEN,
    ...extra,
  };
}

/** Fire-and-forget call to ai-service — logs errors but doesn't block. */
export async function callAiService(path: string, body: unknown): Promise<void> {
  const cid = getCorrelationId() || randomUUID();
  try {
    const res = await fetch(`${aiServiceUrl}${path}`, {
      method: 'POST',
      headers: serviceCallHeaders({ 'x-correlation-id': cid }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000), // 10s timeout
    });
    if (!res.ok) {
      logger.warn({ path, status: res.status }, 'ai-service returned non-OK');
    }
  } catch (err) {
    logger.warn({ path, err }, 'ai-service call failed (non-blocking)');
  }
}

/**
 * The most recent audit_results payload for a contract, or null if the CI
 * pipeline has never recorded one. Throws if the lookup itself fails — "we
 * could not ask" is not the same answer as "there is nothing", and the two
 * routes that read this map them to different status codes.
 */
export async function latestAuditPayload(contractId: string): Promise<Record<string, unknown> | null> {
  const res = await dbPool.query(
    `SELECT payload FROM audit_results
      WHERE contract_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [contractId],
  );
  if (res.rowCount === 0) return null;
  return res.rows[0].payload as Record<string, unknown>;
}

/**
 * Record a money-movement event in the audit log.
 *
 * This table has never contained a row. The insert it replaces named a
 * `correlation_id` column the table did not have and omitted `payment_intent_id`,
 * which was NOT NULL with no default, so every call raised 42703 straight into
 * a catch block that logged and continued. V014 adds the missing columns and
 * relaxes the constraint; this helper is the single writer.
 *
 * Failures are still swallowed — an audit write must not fail a payment that
 * already happened — but they are logged loudly enough to notice.
 *
 * Returns whether a row was actually inserted, which doubles as the webhook
 * dedupe gate. The unique index on `provider_event_id` means a redelivery
 * conflicts and inserts nothing, so `false` says "this exact provider event has
 * been seen before" atomically, with no read-then-write race. A `false` for an
 * event with no provider id (our own routes, or a failed insert) is treated as
 * "do not skip" by the only caller that checks.
 *
 * Shared by contracts-escrow.ts (checkout callback) and webhooks.ts (Razorpay
 * webhook), which is why this lives here rather than with either route file.
 */
export async function recordPaymentEvent(params: {
  contractId: string;
  eventType: string;
  amountMinor: number;
  orderId?: string | null;
  paymentId?: string | null;
  providerEventId?: string | null;
  payload: Record<string, unknown>;
}): Promise<{ inserted: boolean }> {
  try {
    const res = await dbPool.query(
      `INSERT INTO payment_events
         (order_id, payment_id, contract_id, event_type, amount_cents, payload,
          correlation_id, provider_event_id, provider, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'razorpay', NOW())
       -- The WHERE clause is not optional. idx_payment_events_provider_event is
       -- a *partial* unique index, and Postgres will only infer a partial index
       -- as the conflict arbiter when the statement repeats its predicate.
       -- Without it every insert raised 42P10 (infer_arbiter_indexes) straight
       -- into the catch below — which is the precise failure mode this function
       -- was written to fix, so it is worth naming: a swallowed audit write
       -- leaves no trace except an empty table.
       ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING
       RETURNING event_id`,
      [
        params.orderId ?? null,
        params.paymentId ?? null,
        params.contractId,
        params.eventType,
        params.amountMinor,
        JSON.stringify(params.payload),
        getCorrelationId() || null,
        params.providerEventId ?? null,
      ],
    );
    return { inserted: res.rowCount === 1 };
  } catch (auditErr) {
    logger.error(
      { contractId: params.contractId, eventType: params.eventType, auditErr },
      'Failed to record payment event',
    );
    return { inserted: false };
  }
}

// ── Route guards ──────────────────────────────────────────────────────
//
// requireRole and requireKycVerified were written, exported, and never
// attached to anything — dead code since the day they landed. The gap was not
// theoretical: every contract route was reachable by any authenticated user
// regardless of role, so a freelancer could lock a contract, fund its escrow,
// and request its settlement.
//
// A second gap of the same shape was found later, once role checks existed:
// `requireRole(['client'])` answers "is this caller a client account", not
// "is this caller *this contract's* client" — so any client could assign a
// freelancer to, fund the escrow of, generate tests for, or lock a contract
// that belonged to a different client entirely, just by knowing its id.
// requireContractParty closes that: every guard below that names a specific
// contract now also checks the caller is actually a party to it (or admin).
//
// Roles: only a client owns the contract lifecycle. Settlement additionally
// admits 'admin' for dispute resolution.
export const clientOnly = {
  preHandler: [requireRole(['client']), requireContractParty(dbPool, ['client'])],
};
// Money movement additionally requires a verified identity. Guards run in
// order, so the role failure is reported before the compliance one, which is
// reported before the ownership one.
export const clientVerified = {
  preHandler: [requireRole(['client']), requireKycVerified(dbPool), requireContractParty(dbPool, ['client'])],
};
export const settlementGuards = {
  preHandler: [
    requireRole(['client', 'admin']),
    requireKycVerified(dbPool),
    // Admin passes requireContractParty unconditionally (see its own
    // implementation) — this only ever blocks a client settling a contract
    // that isn't theirs.
    requireContractParty(dbPool, ['client']),
  ],
};
export const freelancerOnly = { preHandler: requireRole(['freelancer']) };
// Read access shared by both sides of a contract — its client and its
// assigned freelancer (or admin) — with no role restriction beyond that,
// since either party legitimately needs to read the same ledger/score/oracle
// state and neither is more "authorized" than the other to do so.
export const contractPartyOnly = {
  preHandler: requireContractParty(dbPool),
};
// Only the freelancer this specific contract is assigned to — used by the
// assignment accept/reject routes, which no existing bundle covers:
// freelancerOnly is role-only (any freelancer account), and
// requireContractParty(dbPool, ['freelancer']) alone would still let a client
// account through nothing (no requireRole), but combining the two is what
// actually names "this contract's assigned freelancer, and nobody else".
export const freelancerContractParty = {
  preHandler: [requireRole(['freelancer']), requireContractParty(dbPool, ['freelancer'])],
};
