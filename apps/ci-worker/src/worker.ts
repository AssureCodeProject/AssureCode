/**
 * @assurecode/ci-worker — Consumes code.push events, orchestrates zero-trust CI sandbox.
 */

import { loadConfig, createLogger } from '@assurecode/config';
import { createEventBus } from '@assurecode/event-bus';
import { EVENT_TOPICS, type EventEnvelope } from '@assurecode/shared';
import { analyzeAST } from './ast-analyzer.js';
import { performDualLayerScan } from './security-auditor.js';
import { runInSandbox } from './sandbox-runner.js';

const config = loadConfig();
const logger = createLogger('ci-worker', config.LOG_LEVEL);
const eventBus = createEventBus(config.REDIS_URL);


/**
 * Execute real CI pipeline steps: sandbox runner, AST complexity, hidden test injection, security scan, visual proof.
 */
export async function processCodePush(
  contractId: string,
  correlationId: string,
  sampleCode?: string,
  options?: { workDir?: string },
): Promise<void> {
  const startTime = Date.now();
  logger.info({ contractId, correlationId }, 'Starting zero-trust CI pipeline');

  // A pipeline with nothing to analyse has no verdict to give. This used to
  // fall back to a hardcoded `processTransaction` sample, so a push carrying no
  // code still produced complexity and security numbers — for a snippet the
  // freelancer never wrote.
  if (!sampleCode || sampleCode.trim() === '') {
    throw new Error(
      `No code supplied for contract ${contractId}. Refusing to emit audit telemetry ` +
        'for code that was never submitted.',
    );
  }
  const codeToAnalyze = sampleCode;

  // Step 1: Provision the sandbox (Docker where available, Node permission model otherwise)
  const sandboxResult = await runInSandbox(contractId, { workDir: options?.workDir });
  logger.info(
    { contractId, sandboxId: sandboxResult.sandboxId, runner: sandboxResult.runner, provisioned: sandboxResult.provisioned },
    'Sandbox provisioned',
  );
  await eventBus.publish(
    'ci.sandbox.ready',
    { contractId, sandboxId: sandboxResult.sandboxId, runner: sandboxResult.runner, provisioned: sandboxResult.provisioned },
    correlationId,
  );

  // Step 2: AST Complexity Analysis
  const astResults = analyzeAST(codeToAnalyze);
  logger.info({ contractId, astResults }, 'AST complexity calculated');
  await eventBus.publish('ci.ast.completed', { contractId, ...astResults }, correlationId);

  // Step 3: Hidden Test Injection & Verification
  const passedTests = sandboxResult.passedTests;
  const totalTests = sandboxResult.totalTests;
  logger.info({ contractId, passedTests, totalTests }, 'Hidden test suite executed');
  await eventBus.publish('ci.tests.completed', { contractId, passedTests, totalTests }, correlationId);

  // Step 4: OWASP Top 10:2025 scan — Layer 1 static, Layer 2 LLM via ai-service.
  const securityScan = await performDualLayerScan(codeToAnalyze, {
    aiServiceUrl: config.AI_SERVICE_URL,
  });
  logger.info(
    {
      contractId,
      securityPassed: securityScan.passed,
      vulnerabilities: securityScan.vulnerabilities.length,
      layersRun: securityScan.layersRun,
      llmError: securityScan.llmError,
    },
    'Security scan completed',
  );
  await eventBus.publish('security.scan.completed', { contractId, ...securityScan }, correlationId);

  // Step 5: Aggregate & Publish Final audit.completed Telemetry
  const scanDuration = Number(((Date.now() - startTime) / 1000).toFixed(2));
  // Require totalTests > 0 so an indeterminate sandbox result (0/0) does not auto-pass.
  const overallPassed = securityScan.passed && passedTests === totalTests && totalTests > 0 && astResults.maintainabilityIndex > 50;

  const auditResults = {
    contractId,
    maintainability: astResults.maintainabilityIndex,
    cyclomaticComplexity: astResults.cyclomaticComplexity,
    passedTests,
    totalTests,
    vulnerabilities: securityScan.vulnerabilities.length,
    securityScore: securityScan.score,
    passed: overallPassed,
    scanDuration,
    timestamp: new Date().toISOString(),
  };

  logger.info({ contractId, auditResults }, 'CI Pipeline complete, publishing audit.completed');
  await eventBus.publish(EVENT_TOPICS.AUDIT_COMPLETED, auditResults, correlationId);
}

async function main(): Promise<void> {
  logger.info('CI Worker starting...');

  await eventBus.subscribe(EVENT_TOPICS.CODE_PUSH_RECEIVED, async (event: EventEnvelope) => {
    const { contractId, code } = event.payload as { contractId: string; code?: string };
    const correlationId = event.correlationId || event.id;

    logger.info({ contractId, correlationId }, 'Received code.push.received event');

    try {
      await processCodePush(contractId, correlationId, code);
      logger.info({ contractId }, 'CI processing successfully completed');
    } catch (error) {
      logger.error({ contractId, error }, 'CI processing failed');
    }
  });

  logger.info('CI Worker ready and subscribed to events.');
}

process.on('SIGTERM', async () => {
  if (typeof eventBus.close === 'function') await eventBus.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  if (typeof eventBus.close === 'function') await eventBus.close();
  process.exit(0);
});

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    logger.error(err, 'CI Worker crash');
    process.exit(1);
  });
}
