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
import {
  createSourceFetcher,
  SourceUnavailableError,
  type PushRef,
  type SourceFetcher,
} from './source-fetcher.js';

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
  options?: {
    workDir?: string;
    auditStore?: AuditStore;
    demo?: boolean;
    /** Where to get the source when the event carries none. See source-fetcher.ts. */
    sourceFetcher?: SourceFetcher | null;
    /** Repository coordinates from the webhook, used only by that path. */
    pushRef?: PushRef;
  },
): Promise<void> {
  const startTime = Date.now();
  logger.info({ contractId, correlationId }, 'Starting zero-trust CI pipeline');

  // A GitHub push arrives with repository coordinates but no file contents, so
  // the source is fetched here, pinned to the reported commit. Only reached when
  // the event carried no inline code — the gateway's /simulate-push path does,
  // and must not be second-guessed.
  if ((!sampleCode || sampleCode.trim() === '') && options?.pushRef && options.sourceFetcher) {
    logger.info(
      { contractId, commitHash: options.pushRef.commitHash },
      'Event carried no inline code; fetching pushed source',
    );
    // Deliberately not wrapped in a try/catch that falls back. A fetch failure
    // must surface as a failed run: auditing something other than what was
    // pushed produces a trust score that looks like evidence and is not.
    sampleCode = await options.sourceFetcher.fetchSource(options.pushRef);
    logger.info({ contractId, bytes: sampleCode.length }, 'Fetched pushed source');
  }

  // A pipeline with nothing to analyse has no verdict to give. This used to
  // fall back to a hardcoded `processTransaction` sample, so a push carrying no
  // code still produced complexity and security numbers — for a snippet the
  // freelancer never wrote.
  if (!sampleCode || sampleCode.trim() === '') {
    // Name which of the two preconditions is missing. The GitHub path is gated
    // twice — ENABLE_GITHUB_SOURCE_FETCH must be on, *and* the contract must
    // have a linked repository for webhook-ingest to have resolved it at all —
    // and a single message covering both left an operator turning the flag on
    // and still seeing the same failure, with nothing to say why.
    const cause = options?.pushRef
      ? options.sourceFetcher
        ? 'the source fetch produced nothing for the pushed commit'
        : 'ENABLE_GITHUB_SOURCE_FETCH is not "true", so ci-worker did not fetch the pushed source'
      : 'the event carried no inline code and no push reference (nothing identifies a commit to fetch)';

    throw new Error(
      `No code supplied for contract ${contractId}, and no source could be fetched: ${cause}. ` +
        'Refusing to emit audit telemetry for code that was never submitted. ' +
        'A GitHub push carries no file contents, so the real path needs both ' +
        'ENABLE_GITHUB_SOURCE_FETCH=true and a repository linked to the contract ' +
        '(PATCH /api/contracts/:id/github-repo, or the "GitHub repository" field on ' +
        'the contract initialization form).',
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
        serviceToken: config.SERVICE_TOKEN,
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
        exitCode: sandboxResult.exitCode,
      },
      'Sandbox provisioned',
    );
    // totalTests === 0 is the documented indeterminate signal (types.ts's
    // parseTestOutput), not necessarily "genuinely zero tests" — it's
    // indistinguishable from the sandbox itself failing (bad pull, npm ci
    // error) unless the actual output is visible. Logged only on this path so
    // the common case stays quiet.
    if (sandboxResult.totalTests === 0) {
      logger.warn(
        { contractId, sandboxId: sandboxResult.sandboxId, rawOutput: sandboxResult.rawOutput.slice(0, 2000) },
        'Sandbox produced no parseable test output',
      );
    }
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
      serviceToken: config.SERVICE_TOKEN,
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
 * How a real GitHub push reaches this pipeline.
 *
 * apps/webhook-ingest resolves the contract from the pushed repository —
 * `contracts.github_repo_full_name`, linked via
 * PATCH /api/contracts/:contractId/github-repo — and publishes
 * CODE_PUSH_RECEIVED with `contractId`, `commitHash`, `repoUrl` and `ref`, but
 * no `code`: a push webhook carries no file contents. processCodePush fetches
 * the source itself, pinned to `commitHash` (see source-fetcher.ts for why the
 * SHA and not the ref).
 *
 * That fetch is gated on ENABLE_GITHUB_SOURCE_FETCH. With it off, the fetcher
 * below is null and a webhook-originated push is refused with an explanation
 * rather than audited against something other than what was pushed; only the
 * gateway's /simulate-push, which carries code inline, reaches the pipeline.
 */
async function main(): Promise<void> {
  logger.info('CI Worker starting...');

  // Built once. Null when ENABLE_GITHUB_SOURCE_FETCH is not 'true', which is a
  // checkable "the GitHub path is off" rather than a fetcher that fails on
  // first use — a very different diagnosis to report.
  const sourceFetcher = createSourceFetcher();
  logger.info(
    { githubSourceFetch: sourceFetcher !== null },
    sourceFetcher
      ? 'GitHub source fetching enabled; real pushes will be audited'
      : 'GitHub source fetching disabled; only pushes carrying inline code will be audited',
  );

  await eventBus.subscribe(EVENT_TOPICS.CODE_PUSH_RECEIVED, async (event: EventEnvelope) => {
    const { contractId, code, demo, repoUrl, commitHash } = event.payload as {
      contractId: string;
      code?: string;
      demo?: boolean;
      repoUrl?: string;
      commitHash?: string;
    };
    const correlationId = event.correlationId || event.id;

    logger.info({ contractId, correlationId, demo: Boolean(demo) }, 'Received code.push.received event');

    // Only a webhook-originated event carries these; /simulate-push does not.
    const pushRef: PushRef | undefined =
      repoUrl && commitHash ? { repoUrl, commitHash } : undefined;

    try {
      await processCodePush(contractId, correlationId, code, {
        demo: Boolean(demo),
        sourceFetcher,
        pushRef,
      });
      logger.info({ contractId }, 'CI processing successfully completed');
    } catch (error) {
      // Distinguished in the log because the operator action differs: a source
      // fetch failure is a configuration or permissions problem, not a failing
      // audit, and it must not be read as "the code did not pass".
      if (error instanceof SourceUnavailableError) {
        logger.error(
          { contractId, repoUrl, commitHash, error: error.message },
          'Could not obtain pushed source; no audit was performed',
        );
      } else {
        logger.error({ contractId, error }, 'CI processing failed');
      }
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

// Exported so the golden-path suite can start the real subscriptions in-process
// rather than reimplementing them. Mirrors settlement-worker's `start`.
export { main as start, eventBus };
