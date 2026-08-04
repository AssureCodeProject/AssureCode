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
import { createEventBus } from '@assurecode/event-bus';
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

const eventBus = createEventBus(config.REDIS_URL);
const oracle = new OracleStore(dbPool);

async function start() {
  logger.info('Starting settlement oracle...');

  // ── 1. CI signals ──────────────────────────────────────────────────
  eventBus.subscribe(EVENT_TOPICS.AUDIT_COMPLETED, async (event: EventEnvelope) => {
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

  // ── 2. Trust score ─────────────────────────────────────────────────
  //
  // Without this subscription the score was computed, published, and ignored:
  // nothing in the settlement path ever read it, so the ">= 85" gate the
  // objective specifies did not exist anywhere in the running system.
  eventBus.subscribe(EVENT_TOPICS.XAI_SCORED, async (event: EventEnvelope) => {
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

  // ── 3. Scope decisions ─────────────────────────────────────────────
  //
  // The scope signal is derived from scope_checks at evaluation time, so this
  // subscription exists only to log. Recomputing on read is what stops a single
  // early in-scope message from latching the signal open.
  eventBus.subscribe(EVENT_TOPICS.SCOPE_CHECKED, async (event: EventEnvelope) => {
    const payload = event.payload as any;
    if (!payload?.contractId) return;
    logger.info(
      { contractId: payload.contractId, allowed: payload.allowed },
      'Scope decision observed (signal is derived from scope_checks on evaluation)',
    );
  });

  // ── 4. Settlement ──────────────────────────────────────────────────
  eventBus.subscribe(EVENT_TOPICS.SETTLEMENT_REQUESTED, async (event: EventEnvelope) => {
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
      await eventBus.publish(
        EVENT_TOPICS.SETTLEMENT_REJECTED,
        { contractId, reason: `Oracle state unavailable: ${err.message}` },
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

    // Single-fire guard: the first INSERT wins, concurrent ones no-op.
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
      return;
    }

    if (guardRes.rowCount !== 1) {
      logger.warn({ contractId }, 'Settlement already in progress or complete; ignoring');
      return;
    }

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

      const client = await dbPool.connect();
      try {
        await client.query('BEGIN');
        // SETTLEMENT_COMPLETED as the ledger action type, so the chain records
        // what happened rather than a generic INVOICE.
        await ledgerClient.append(contractId, 'SETTLEMENT_COMPLETED', settlementPayload, client);
        await client.query(
          `UPDATE escrow SET status = 'RELEASED' WHERE payment_intent_id = $1`,
          [held.paymentIntentId],
        );
        await client.query(
          `UPDATE settlements
              SET status = 'COMPLETED', transfer_id = $1, updated_at = NOW()
            WHERE contract_id = $2`,
          [held.paymentIntentId, contractId],
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        await dbPool.query(
          `UPDATE settlements SET status = 'FAILED', updated_at = NOW() WHERE contract_id = $1`,
          [contractId],
        );
        throw txErr;
      } finally {
        client.release();
      }

      await eventBus.publish(EVENT_TOPICS.SETTLEMENT_COMPLETED, settlementPayload, correlationId);
      logger.info(
        { contractId, paymentIntentId: held.paymentIntentId },
        'Settlement complete, escrow released',
      );
    } catch (err: any) {
      logger.error({ contractId, err: err.message }, 'Settlement execution failed');
      await dbPool
        .query(`UPDATE settlements SET status = 'FAILED', updated_at = NOW() WHERE contract_id = $1`, [
          contractId,
        ])
        .catch(() => undefined);
      await eventBus.publish(
        EVENT_TOPICS.SETTLEMENT_REJECTED,
        { contractId, reason: `Escrow release failed: ${err.message}` },
        correlationId,
      );
    }
  });

  logger.info('Settlement oracle ready.');
}

if (process.env.NODE_ENV !== 'test') {
  start().catch((err) => {
    logger.error(err);
    process.exit(1);
  });
}

export { start, oracle };
