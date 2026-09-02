/**
 * Audit results and the live audit-pipeline WebSocket stream.
 *
 * Requires `@fastify/websocket` to already be registered on `server` — see
 * the note in contracts-chat.ts.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { EVENT_TOPICS, type EventEnvelope } from '@assurecode/shared';
import { logger, ledgerClient, eventBus, latestAuditPayload, contractPartyOnly } from '../context.js';

// The pipeline step each topic completes, in the order the UI renders them.
// Single source of truth for both what the socket subscribes to and what it
// reports — the two used to be separate lists that had to be kept in step by
// hand. AUDIT_COMPLETED closes the run and is handled separately below.
const AUDIT_STREAM_STEP_BY_TOPIC: Record<string, number> = {
  [EVENT_TOPICS.CODE_PUSH_RECEIVED]: 0,
  [EVENT_TOPICS.CI_SANDBOX_READY]: 1,
  [EVENT_TOPICS.CI_AST_COMPLETED]: 2,
  [EVENT_TOPICS.CI_TESTS_COMPLETED]: 3,
  [EVENT_TOPICS.SECURITY_SCAN_COMPLETED]: 4,
};

/** The frame to push for a pipeline topic, or null if the topic says nothing. */
function auditStreamFrame(topic: string, contractId: string): Record<string, unknown> | null {
  if (topic === EVENT_TOPICS.AUDIT_COMPLETED) {
    return { type: 'audit-complete', contractId };
  }
  const stepId = AUDIT_STREAM_STEP_BY_TOPIC[topic];
  if (stepId === undefined) return null;
  return { type: 'step-complete', stepId, contractId };
}

export function registerAuditsRoutes(server: FastifyInstance): void {
  server.get<{
    Params: { contractId: string };
    Reply: {
      maintainability: number;
      passedTests: number;
      totalTests: number;
      vulnerabilities: number;
      passed: boolean;
      scanDuration: number;
      // Specific findings behind the aggregate numbers -- see the matching
      // field on GET /api/contracts/:contractId/score.
      details: {
        testFailures: { name: string; message: string }[];
        complexFunctions: { name: string; line: number; cyclomaticComplexity: number }[];
        vulnerabilityDetails: {
          type: string;
          category: string;
          severity: string;
          message: string;
          line?: number;
        }[];
      };
    } | { error: string };
  }>('/api/audits/:contractId/results', contractPartyOnly, async (request, reply) => {
    const { contractId } = request.params;

    const chain = await ledgerClient.getChain(contractId);
    if (chain.length === 0) {
      return reply.status(404).send({ error: 'Contract not found' });
    }

    // audit_results is the record of what the pipeline measured. This used to
    // reconstruct the numbers by scanning the ledger for an AUDIT_COMPLETED
    // action and, failing that, returned a body of zeros with HTTP 200 — which
    // reads as "maintainability 0, no vulnerabilities" rather than "never ran".
    let payload: Record<string, unknown>;
    try {
      const latest = await latestAuditPayload(contractId);
      if (latest === null) {
        return reply.status(404).send({ error: `No audit has been run for ${contractId}` });
      }
      payload = latest;
    } catch (err) {
      request.log.error({ err, contractId }, 'Audit results lookup failed');
      return reply.status(503).send({ error: 'Audit results unavailable' });
    }

    const maintainability = Number(payload.maintainability ?? 0);
    const passedTests = Number(payload.passedTests ?? 0);
    const totalTests = Number(payload.totalTests ?? 0);
    const vulnerabilities = Number(payload.vulnerabilities ?? 0);
    const passed = Boolean(
      maintainability >= 10 &&
      passedTests === totalTests &&
      totalTests > 0 &&
      vulnerabilities === 0
    );
    const scanDuration = Number(payload.scanDuration ?? 0);

    return reply.status(200).send({
      maintainability,
      passedTests,
      totalTests,
      vulnerabilities,
      passed,
      scanDuration,
      details: {
        testFailures: (payload.testFailures as { name: string; message: string }[]) ?? [],
        complexFunctions:
          (payload.complexFunctions as
            | { name: string; line: number; cyclomaticComplexity: number }[]
            | undefined) ?? [],
        vulnerabilityDetails:
          (payload.vulnerabilityDetails as
            | { type: string; category: string; severity: string; message: string; line?: number }[]
            | undefined) ?? [],
      },
    });
  });

  server.get<{
    Params: { contractId: string };
  }>('/api/audits/:contractId/stream', { websocket: true, preHandler: contractPartyOnly.preHandler }, async (socket, request) => {
    const { contractId } = request.params;
    logger.info({ contractId }, 'Audit WebSocket stream opened');

    const topicsToWatch = [...Object.keys(AUDIT_STREAM_STEP_BY_TOPIC), EVENT_TOPICS.AUDIT_COMPLETED];

    // Same reasoning as the chat stream: a unique groupId per connection keeps
    // this fan-out tap from competing with ci-worker's real subscription to
    // the same topics.
    const wsConnectionId = randomUUID();

    // Subscribing sequentially (await in a loop) took ~3s per topic to join
    // its Kafka consumer group — ~18s for all 6, well after a fast pipeline
    // run has already finished and published everything. Subscribe to every
    // topic in parallel so the whole set is ready in ~3s, not 6x that.
    const unsubs: Array<() => Promise<void>> = await Promise.all(
      topicsToWatch.map((topic) =>
        eventBus.subscribe(
          topic,
          async (event: EventEnvelope) => {
            if (event.payload.contractId === contractId && socket.readyState === socket.OPEN) {
              const frame = auditStreamFrame(topic, contractId);
              if (frame) {
                socket.send(JSON.stringify(frame));
              }
            }
          },
          { groupId: `assurecode-ws-audit-${wsConnectionId}-${topic}` },
        ),
      ),
    );

    // Tells the client all consumer groups have joined and it's safe to
    // trigger the push — without this, a client that pushes as soon as the
    // socket opens can beat the subscriptions into existence and miss every
    // event a fast pipeline run publishes before they're ready.
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'ready' }));
    }

    socket.on('close', () => {
      logger.info({ contractId }, 'Audit WebSocket closed — cleaning up event bus subscriptions');
      for (const u of unsubs) void u();
    });
  });
}
