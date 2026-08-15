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
import { loadConfig, createLogger, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import { LedgerClient } from '@assurecode/ledger-client';
import { createRazorpayAdapter } from '@assurecode/razorpay-adapter';
import { EVENT_TOPICS, EventEnvelope, SettlementRequested } from '@assurecode/shared';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { OracleStore } from '@assurecode/oracle';

const config = loadConfig();
const logger = createLogger('settlement-worker', config.LOG_LEVEL);
const databaseUrl = getDatabaseUrl(config);

const dbPool = new pg.Pool(buildDbConfig(databaseUrl));
const ledgerClient = new LedgerClient(databaseUrl);
const payments = createRazorpayAdapter({
  keyId: config.RAZORPAY_KEY_ID ?? '',
  keySecret: config.RAZORPAY_KEY_SECRET ?? '',
  webhookSecret: config.RAZORPAY_WEBHOOK_SECRET ?? '',
});

const eventBus = createEventBus(eventBusOptionsFromConfig(config));
const oracle = new OracleStore(dbPool);

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
    }
  });
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
      await oracle.recordScore(contractId, trustScore, criticalVulns);
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
async function sealMerkleRoot(contractId: string): Promise<void> {
  try {
    const { root, leafCount } = await ledgerClient.computeAndStoreRoot(contractId);
    logger.info({ contractId, root, leafCount }, 'Merkle root computed and stored');
  } catch (rootErr: any) {
    logger.error({ contractId, err: rootErr.message }, 'Failed to compute/store Merkle root after settlement');
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

      await sealMerkleRoot(contractId);
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

async function start(): Promise<void> {
  logger.info('Starting settlement oracle...');

  subscribeAuditSignals();
  subscribeTrustScore();
  subscribeScopeDecisions();
  subscribeEscrowEvents();
  subscribeSettlementRequests();

  logger.info('Settlement oracle ready.');
}

if (process.env.NODE_ENV !== 'test') {
  start().catch((err) => {
    logger.error(err);
    process.exit(1);
  });
}

export { start, oracle };
