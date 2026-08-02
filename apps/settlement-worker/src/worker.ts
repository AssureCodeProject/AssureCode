import { createEventBus } from '@assurecode/event-bus';
import { loadConfig, createLogger, getDatabaseUrl } from '@assurecode/config';
import { LedgerClient } from '@assurecode/ledger-client';
import { createEscrowAdapter } from '@assurecode/stripe-adapter';
import { EVENT_TOPICS, EventEnvelope, SettlementRequested } from '@assurecode/shared';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const config = loadConfig();
const logger = createLogger('settlement-worker', config.LOG_LEVEL);
const databaseUrl = getDatabaseUrl(config);

const dbPool = new pg.Pool({ connectionString: databaseUrl });
const ledgerClient = new LedgerClient(databaseUrl);
const escrowAdapter = createEscrowAdapter({
  secretKey: config.STRIPE_SECRET_KEY ?? '',
  webhookSecret: config.STRIPE_WEBHOOK_SECRET ?? '',
});

const eventBus = createEventBus(config.REDIS_URL);

interface ContractOracleState {
  astPassed: boolean;
  testsPassed: boolean;
  securityPassed: boolean;
  scopePassed: boolean;
  videoPassed: boolean;
}

const oracleStore = new Map<string, ContractOracleState>();

function getState(contractId: string): ContractOracleState {
  if (!oracleStore.has(contractId)) {
    oracleStore.set(contractId, {
      astPassed: false,
      testsPassed: false,
      securityPassed: false,
      scopePassed: false,
      videoPassed: false,
    });
  }
  return oracleStore.get(contractId)!;
}

async function start() {
  logger.info('Starting 5-Signal Oracle Settlement Worker...');

  // 1. Listen for Audit Completed (AST, Tests, Security)
  eventBus.subscribe(EVENT_TOPICS.AUDIT_COMPLETED, async (event: EventEnvelope) => {
    const payload = event.payload as any;
    const contractId = payload.contractId || payload.auditResults?.contractId;
    if (!contractId) return;
    const state = getState(contractId);
    
    // BUG-004: ci-worker publishes audit data FLAT on the payload object, not nested
    // under payload.auditResults. Support both shapes for robustness.
    const auditData: any = payload.auditResults ?? payload;
    const maintainability = Number(auditData.maintainability ?? -1);
    const passedTests    = Number(auditData.passedTests    ?? 0);
    const totalTests     = Number(auditData.totalTests     ?? 0);
    const vulnerabilities = Number(auditData.vulnerabilities ?? 1);

    state.astPassed      = maintainability >= 10;
    state.testsPassed    = passedTests === totalTests && totalTests > 0;
    state.securityPassed = vulnerabilities === 0;

    logger.info({ contractId, auditData: { maintainability, passedTests, totalTests, vulnerabilities }, state }, 'Oracle ingested AUDIT_COMPLETED signals');
    
    logger.info({ contractId, state }, 'Oracle ingested AUDIT_COMPLETED');
  });

  // 2. Listen for Scope Checked
  eventBus.subscribe(EVENT_TOPICS.SCOPE_CHECKED, async (event: EventEnvelope) => {
    const payload = event.payload as any;
    const contractId = payload.contractId;
    if (!contractId) return;
    const state = getState(contractId);
    if (payload.allowed) {
      state.scopePassed = true;
    }
    logger.info({ contractId, state }, 'Oracle ingested SCOPE_CHECKED');
  });

  // 3. Listen for Video Verified (ONLY explicit VIDEO_VERIFIED event alters state)
  eventBus.subscribe(EVENT_TOPICS.VIDEO_VERIFIED, async (event: EventEnvelope) => {
    const payload = event.payload as any;
    const contractId = payload.contractId;
    if (!contractId) return;
    getState(contractId).videoPassed = true;
    logger.info({ contractId }, 'Oracle ingested VIDEO_VERIFIED');
  });

  // 4. Listen for Settlement Requested
  eventBus.subscribe(EVENT_TOPICS.SETTLEMENT_REQUESTED, async (event: EventEnvelope) => {
    const payload = event.payload as SettlementRequested;
    const { contractId, freelancerId, amountCents } = payload;
    
    logger.info({ contractId }, 'Evaluating 5-Signal Oracle for settlement');
    const state = getState(contractId);
    
    // Strict Boolean AND
    const isApproved = 
      state.astPassed && 
      state.testsPassed && 
      state.securityPassed && 
      state.scopePassed && 
      state.videoPassed;

    const correlationId = randomUUID();

    if (!isApproved) {
      logger.warn({ contractId, state }, 'Settlement REJECTED by Oracle');
      await eventBus.publish(
        EVENT_TOPICS.SETTLEMENT_REJECTED,
        { contractId, reason: 'Oracle conditions not met', state },
        correlationId
      );
      return;
    }

    // Single-fire settlement guard check using settlements table
    let guardRes;
    try {
      guardRes = await dbPool.query(
        `INSERT INTO settlements (contract_id, status)
         VALUES ($1, 'PROCESSING')
         ON CONFLICT (contract_id) DO NOTHING
         RETURNING contract_id`,
        [contractId]
      );
    } catch (dbErr) {
      logger.error({ contractId, dbErr }, 'Settlements guard table query failed');
    }

    if (!guardRes || guardRes.rowCount !== 1) {
      logger.warn(
        { contractId, rowCount: guardRes?.rowCount },
        'Settlement request rejected: Failed to acquire DB lock or settlement already in progress',
      );
      return;
    }

    logger.info({ contractId }, 'Settlement APPROVED by Oracle & locked in DB guard. Executing transfer.');

    try {
      const transferRes = await escrowAdapter.transferToFreelancer({
        amountCents,
        destinationAccountId: 'acct_freelancer_123',
        contractId,
      });

      const invoicePayload = {
        amountCents,
        freelancerId,
        transferId: transferRes.transferId,
        oracleState: state,
        settledAt: new Date().toISOString(),
      };

      // Atomic DB transaction for Ledger Append + Settlements status update
      const client = await dbPool.connect();
      try {
        await client.query('BEGIN');
        await ledgerClient.append(contractId, 'INVOICE', invoicePayload, client);
        await client.query(
          `UPDATE settlements
           SET status = 'COMPLETED', transfer_id = $1, updated_at = NOW()
           WHERE contract_id = $2`,
          [transferRes.transferId, contractId]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        await dbPool.query(
          `UPDATE settlements SET status = 'FAILED', updated_at = NOW() WHERE contract_id = $1`,
          [contractId]
        );
        throw txErr;
      } finally {
        client.release();
      }

      await eventBus.publish(
        EVENT_TOPICS.SETTLEMENT_COMPLETED,
        {
          contractId,
          amountCents,
          transferId: transferRes.transferId,
          completedAt: new Date().toISOString(),
        },
        correlationId
      );

      logger.info({ contractId, transferId: transferRes.transferId }, 'Settlement complete');
    } catch (err: any) {
      logger.error({ contractId, err: err.message }, 'Settlement execution failed');
      await eventBus.publish(
        EVENT_TOPICS.SETTLEMENT_REJECTED,
        { contractId, reason: `Transfer failed: ${err.message}` },
        correlationId
      );
    }
  });
}

start().catch(err => {
  logger.error(err);
  process.exit(1);
});

