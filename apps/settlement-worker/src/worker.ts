/**
 * Settlement oracle.
 *
 * Objective 4: the trust score triggers a Node.js oracle that releases escrow.
 * The gate is `trustScore >= 85 && criticalVulns === 0`, evaluated alongside the
 * four CI signals, against state held in Postgres rather than in this process.
 *
 * Release is a *capture*, not a transfer. StripeEscrowAdapter creates the
 * PaymentIntent with `capture_method: 'manual'`, which is what makes the funds
 * genuinely held: the money is authorised at contract time and only moves when
 * the oracle captures it. The previous implementation skipped the capture and
 * called transferToFreelancer with the hardcoded destination
 * 'acct_freelancer_123', so the escrow was never actually released and every
 * settlement paid the same placeholder account.
 */
import { createEventBus, eventBusOptionsFromConfig } from '@assurecode/event-bus';
import { loadConfig, createLogger, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import { LedgerClient } from '@assurecode/ledger-client';
import { createEscrowAdapter } from '@assurecode/stripe-adapter';
import { EVENT_TOPICS, EventEnvelope, SettlementRequested } from '@assurecode/shared';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { OracleStore } from '@assurecode/oracle';

const config = loadConfig();
const logger = createLogger('settlement-worker', config.LOG_LEVEL);
const databaseUrl = getDatabaseUrl(config);

const dbPool = new pg.Pool(buildDbConfig(databaseUrl));
const ledgerClient = new LedgerClient(databaseUrl);
const escrowAdapter = createEscrowAdapter({
  secretKey: config.STRIPE_SECRET_KEY ?? '',
  webhookSecret: config.STRIPE_WEBHOOK_SECRET ?? '',
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

    const signals = {
      astPassed: maintainability >= 10,
      testsPassed: passedTests === totalTests && totalTests > 0,
      securityPassed: vulnerabilities === 0,
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

// ── 4. Settlement ────────────────────────────────────────────────────

/**
 * Claim the right to settle this contract, exactly once.
 *
 * The first INSERT wins and concurrent ones no-op, so a duplicated
 * SETTLEMENT_REQUESTED event cannot capture the same PaymentIntent twice.
 * Returns false when this process is not the claimant — including when the
 * guard query itself failed, since an unconfirmed claim is not a claim.
 */
async function claimSettlement(contractId: string): Promise<boolean> {
  let guardRes;
  try {
    guardRes = await dbPool.query(
      `INSERT INTO settlements (contract_id, status)
       VALUES ($1, 'PROCESSING')
       ON CONFLICT (contract_id) DO NOTHING
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
  paymentIntentId: string;
  trustScore: number | null;
  settlementPayload: Record<string, unknown>;
}): Promise<void> {
  const { contractId, freelancerId, paymentIntentId, trustScore, settlementPayload } = args;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    // SETTLEMENT_COMPLETED as the ledger action type, so the chain records
    // what happened rather than a generic INVOICE.
    await ledgerClient.append(contractId, 'SETTLEMENT_COMPLETED', settlementPayload, client);
    await client.query(
      `UPDATE escrow SET status = 'RELEASED' WHERE payment_intent_id = $1`,
      [paymentIntentId],
    );
    await client.query(
      `UPDATE settlements
          SET status = 'COMPLETED', transfer_id = $1, updated_at = NOW()
        WHERE contract_id = $2`,
      [paymentIntentId, contractId],
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
      const held = await oracle.findEscrowPaymentIntent(contractId);
      if (!held) {
        throw new Error(
          `no PENDING escrow PaymentIntent found for ${contractId}; nothing to release`,
        );
      }

      // Release the held funds. This is the action the whole oracle exists to
      // authorise.
      const captured = await escrowAdapter.capturePaymentIntent(held.paymentIntentId);

      const settlementPayload = {
        contractId,
        freelancerId,
        amountCents: amountCents ?? held.amountCents,
        paymentIntentId: held.paymentIntentId,
        captureStatus: captured.status,
        trustScore: verdict.signals.trustScore,
        criticalVulns: verdict.signals.criticalVulns,
        oracleSignals: verdict.signals,
        settledAt: new Date().toISOString(),
      };

      await commitSettlement({
        contractId,
        freelancerId,
        paymentIntentId: held.paymentIntentId,
        trustScore: verdict.signals.trustScore,
        settlementPayload,
      });

      await eventBus.publish(EVENT_TOPICS.SETTLEMENT_COMPLETED, settlementPayload, correlationId);
      logger.info(
        { contractId, paymentIntentId: held.paymentIntentId },
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
