/**
 * @assurecode/ci-worker — Consumes code.push events, orchestrates zero-trust CI sandbox.
 */

import { loadConfig, createLogger, getDatabaseUrl } from '@assurecode/config';
import { createEventBus, eventBusOptionsFromConfig } from '@assurecode/event-bus';
import { EVENT_TOPICS, type EventEnvelope } from '@assurecode/shared';
import { analyzeAST } from './ast-analyzer.js';
import { performDualLayerScan } from './security-auditor.js';
import { runInSandbox } from './sandbox-runner.js';
import { PostgresAuditStore, type AuditStore } from './audit-store.js';
import { buildWorkspace, type Workspace } from './workspace-builder.js';

const config = loadConfig();
const logger = createLogger('ci-worker', config.LOG_LEVEL);
const eventBus = createEventBus(eventBusOptionsFromConfig(config));

let defaultAuditStore: AuditStore | undefined;
function getAuditStore(): AuditStore {
  if (!defaultAuditStore) {
    defaultAuditStore = new PostgresAuditStore(getDatabaseUrl(config));
  }
  return defaultAuditStore;
}

/**
 * Execute the zero-trust CI pipeline: sandbox, AST complexity, hidden tests,
 * dual-layer security scan, then persist and publish the audit telemetry.
 */
export async function processCodePush(
  contractId: string,
  correlationId: string,
  sampleCode?: string,
  options?: { workDir?: string; auditStore?: AuditStore; demo?: boolean },
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

  // Step 1: Provision the sandbox (Docker where available, Node permission model otherwise)
  //
  // The workspace is what gives the sandbox something to execute. Without it
  // every run returned 0/0, which made `overallPassed` permanently false,
  // made /score answer 409, and left the oracle with no trust score — so no
  // contract could be settled. A build failure here is logged and the run
  // continues to 0/0, which the oracle reads as indeterminate: still never a
  // pass, but now the reason appears in the sandbox output instead of being
  // silently indistinguishable from a working pipeline.
  let workspace: Workspace | undefined;
  if (!options?.workDir) {
    try {
      workspace = await buildWorkspace({
        contractId,
        code: sampleCode,
        aiServiceUrl: config.AI_SERVICE_URL,
        demo: options?.demo,
      });
      logger.info(
        { contractId, workDir: workspace.dir, bundleSource: workspace.bundleSource },
        'Test workspace materialised',
      );
    } catch (err) {
      logger.error(
        { contractId, err: err instanceof Error ? err.message : String(err) },
        'Could not materialise a test workspace; the sandbox will report 0/0 (indeterminate)',
      );
    }
  }

  try {
    const sandboxResult = await runInSandbox(contractId, {
      workDir: options?.workDir ?? workspace?.dir,
      entrypoint: workspace?.entrypoint,
      entryArgs: workspace?.entryArgs,
    });
    logger.info(
      {
        contractId,
        sandboxId: sandboxResult.sandboxId,
        runner: sandboxResult.runner,
        provisioned: sandboxResult.provisioned,
        passedTests: sandboxResult.passedTests,
        totalTests: sandboxResult.totalTests,
      },
      'Sandbox provisioned',
    );
    await eventBus.publish(
      EVENT_TOPICS.CI_SANDBOX_READY,
      { contractId, sandboxId: sandboxResult.sandboxId, runner: sandboxResult.runner, provisioned: sandboxResult.provisioned },
      correlationId,
    );

    // Step 2: AST Complexity Analysis
    const astResults = analyzeAST(sampleCode);
    logger.info({ contractId, astResults }, 'AST complexity calculated');
    await eventBus.publish(EVENT_TOPICS.CI_AST_COMPLETED, { contractId, ...astResults }, correlationId);

    // Step 3: Hidden Test Injection & Verification
    const passedTests = sandboxResult.passedTests;
    const totalTests = sandboxResult.totalTests;
    logger.info({ contractId, passedTests, totalTests }, 'Hidden test suite executed');
    await eventBus.publish(EVENT_TOPICS.CI_TESTS_COMPLETED, { contractId, passedTests, totalTests }, correlationId);

    // Step 4: OWASP Top 10:2025 scan — Layer 1 static, Layer 2 LLM via ai-service.
    //
    // `requireLlmLayer` is deliberately NOT set. Its concern is real — a Layer 2
    // outage degrading to a static-only scan is how an unavailable model becomes
    // a clean bill of health — but throwing here would discard the AST and test
    // telemetry this run already measured, and report a pipeline fault for what
    // is really a partial result. The degradation is carried forward instead
    // (`securityScanComplete` below), so a half-scan can still be *seen* but can
    // never be *passed*. Same guarantee, without losing the evidence.
    const securityScan = await performDualLayerScan(sampleCode, {
      aiServiceUrl: config.AI_SERVICE_URL,
    });
    const securityScanComplete = securityScan.layersRun.includes('llm');
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
    await eventBus.publish(EVENT_TOPICS.SECURITY_SCAN_COMPLETED, { contractId, ...securityScan }, correlationId);

    // Step 5: Aggregate & Publish Final audit.completed Telemetry
    const scanDuration = Number(((Date.now() - startTime) / 1000).toFixed(2));
    // Require totalTests > 0 so an indeterminate sandbox result (0/0) does not
    // auto-pass, and securityScanComplete so a Layer-2 outage cannot either.
    const overallPassed =
      securityScan.passed &&
      securityScanComplete &&
      passedTests === totalTests &&
      totalTests > 0 &&
      astResults.maintainabilityIndex > 50;

    // Severity counts travel with the payload. Objective 4's settlement gate is
    // `trustScore >= 85 && criticalVulns === 0`, and a total vulnerability count
    // cannot answer the second half of that.
    const criticalVulns = securityScan.vulnerabilities.filter((v) => v.severity === 'CRITICAL').length;
    const highVulns = securityScan.vulnerabilities.filter((v) => v.severity === 'HIGH').length;

    const auditResults = {
      contractId,
      maintainability: astResults.maintainabilityIndex,
      cyclomaticComplexity: astResults.cyclomaticComplexity,
      passedTests,
      totalTests,
      vulnerabilities: securityScan.vulnerabilities.length,
      criticalVulns,
      highVulns,
      securityScore: securityScan.score,
      // Which layers actually ran, so a downstream reader can tell a clean scan
      // from a scan that could not complete. The settlement oracle reads this:
      // "no findings" from Layer 1 alone is not the same claim as "no findings".
      securityScanComplete,
      layersRun: securityScan.layersRun,
      ...(securityScan.llmError ? { securityScanError: securityScan.llmError } : {}),
      passed: overallPassed,
      scanDuration,
      timestamp: new Date().toISOString(),
    };

    // Persist before publishing. If the row cannot be written, the event is not
    // emitted either — otherwise the oracle would ingest signals for an audit the
    // score endpoint has no record of, and the two would disagree silently.
    await (options?.auditStore ?? getAuditStore()).save(auditResults);

    logger.info({ contractId, auditResults }, 'CI Pipeline complete, publishing audit.completed');
    await eventBus.publish(EVENT_TOPICS.AUDIT_COMPLETED, auditResults, correlationId);
  } finally {
    // The workspace holds the pushed code and the contract's hidden tests. It
    // is removed whether the pipeline succeeded or threw — leaving it behind
    // would accumulate one temp tree per push and leak the test bundle.
    if (workspace) await workspace.cleanup().catch(() => undefined);
  }
}

/**
 * Known gap: the GitHub webhook path cannot produce an audit.
 *
 * apps/webhook-ingest publishes CODE_PUSH_RECEIVED with `contractId`,
 * `commitHash`, `repoUrl` and `ref` — but no `code`, because it never fetches
 * the repository. processCodePush therefore refuses with "No code supplied",
 * which is the right refusal for a push it cannot see the contents of. Only
 * the gateway's /simulate-push route, which carries the code inline, reaches
 * the pipeline today.
 *
 * Closing it means cloning `repoUrl` at `commitHash` into the workspace.
 * DockerSandbox already implements the clone; NodePermissionSandbox cannot
 * (git is a child process, which the sandbox denies by design), so the clone
 * belongs in the workspace builder rather than in an adapter. Stated here
 * rather than left to be discovered from a silent absence of audits.
 */
async function main(): Promise<void> {
  logger.info('CI Worker starting...');

  await eventBus.subscribe(EVENT_TOPICS.CODE_PUSH_RECEIVED, async (event: EventEnvelope) => {
    const { contractId, code, demo } = event.payload as {
      contractId: string;
      code?: string;
      demo?: boolean;
    };
    const correlationId = event.correlationId || event.id;

    logger.info({ contractId, correlationId, demo: Boolean(demo) }, 'Received code.push.received event');

    try {
      await processCodePush(contractId, correlationId, code, { demo: Boolean(demo) });
      logger.info({ contractId }, 'CI processing successfully completed');
    } catch (error) {
      logger.error({ contractId, error }, 'CI processing failed');
    }
  });

  logger.info('CI Worker ready and subscribed to events.');
}

async function shutdown(): Promise<void> {
  if (typeof eventBus.close === 'function') await eventBus.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    logger.error(err, 'CI Worker crash');
    process.exit(1);
  });
}
