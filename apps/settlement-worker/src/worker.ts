/**
 * Settlement oracle.
 *
 * Objective 4: the trust score triggers a Node.js oracle that releases escrow.
 * The gate is `trustScore >= 85 && criticalVulns === 0`, evaluated alongside the
 * four CI signals, against state held in Postgres rather than in this process.
 *
 * Release is a *capture*, not a transfer. The gateway creates the Razorpay
 * order with `payment_capture: 0`, so the customer's payment settles at status
 * `authorized` — the funds are held on their card but have not moved. Capturing
 * that payment is what actually takes the money, and this worker is the only
 * thing that calls it. An earlier implementation skipped the capture and
 * transferred to a hardcoded destination account, so the escrow was never
 * really released and every settlement paid the same placeholder.
 *
 * The worker captures a *payment*, never an order. Razorpay's order is created
 * before anyone has paid it; only the payment that fulfils it can be captured,
 * which is why OracleStore.findEscrowPayment() matches on status 'AUTHORIZED'
 * and refuses rows whose payment_id is still NULL.
 */
import { createEventBus, eventBusOptionsFromConfig } from '@assurecode/event-bus';
import { loadConfig, createLogger, getDatabaseUrl, buildDbConfig, startMetricsServer } from '@assurecode/config';
import type { Server } from 'node:http';
import { LedgerClient } from '@assurecode/ledger-client';
import { createRazorpayAdapter, createPayoutAdapter } from '@assurecode/razorpay-adapter';
import { EVENT_TOPICS, EventEnvelope, SettlementRequested } from '@assurecode/shared';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { OracleStore } from '@assurecode/oracle';
import {
  triggerScoring,
  requestRootSignature,
  logTriggerOutcome,
  type TriggerDeps,
} from './gateway-client.js';

const config = loadConfig();
const logger = createLogger('settlement-worker', config.LOG_LEVEL);
const databaseUrl = getDatabaseUrl(config);

const dbPool = new pg.Pool(buildDbConfig(databaseUrl));
const ledgerClient = new LedgerClient(databaseUrl);
const razorpayConfig = {
  keyId: config.RAZORPAY_KEY_ID ?? '',
  keySecret: config.RAZORPAY_KEY_SECRET ?? '',
  webhookSecret: config.RAZORPAY_WEBHOOK_SECRET ?? '',
  accountNumber: config.RAZORPAYX_ACCOUNT_NUMBER ?? '',
};
const payments = createRazorpayAdapter(razorpayConfig);
const payouts = createPayoutAdapter(razorpayConfig);

const eventBus = createEventBus(eventBusOptionsFromConfig(config));
const oracle = new OracleStore(dbPool);

const scoreTriggerDeps: TriggerDeps = {
  gatewayUrl: config.GATEWAY_URL,
  serviceToken: config.SERVICE_TOKEN,
  enabled: config.ENABLE_AUTO_SCORING === 'true',
};

/** Mark the contract's settlement row failed. Callers decide whether to swallow. */
function markSettlementFailed(contractId: string): Promise<unknown> {
  return dbPool.query(
    `UPDATE settlements SET status = 'FAILED', updated_at = NOW() WHERE contract_id = $1`,
    [contractId],
  );
}

function publishSettlementRejected(
  contractId: string,
  reason: string,
  correlationId: string,
): Promise<unknown> {
  return eventBus.publish(EVENT_TOPICS.SETTLEMENT_REJECTED, { contractId, reason }, correlationId);
}

// ── 1. CI signals ────────────────────────────────────────────────────
function subscribeAuditSignals(): void {
  void eventBus.subscribe(EVENT_TOPICS.AUDIT_COMPLETED, async (event: EventEnvelope) => {
    const payload = event.payload as any;
    const contractId = payload.contractId || payload.auditResults?.contractId;
    if (!contractId) return;

    // ci-worker publishes audit fields flat on the payload; older producers
    // nested them under auditResults. Accept both.
    const auditData: any = payload.auditResults ?? payload;
    const maintainability = Number(auditData.maintainability ?? -1);
    const passedTests = Number(auditData.passedTests ?? 0);
    const totalTests = Number(auditData.totalTests ?? 0);
    const vulnerabilities = Number(auditData.vulnerabilities ?? 1);
    // Absent on payloads from producers predating the field. Treated as
    // complete for those, since assuming otherwise would retroactively block
    // contracts audited before the flag existed; new producers always set it.
    const securityScanComplete = auditData.securityScanComplete !== false;

    const signals = {
      astPassed: maintainability >= 10,
      testsPassed: passedTests === totalTests && totalTests > 0,
      // A scan that could not run Layer 2 found no LLM-detectable issues
      // because it never looked. "Zero findings" from half a scan is not the
      // same claim as zero findings, and must not release money.
      securityPassed: vulnerabilities === 0 && securityScanComplete,
    };

    try {
      await oracle.recordAudit(contractId, signals);
      logger.info({ contractId, signals }, 'Oracle recorded AUDIT_COMPLETED signals');
    } catch (err: any) {
      logger.error({ contractId, err: err.message }, 'Failed to persist audit signals');
      // Do not go on to trigger scoring off state we failed to record. Scoring
      // a contract whose CI signals are missing produces a trust score the
      // oracle will then evaluate against three false booleans, which reads as
      // "scored and blocked" rather than "not recorded".
      return;
    }

    // Ask the gateway to score the contract, which makes it publish XAI_SCORED,
    // which subscribeTrustScore (below) turns into the other half of the gate.
    //
    // This does not loop. The only producer of AUDIT_COMPLETED is
    // apps/ci-worker/src/worker.ts, and the only producer of XAI_SCORED is the
    // gateway's /score route; neither publishes the topic that reaches it, so
    // the chain is two hops and terminates at oracle.recordScore. Keep it that
    // way -- a /score that republished AUDIT_COMPLETED would loop unbounded
    // with a real HTTP call and an LLM narrative per iteration.
    await attemptScoring(contractId);
  });
}

/**
 * Ask the gateway to score `contractId`, recording the attempt regardless of
 * outcome so reconcileMissingScores' cap (see its header) counts this first,
 * synchronous try the same way it counts its own retries.
 *
 * Deliberately not folded into subscribeAuditSignals' handler: this is the
 * one call site reconcileMissingScores also needs, and duplicating the
 * increment-then-call sequence there would let the two drift.
 */
async function attemptScoring(contractId: string): Promise<void> {
  if (!scoreTriggerDeps.enabled) return;

  await dbPool
    .query(`UPDATE oracle_state SET score_attempts = score_attempts + 1 WHERE contract_id = $1`, [
      contractId,
    ])
    .catch((err: any) =>
      logger.error({ contractId, err: err.message }, 'Failed to record score attempt'),
    );

  const outcome = await triggerScoring(contractId, scoreTriggerDeps);
  logTriggerOutcome(logger, contractId, outcome);

  // 'declined' is triggerScoring's own TERMINAL_STATUSES set -- its outcome
  // log already says "will not change on retry". Jump straight to the cap
  // instead of waiting out SCORE_MAX_ATTEMPTS sweeps to reach a conclusion
  // this one response already reached.
  if (outcome.kind === 'declined') {
    await dbPool
      .query(`UPDATE oracle_state SET score_attempts = $1 WHERE contract_id = $2`, [
        SCORE_MAX_ATTEMPTS,
        contractId,
      ])
      .catch((err: any) =>
        logger.error({ contractId, err: err.message }, 'Failed to stop retrying a declined score'),
      );
  }
}

// ── 2. Trust score ───────────────────────────────────────────────────
//
// Without this subscription the score was computed, published, and ignored:
// nothing in the settlement path ever read it, so the ">= 85" gate the
// objective specifies did not exist anywhere in the running system.
function subscribeTrustScore(): void {
  void eventBus.subscribe(EVENT_TOPICS.XAI_SCORED, async (event: EventEnvelope) => {
    const payload = event.payload as any;
    const contractId = payload.contractId;
    if (!contractId) return;

    const trustScore = Number(payload.trustScore);
    const criticalVulns = Number(payload.criticalVulns);
    if (!Number.isFinite(trustScore) || !Number.isFinite(criticalVulns)) {
      logger.error({ contractId, payload }, 'XAI_SCORED missing trustScore or criticalVulns');
      return;
    }

    try {
      // scoredAt is the gateway's stamp from when it read the telemetry. Passed
      // through so recordScore can refuse a score that arrives after a newer
      // one -- see the monotonicity note there.
      await oracle.recordScore(contractId, trustScore, criticalVulns, payload.scoredAt ?? null);
      logger.info({ contractId, trustScore, criticalVulns }, 'Oracle recorded XAI_SCORED');
    } catch (err: any) {
      logger.error({ contractId, err: err.message }, 'Failed to persist trust score');
    }
  });
}

// ── 3. Scope decisions ───────────────────────────────────────────────
//
// The scope signal is derived from scope_checks at evaluation time, so this
// subscription exists only to log. Recomputing on read is what stops a single
// early in-scope message from latching the signal open.
function subscribeScopeDecisions(): void {
  void eventBus.subscribe(EVENT_TOPICS.SCOPE_CHECKED, async (event: EventEnvelope) => {
    const payload = event.payload as any;
    if (!payload?.contractId) return;
    logger.info(
      { contractId: payload.contractId, allowed: payload.allowed },
      'Scope decision observed (signal is derived from scope_checks on evaluation)',
    );
  });
}

// ── 3b. Escrow funding ───────────────────────────────────────────────
//
// The gateway publishes ESCROW_LOCKED whenever a payment's state changes —
// from the Razorpay webhook, and from the /escrow/verify route that confirms a
// Checkout callback. Nothing subscribed to this originally, so a payment that
// succeeded or failed at the provider left the local escrow row at 'PENDING'
// forever. That is a settlement problem in both directions: a *failed* payment
// stayed eligible for capture, and an *authorised* one was never marked as the
// funded escrow the oracle looks for.
//
// The gateway writes these transitions too, and does so first. This subscriber
// is the safety net for the case where the gateway's own write failed after it
// had already published — hence the status guards on both updates, which make
// a redundant apply a no-op rather than a regression.
function subscribeEscrowEvents(): void {
  void eventBus.subscribe(EVENT_TOPICS.ESCROW_LOCKED, async (event: EventEnvelope) => {
    const payload = event.payload as {
      contractId?: string;
      orderId?: string;
      paymentId?: string;
      type?: string;
    };
    if (!payload?.paymentId) return;

    // 'payment.failed' is the only event that takes an escrow out of play;
    // 'payment.authorized' is the one that puts it in. Anything else — a
    // capture notification for money this worker itself just took, say — is
    // observational.
    if (payload.type === 'payment.failed') {
      try {
        await dbPool.query(
          `UPDATE escrow SET status = 'FAILED'
            WHERE payment_id = $1 AND status IN ('PENDING', 'AUTHORIZED')`,
          [payload.paymentId],
        );
        logger.warn(
          { contractId: payload.contractId, paymentId: payload.paymentId },
          'Escrow payment failed; marked FAILED so it cannot be captured',
        );
      } catch (err: any) {
        logger.error(
          { contractId: payload.contractId, err: err.message },
          'Failed to mark escrow row FAILED',
        );
      }
      return;
    }

    if (payload.type === 'payment.authorized' || payload.type === 'order.paid') {
      try {
        // Guarded on 'PENDING' so this cannot drag a RELEASED or FAILED escrow
        // back into a capturable state if the event is redelivered late.
        await dbPool.query(
          `UPDATE escrow
              SET status = 'AUTHORIZED', payment_id = $1, authorized_at = COALESCE(authorized_at, NOW())
            WHERE order_id = $2 AND status = 'PENDING'`,
          [payload.paymentId, payload.orderId ?? null],
        );
        logger.info(
          { contractId: payload.contractId, paymentId: payload.paymentId },
          'Escrow funds authorized and held pending oracle verdict',
        );
      } catch (err: any) {
        logger.error(
          { contractId: payload.contractId, err: err.message },
          'Failed to mark escrow row AUTHORIZED',
        );
      }
      return;
    }

    logger.info(
      { contractId: payload.contractId, type: payload.type },
      'Escrow event observed; no state change',
    );
  });
}

// ── 4. Settlement ────────────────────────────────────────────────────

/**
 * Claim the right to settle this contract.
 *
 * The first claim wins and concurrent ones no-op, so a duplicated
 * SETTLEMENT_REQUESTED event cannot capture the same PaymentIntent twice.
 * Returns false when this process is not the claimant — including when the
 * guard query itself failed, since an unconfirmed claim is not a claim.
 *
 * A previously FAILED attempt is re-claimable. `ON CONFLICT DO NOTHING` alone
 * was not: markSettlementFailed() leaves the row behind at status 'FAILED',
 * `contract_id` is the primary key (V004), so after any transient failure — a
 * Razorpay timeout, a momentary database blip — the insert could never win again
 * and the contract was permanently unsettleable with money still held in
 * escrow. The WHERE clause is what keeps this from also re-claiming a
 * PROCESSING or COMPLETED row: those are still the exactly-once cases.
 */
async function claimSettlement(contractId: string): Promise<boolean> {
  let guardRes;
  try {
    guardRes = await dbPool.query(
      `INSERT INTO settlements (contract_id, status)
       VALUES ($1, 'PROCESSING')
       ON CONFLICT (contract_id) DO UPDATE
         SET status = 'PROCESSING', updated_at = NOW()
         WHERE settlements.status = 'FAILED'
       RETURNING contract_id`,
      [contractId],
    );
  } catch (dbErr: any) {
    logger.error({ contractId, err: dbErr.message }, 'Settlement guard query failed');
    return false;
  }

  if (guardRes.rowCount !== 1) {
    logger.warn({ contractId }, 'Settlement already in progress or complete; ignoring');
    return false;
  }
  return true;
}

/**
 * Record the release atomically: ledger entry, escrow row, settlement row, and
 * the freelancer's trust score all commit together or not at all.
 *
 * On failure the settlement row is marked FAILED and the error is rethrown —
 * the caller owns publishing the rejection.
 */
async function commitSettlement(args: {
  contractId: string;
  freelancerId: string;
  paymentId: string;
  trustScore: number | null;
  settlementPayload: Record<string, unknown>;
}): Promise<void> {
  const { contractId, freelancerId, paymentId, trustScore, settlementPayload } = args;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    // SETTLEMENT_COMPLETED as the ledger action type, so the chain records
    // what happened rather than a generic INVOICE.
    await ledgerClient.append(contractId, 'SETTLEMENT_COMPLETED', settlementPayload, client);
    await client.query(
      `UPDATE escrow SET status = 'RELEASED' WHERE payment_id = $1`,
      [paymentId],
    );
    await client.query(
      `UPDATE settlements
          SET status = 'COMPLETED', transfer_id = $1, updated_at = NOW()
        WHERE contract_id = $2`,
      [paymentId, contractId],
    );

    // Write the measured trust score back onto the freelancer's profile,
    // in the same transaction as the settlement it came from. Before this,
    // freelancer_profiles.trust_score was whatever tools/seed-users.py
    // last wrote — invented numbers feeding 35% of the matchmaker's
    // ranking, never touched by the system's own audit pipeline.
    // oracle.trustScore is 0-100 (TRUST_SCORE_THRESHOLD = 85); the profile
    // column is 0-1, matching every other trust_score in that table.
    // Non-null here: `verdict.approved` (checked by the caller) requires a
    // scored trust value — OracleStore.evaluate() blocks approval otherwise.
    if (freelancerId && trustScore !== null) {
      await client.query(
        `UPDATE freelancer_profiles
            SET trust_score = $1,
                deliveries = deliveries + 1
          WHERE freelancer_id = $2`,
        [trustScore / 100, freelancerId],
      );
    }

    await client.query('COMMIT');
  } catch (txErr) {
    await client.query('ROLLBACK');
    await markSettlementFailed(contractId);
    throw txErr;
  } finally {
    client.release();
  }
}

/**
 * Seal the chain's Merkle root now that the contract's history is final.
 *
 * Before this, computeAndStoreRoot() was only ever called by
 * tools/verify_phase8_live.mjs directly against the library — no live request
 * path called it, so merkle_roots stayed empty regardless of how many
 * contracts actually settled. A failure here doesn't unwind the settlement
 * that already committed: the money moved for real, and this is a summary over
 * an already-committed chain, not a condition of moving it.
 */
async function sealAndSignMerkleRoot(contractId: string): Promise<void> {
  try {
    const { root, leafCount } = await ledgerClient.computeAndStoreRoot(contractId);
    logger.info({ contractId, root, leafCount }, 'Merkle root computed and stored');
  } catch (rootErr: any) {
    logger.error({ contractId, err: rootErr.message }, 'Failed to compute/store Merkle root after settlement');
    // No root, nothing to sign. Returning here rather than falling through
    // keeps the log from carrying a signing failure whose real cause was that
    // the root never existed.
    return;
  }

  // Signing is a separate call because the signer is Python and every service
  // that seals is TypeScript — see gateway-client.ts. Until this ran, the
  // signature columns on merkle_roots were populated only by a manual CLI, so
  // every root produced in normal operation was unsigned while the UI claimed
  // otherwise.
  const outcome = await requestRootSignature(contractId, scoreTriggerDeps);
  if (outcome.kind === 'signed') {
    logger.info(
      { contractId, algorithm: outcome.algorithm, alreadySigned: outcome.alreadySigned },
      'Merkle root signed',
    );
    return;
  }

  // Loud, but not fatal, and deliberately not rethrown: the settlement has
  // committed and the money has moved. An unsigned root is a weaker claim about
  // an already-true fact, and GET /api/contracts/:id/root reports it as
  // unsigned rather than letting the UI assert a signature that isn't there.
  // Re-drive with POST /api/contracts/:id/root/sign; it is idempotent.
  logger.error(
    { contractId, status: outcome.status, detail: outcome.detail },
    'Merkle root is sealed but UNSIGNED. The post-quantum signature was not written; ' +
      're-drive POST /api/contracts/:id/root/sign once the signer is available.',
  );
}

/**
 * Pay the freelancer, now that the escrow release itself has already
 * committed. Deliberately not part of commitSettlement's transaction: an
 * external payout call sitting inside a DB transaction would hold a
 * Postgres connection open for however long RazorpayX takes to answer,
 * turning network latency into lock contention. A payout failure here must
 * never unwind the settlement that already happened — the money left
 * escrow for real, and callers wrap this in its own try/catch for exactly
 * that reason.
 *
 * Each write is its own statement rather than a transaction, on purpose:
 * the 'PROCESSING' write lands *before* the network call so that a crash
 * mid-call is visible afterwards as "attempted, needs confirming" rather
 * than silently reverting to PENDING and being retried as if nothing had
 * happened. See reconcilePendingPayouts for what "confirming" means.
 */
async function attemptPayout(contractId: string, freelancerId: string): Promise<void> {
  if (!freelancerId) return;

  const acctRes = await dbPool.query(
    `SELECT payout_account_id FROM users WHERE user_id = $1`,
    [freelancerId],
  );
  const accountId: string | null = acctRes.rows[0]?.payout_account_id ?? null;
  if (!accountId) {
    logger.warn(
      { contractId, freelancerId },
      'No payout account on file for freelancer; leaving payout PENDING for reconciler',
    );
    return;
  }

  // The capture's paymentId, written by commitSettlement into
  // settlements.transfer_id — used only to look up the escrow row's amount,
  // which is the same "escrow table is authoritative" rule the capture
  // itself already follows rather than trusting an event payload.
  const settleRes = await dbPool.query(
    `SELECT transfer_id FROM settlements WHERE contract_id = $1`,
    [contractId],
  );
  const paymentId: string | undefined = settleRes.rows[0]?.transfer_id;
  const escrowRes = paymentId
    ? await dbPool.query(
        `SELECT amount_cents, currency FROM escrow WHERE payment_id = $1`,
        [paymentId],
      )
    : { rows: [] as any[] };
  const amountMinor: number | undefined = escrowRes.rows[0]?.amount_cents;
  const currency: string | undefined = escrowRes.rows[0]?.currency;
  if (!amountMinor || !currency) {
    logger.error({ contractId, paymentId }, 'Cannot attempt payout: no escrow amount found');
    return;
  }

  await dbPool.query(
    `UPDATE settlements
        SET payout_status = 'PROCESSING', payout_attempts = payout_attempts + 1, payout_updated_at = NOW()
      WHERE contract_id = $1`,
    [contractId],
  );

  // Deterministic per contract, not per call: a retry from
  // reconcilePendingPayouts must reuse this exact key so RazorpayX's own
  // idempotency handling — not anything this process remembers — is what
  // stops a lost-response crash from becoming a second real transfer.
  const idempotencyKey = `payout_${contractId}`;

  let result;
  try {
    result = await payouts.initiatePayout({ contractId, accountId, amountMinor, currency, idempotencyKey });
  } catch (err: any) {
    await dbPool.query(
      `UPDATE settlements
          SET payout_status = 'FAILED', payout_failure_reason = $1, payout_updated_at = NOW()
        WHERE contract_id = $2`,
      [err.message, contractId],
    );
    logger.error({ contractId, err: err.message }, 'Payout initiation failed');
    return;
  }

  const finalStatus =
    result.status === 'processed' ? 'COMPLETED' : result.status === 'failed' ? 'FAILED' : 'PROCESSING';
  await dbPool.query(
    `UPDATE settlements
        SET payout_status = $1, payout_id = $2, payout_failure_reason = $3, payout_updated_at = NOW()
      WHERE contract_id = $4`,
    [finalStatus, result.payoutId, result.failureReason ?? null, contractId],
  );
  logger.info({ contractId, payoutId: result.payoutId, status: finalStatus }, 'Payout attempted');
}

/**
 * Sweep for settlements whose payout never completed — either a freelancer
 * without a payout account yet (payout_status stays the column default
 * 'PENDING' until they finish onboarding), a payout that failed outright, or
 * one abandoned mid-call by a crash (still 'PROCESSING', no confirmed
 * result). All three retry through the same attemptPayout, keyed on the
 * same idempotencyKey, so a retry of an already-sent payout resolves to
 * RazorpayX's original record rather than sending money twice.
 *
 * Runs at startup (once, alongside reconcileAbandonedSettlements) and then
 * on an interval — unlike the capture leg, a payout can legitimately need
 * retrying long after the settlement itself completed, e.g. a freelancer
 * finishing payout onboarding days later. There is no existing periodic-job
 * primitive anywhere in this codebase to reuse, so this is a plain
 * setInterval — the smallest addition consistent with everything else here
 * being hand-rolled.
 */
async function reconcilePendingPayouts(): Promise<void> {
  const { rows } = await dbPool.query(
    `SELECT s.contract_id, c.freelancer_id, s.payout_attempts
       FROM settlements s
       JOIN contracts c ON c.contract_id = s.contract_id
       JOIN users u ON u.user_id = c.freelancer_id
      WHERE s.status = 'COMPLETED'
        AND s.payout_status IN ('PENDING', 'FAILED', 'PROCESSING')
        AND u.payout_account_id IS NOT NULL`,
  );
  if (rows.length === 0) return;

  logger.info({ count: rows.length }, 'Reconciling pending/failed payouts');
  for (const row of rows) {
    // A row with no payout account never reaches the PROCESSING write in
    // attemptPayout (see the early return there), so payout_attempts stays 0
    // for as long as the freelancer hasn't finished onboarding — that case is
    // meant to wait indefinitely, not exhaust the cap. Only rows that actually
    // reached a real payout attempt accumulate attempts, so the cap only ever
    // fires on genuine repeated failure.
    if (row.payout_attempts >= PAYOUT_MAX_ATTEMPTS) {
      await dbPool
        .query(
          `UPDATE settlements
              SET payout_status = 'FAILED_TERMINAL', payout_updated_at = NOW()
            WHERE contract_id = $1 AND payout_status != 'FAILED_TERMINAL'`,
          [row.contract_id],
        )
        .catch((err: any) =>
          logger.error(
            { contractId: row.contract_id, err: err.message },
            'Failed to mark payout FAILED_TERMINAL',
          ),
        );
      logger.error(
        { contractId: row.contract_id, attempts: row.payout_attempts },
        `Payout exceeded ${PAYOUT_MAX_ATTEMPTS} attempts; stopped auto-retrying. Needs manual review.`,
      );
      continue;
    }
    await attemptPayout(row.contract_id, row.freelancer_id).catch((err: any) =>
      logger.error({ contractId: row.contract_id, err: err.message }, 'Payout reconciliation attempt failed'),
    );
  }
}

/**
 * Sweep for contracts whose audit completed but never acquired a trust score
 * — attemptScoring's one synchronous try (from subscribeAuditSignals) failed
 * or timed out, and nothing was retrying it. Before this, the only recovery
 * was a human opening the XAI tab in the browser (the only other caller of
 * GET /score) for that specific contract; a contract nobody looked at stayed
 * unsettleable forever with no error visible anywhere but a log line.
 *
 * This is exactly reconcilePendingPayouts' shape, one level earlier in the
 * pipeline: same "retry through the real function, capped, on an interval
 * plus at startup" design, because the failure mode is the same one — a
 * single synchronous attempt with no second chance.
 *
 * Runs more often than the payout reconciler: a missing trust score blocks
 * the *entire* settlement gate (nothing downstream can even be attempted),
 * where a missing payout account is a freelancer-specific wait that can
 * legitimately take days.
 */
async function reconcileMissingScores(): Promise<void> {
  if (!scoreTriggerDeps.enabled) return;

  const { rows } = await dbPool.query(
    `SELECT contract_id FROM oracle_state WHERE trust_score IS NULL AND score_attempts < $1`,
    [SCORE_MAX_ATTEMPTS],
  );
  if (rows.length === 0) return;

  logger.info({ count: rows.length }, 'Reconciling contracts missing an XAI trust score');
  for (const row of rows) {
    await attemptScoring(row.contract_id).catch((err: any) =>
      logger.error(
        { contractId: row.contract_id, err: err.message },
        'Score reconciliation attempt failed',
      ),
    );
  }
}

function subscribeSettlementRequests(): void {
  void eventBus.subscribe(EVENT_TOPICS.SETTLEMENT_REQUESTED, async (event: EventEnvelope) => {
    const payload = event.payload as SettlementRequested;
    const { contractId, freelancerId, amountCents } = payload;
    const correlationId = randomUUID();

    logger.info({ contractId }, 'Evaluating settlement oracle');

    let verdict;
    try {
      verdict = await oracle.evaluate(contractId);
    } catch (err: any) {
      // An unreadable oracle is not an approving one.
      logger.error({ contractId, err: err.message }, 'Oracle evaluation failed');
      await publishSettlementRejected(
        contractId,
        `Oracle state unavailable: ${err.message}`,
        correlationId,
      );
      return;
    }

    if (!verdict.approved) {
      logger.warn({ contractId, blockers: verdict.blockers }, 'Settlement REJECTED by oracle');
      await eventBus.publish(
        EVENT_TOPICS.SETTLEMENT_REJECTED,
        {
          contractId,
          reason: verdict.blockers.join('; '),
          signals: verdict.signals,
          blockers: verdict.blockers,
        },
        correlationId,
      );
      return;
    }

    if (!(await claimSettlement(contractId))) return;

    logger.info(
      { contractId, trustScore: verdict.signals.trustScore },
      'Settlement APPROVED. Releasing escrow.',
    );

    try {
      const held = await oracle.findEscrowPayment(contractId);
      if (!held) {
        throw new Error(
          `no AUTHORIZED escrow payment found for ${contractId}; nothing to release`,
        );
      }

      // Release the held funds. This is the action the whole oracle exists to
      // authorise.
      //
      // Capture the amount that was authorised, not the amount named in the
      // settlement request. Razorpay rejects a capture whose amount or currency
      // differs from the authorisation, and the escrow row is the record of
      // what the client actually committed — an event payload is not.
      const captured = await payments.capturePayment({
        paymentId: held.paymentId,
        amountMinor: held.amountMinor,
        currency: held.currency,
      });

      const settlementPayload = {
        contractId,
        freelancerId,
        amountCents: amountCents ?? held.amountMinor,
        paymentId: held.paymentId,
        currency: held.currency,
        captureStatus: captured.status,
        trustScore: verdict.signals.trustScore,
        criticalVulns: verdict.signals.criticalVulns,
        oracleSignals: verdict.signals,
        settledAt: new Date().toISOString(),
      };

      await commitSettlement({
        contractId,
        freelancerId,
        paymentId: held.paymentId,
        trustScore: verdict.signals.trustScore,
        settlementPayload,
      });

      await eventBus.publish(EVENT_TOPICS.SETTLEMENT_COMPLETED, settlementPayload, correlationId);
      logger.info(
        { contractId, paymentId: held.paymentId },
        'Settlement complete, escrow released',
      );

      await sealAndSignMerkleRoot(contractId);

      // Own try/catch, not the outer one: the settlement above already
      // committed for real, so a payout failure must never be reported as
      // "settlement execution failed" or trigger publishSettlementRejected
      // for a settlement that validly completed.
      await attemptPayout(contractId, freelancerId).catch((err: any) =>
        logger.error({ contractId, err: err.message }, 'Payout attempt failed'),
      );
    } catch (err: any) {
      logger.error({ contractId, err: err.message }, 'Settlement execution failed');
      await markSettlementFailed(contractId).catch(() => undefined);
      await publishSettlementRejected(
        contractId,
        `Escrow release failed: ${err.message}`,
        correlationId,
      );
    }
  });
}

/**
 * Recover a settlement abandoned at 'PROCESSING' by a worker that died
 * between capturePayment (line ~461) and commitSettlement (line ~480) — see
 * the header comment on claimSettlement for why claimSettlement itself can't
 * re-claim these. Nothing else moves a row out of 'PROCESSING', so finding
 * one here always means exactly that crash, not a settlement genuinely still
 * in flight in this same process.
 *
 * capturePayment is called again rather than trusting fetchPayment to report
 * the prior attempt's outcome: a fresh process (this one, right now, having
 * just restarted) has no memory of what the previous process's in-flight
 * capture actually did, and the real gateway can be slow to reflect a capture
 * that raced the crash. Both adapters make a repeat capture safe — the fake
 * one is a pure overwrite, and a live Razorpay capture on an already-captured
 * payment fails with a "such capture has already happened" error rather than
 * double-charging, which the catch below treats as success by re-checking
 * fetchPayment rather than as a real failure.
 */
async function recoverAbandonedSettlement(contractId: string): Promise<void> {
  logger.warn({ contractId }, 'Recovering settlement abandoned in PROCESSING by a prior crash');

  try {
    const verdict = await oracle.evaluate(contractId);
    if (!verdict.approved) {
      // State moved on since the crash (e.g. a later audit regressed a
      // signal) — completing the release anyway would settle money against a
      // verdict nobody currently holds. Leave it PROCESSING and say so loudly
      // rather than resolve it either direction on a stale approval.
      logger.error(
        { contractId, blockers: verdict.blockers },
        'Cannot auto-recover: oracle no longer approves this contract',
      );
      return;
    }

    const contractRes = await dbPool.query(
      `SELECT freelancer_id FROM contracts WHERE contract_id = $1`,
      [contractId],
    );
    const freelancerId = contractRes.rows[0]?.freelancer_id ?? '';

    const held = await oracle.findEscrowPayment(contractId);
    if (!held) {
      logger.error({ contractId }, 'Cannot auto-recover: no AUTHORIZED escrow payment found');
      return;
    }

    let captured;
    try {
      captured = await payments.capturePayment({
        paymentId: held.paymentId,
        amountMinor: held.amountMinor,
        currency: held.currency,
      });
    } catch (captureErr: any) {
      const existing = await payments.fetchPayment(held.paymentId);
      if (!existing.captured) throw captureErr;
      captured = existing;
    }

    const settlementPayload = {
      contractId,
      freelancerId,
      amountCents: held.amountMinor,
      paymentId: held.paymentId,
      currency: held.currency,
      captureStatus: captured.status,
      trustScore: verdict.signals.trustScore,
      criticalVulns: verdict.signals.criticalVulns,
      oracleSignals: verdict.signals,
      settledAt: new Date().toISOString(),
      recoveredFromCrash: true,
    };

    await commitSettlement({
      contractId,
      freelancerId,
      paymentId: held.paymentId,
      trustScore: verdict.signals.trustScore,
      settlementPayload,
    });

    await eventBus.publish(EVENT_TOPICS.SETTLEMENT_COMPLETED, settlementPayload, randomUUID());
    logger.info(
      { contractId, paymentId: held.paymentId },
      'Recovered abandoned settlement to COMPLETED',
    );

    await sealAndSignMerkleRoot(contractId);

    await attemptPayout(contractId, freelancerId).catch((err: any) =>
      logger.error({ contractId, err: err.message }, 'Payout attempt failed'),
    );
  } catch (err: any) {
    logger.error({ contractId, err: err.message }, 'Settlement recovery failed');
  }
}

/**
 * Sweep for rows abandoned at 'PROCESSING' and recover each one. Runs once at
 * startup: under any real deployment (Kubernetes restarting a crashed pod,
 * this same worker relaunched after `node`/`tsx` exits) that is exactly when
 * an abandoned row would otherwise sit unrecovered indefinitely — see
 * claimSettlement's header for why claiming can't do this itself.
 */
async function reconcileAbandonedSettlements(): Promise<void> {
  const { rows } = await dbPool.query(
    `SELECT contract_id FROM settlements WHERE status = 'PROCESSING'`,
  );
  if (rows.length === 0) return;

  logger.warn(
    { count: rows.length },
    'Found settlements abandoned in PROCESSING at startup; recovering',
  );
  for (const row of rows) {
    await recoverAbandonedSettlement(row.contract_id);
  }
}

/** 5 minutes — first periodic job in this codebase; see reconcilePendingPayouts's header for why. */
const PAYOUT_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
/**
 * After this many real attempts, reconcilePendingPayouts stops retrying
 * automatically and marks the row FAILED_TERMINAL instead — without a cap, a
 * payout failing for a permanent reason (a malformed beneficiary account, an
 * account-level block) retries identically every 5 minutes forever,
 * indistinguishable in the code from one that's failing transiently. 5
 * attempts at the 5-minute interval above is ~25 minutes of automatic retry
 * before a human needs to look at it.
 */
const PAYOUT_MAX_ATTEMPTS = 5;
/**
 * 2 minutes — shorter than the payout reconciler's 5, because a missing
 * trust score blocks the entire settlement gate rather than one freelancer's
 * payout. Attempt cap kept the same as payouts' (5) for the same reason
 * V019 gives one: distinguishing a transient failure from a permanent one
 * without waiting so long a stuck contract looks abandoned.
 */
const SCORE_RECONCILE_INTERVAL_MS = 2 * 60 * 1000;
const SCORE_MAX_ATTEMPTS = 5;
let payoutReconcileTimer: NodeJS.Timeout | undefined;
let scoreReconcileTimer: NodeJS.Timeout | undefined;
let metricsServer: Server | undefined;

async function start(): Promise<void> {
  logger.info('Starting settlement oracle...');

  // Same reasoning as ci-worker's metrics server: this is the process that
  // actually captures payments and drives payouts, and it had zero
  // Prometheus visibility — not down, just unmeasured. No other HTTP surface
  // exists here (k8s uses an `exec` probe), so this is deliberately minimal.
  metricsServer = startMetricsServer(config.SETTLEMENT_WORKER_PORT, logger);

  // Announced once at startup rather than per event. With auto-scoring off,
  // every audit still records its CI signals but no contract ever acquires a
  // trust score unless a human opens the XAI tab, so a stalled pipeline has a
  // stated cause in the log rather than looking like a bug.
  if (scoreTriggerDeps.enabled) {
    logger.info(
      { gatewayUrl: scoreTriggerDeps.gatewayUrl },
      'Automatic XAI scoring enabled: audits will trigger GET /score on the gateway',
    );
  } else {
    logger.warn(
      'ENABLE_AUTO_SCORING=false. Contracts will not be scored automatically and ' +
        'cannot settle until /score is called for them by hand.',
    );
  }

  subscribeAuditSignals();
  subscribeTrustScore();
  subscribeScopeDecisions();
  subscribeEscrowEvents();
  subscribeSettlementRequests();

  await reconcileAbandonedSettlements();
  await reconcileMissingScores();
  scoreReconcileTimer = setInterval(() => void reconcileMissingScores(), SCORE_RECONCILE_INTERVAL_MS);
  await reconcilePendingPayouts();
  payoutReconcileTimer = setInterval(() => void reconcilePendingPayouts(), PAYOUT_RECONCILE_INTERVAL_MS);

  logger.info('Settlement oracle ready.');
}

/**
 * The settlement worker is the one process in this money-moving path that
 * had no graceful shutdown at all — api-gateway and ci-worker both already
 * do this. Correctness during a mid-settlement SIGTERM still comes from
 * Postgres transaction atomicity (commitSettlement) plus a generous
 * terminationGracePeriodSeconds in the Deployment, not from anything below;
 * this closes resources cleanly on the ordinary shutdown path instead of
 * leaving the process to be killed once the grace period elapses.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down...`);
  if (payoutReconcileTimer) clearInterval(payoutReconcileTimer);
  if (scoreReconcileTimer) clearInterval(scoreReconcileTimer);
  if (metricsServer) await new Promise((resolve) => metricsServer!.close(resolve));
  await dbPool.end();
  await ledgerClient.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

if (process.env.NODE_ENV !== 'test') {
  start().catch((err) => {
    logger.error(err);
    process.exit(1);
  });
}

// eventBus is exported for the integration test that proves the audit ->
// scoring -> gate chain closes. Under NODE_ENV=test createEventBus() hands back
// a fresh InMemoryBus per call, so a test that built its own would be talking
// to a different bus than the subscriptions are listening on and would pass
// while the chain was broken.
// claimSettlement is exported so the concurrency suite can exercise the shipped
// guard rather than a copy of its SQL. The previous test re-typed the statement
// inline as `ON CONFLICT DO NOTHING`, which is not what this does — so it
// asserted single-fire against a query the worker had already moved on from,
// and could never have covered the FAILED re-claim path the WHERE clause exists
// for.
// attemptPayout and reconcilePendingPayouts are exported so the payout-leg
// test suite can exercise the real functions directly, the same reasoning
// claimSettlement's export above already documents. attemptScoring and
// reconcileMissingScores are exported for the same reason, one stage
// earlier in the pipeline.
// metricsServer is exported so a test that calls start() directly (bypassing
// the NODE_ENV=test guard above to exercise the real startup path) has a way
// to close the Prometheus listener afterward. Without this, the port stays
// bound past the test file's own process and collides with the next test or
// suite that also calls start() — this is what happens.
export {
  start,
  oracle,
  eventBus,
  claimSettlement,
  attemptPayout,
  reconcilePendingPayouts,
  PAYOUT_MAX_ATTEMPTS,
  attemptScoring,
  reconcileMissingScores,
  SCORE_MAX_ATTEMPTS,
  metricsServer,
};
