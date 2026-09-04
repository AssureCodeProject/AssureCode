/**
 * Chat & Scope Guard Interceptors (Tasks 3.2 & 3.4).
 *
 * Requires `@fastify/websocket` to already be registered on `server` — done
 * once in server.ts's composition root, before any route module that
 * declares a `{ websocket: true }` route is registered.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { EVENT_TOPICS, type EventEnvelope } from '@assurecode/shared';
import { logger, eventBus, scopeGuardUrl, serviceCallHeaders, contractPartyOnly } from '../context.js';
import { type AuthUser } from '../middleware/rbac.js';

export function registerContractsChatRoutes(server: FastifyInstance): void {
  server.post<{
    Params: { contractId: string };
    Body: { message: string };
    Reply:
    | { delivered: boolean; message: string; sender: string }
    | { delivered: false; blocked: boolean; reason: string; mediation: string }
    | { error: string };
  }>('/api/contracts/:contractId/chat', contractPartyOnly, async (request, reply) => {
    const { contractId } = request.params;
    const { message } = request.body || {};

    if (!message) {
      return reply.status(400).send({ error: 'Message is required' });
    }

    // Identity claimed by the caller's own token, never by the request body.
    // The old `sender` field came straight from the client, so any caller
    // could post a message and label it as coming from whichever side of the
    // contract it wasn't — a spoofable identity on the one thing (scope
    // adherence history) this record exists to make trustworthy. A service
    // caller has no user object (see requireContractParty's bypass) and is
    // labeled as such rather than defaulting to a human role it isn't.
    const sender = ((request as any).user as AuthUser | undefined)?.role ?? 'service';

    // No permissive fallback. This used to deliver the message when the guard was
    // unreachable *and* when it answered with any non-2xx — logging "allowing with
    // default check", which is not a check. Two things went wrong at once: an
    // out-of-scope request got through whenever the guard was down, and because
    // the guard is what writes scope_checks, the trust score's adherence term was
    // computed over a history that silently omitted those messages. An
    // unavailable guard is an unavailable guard; say so.
    let checkResult: {
      allowed: boolean;
      similarity_score: number;
      reason: string;
      suggested_mediation?: string;
    };

    try {
      const scopeRes = await fetch(`${scopeGuardUrl}/scope/check`, {
        method: 'POST',
        headers: serviceCallHeaders(),
        body: JSON.stringify({ contract_id: contractId, message, sender }),
        signal: AbortSignal.timeout(5000),
      });

      if (!scopeRes.ok) {
        const detail = await scopeRes.text().catch(() => '');
        logger.warn({ contractId, status: scopeRes.status, detail }, 'Scope Guard declined to check');
        // 409 means the guard has no indexed contract to compare against — a
        // caller-fixable state, so it is propagated rather than flattened to 503.
        return reply.status(scopeRes.status === 409 ? 409 : 503).send({
          error:
            `Message not delivered: the scope guard returned ${scopeRes.status} and the request ` +
            `was therefore never checked. ${detail}`,
        });
      }

      checkResult = (await scopeRes.json()) as typeof checkResult;
    } catch (err) {
      logger.error({ contractId, err }, 'Scope Guard unreachable');
      return reply.status(503).send({
        error:
          'Message not delivered: the scope guard is unreachable, so this request could not be ' +
          'checked against the contract.',
      });
    }

    if (!checkResult.allowed) {
      logger.warn({ contractId, reason: checkResult.reason }, 'Scope Guard intercepted off-scope message');

      const rejectionId = randomUUID();
      await eventBus.publish(
        EVENT_TOPICS.SCOPE_CHECKED,
        {
          contractId,
          message,
          allowed: false,
          reason: checkResult.reason,
          mediation: checkResult.suggested_mediation,
        },
        rejectionId,
      );

      return reply.status(403).send({
        delivered: false,
        blocked: true,
        reason: checkResult.reason,
        mediation: checkResult.suggested_mediation || 'Off-scope change request blocked by automated Scope Guard.',
      });
    }

    const correlationId = randomUUID();
    await eventBus.publish(
      EVENT_TOPICS.SCOPE_CHECKED,
      { contractId, message, allowed: true, sender },
      correlationId,
    );

    return reply.status(200).send({
      delivered: true,
      message,
      sender,
    });
  });

  server.get<{
    Params: { contractId: string };
  }>('/api/contracts/:contractId/chat/stream', { websocket: true, preHandler: contractPartyOnly.preHandler }, async (socket, request) => {
    const { contractId } = request.params;
    logger.info({ contractId }, 'Chat WebSocket stream opened');

    // BUG-010: Store and call the unsubscribe function when the socket closes to prevent
    // handler accumulation and sending to already-closed sockets.
    //
    // groupId is unique per connection: this is an ephemeral fan-out tap, not
    // a durable worker. Subscribing under the shared `assurecode-${topic}`
    // default would make it a competing consumer against any real worker on
    // this topic, and the two would fight over partition ownership instead of
    // both receiving every message.
    const unsubscribe = await eventBus.subscribe(
      EVENT_TOPICS.SCOPE_CHECKED,
      async (event: EventEnvelope) => {
        if (event.payload.contractId === contractId) {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify(event.payload));
          }
        }
      },
      { groupId: `assurecode-ws-chat-${randomUUID()}` },
    );

    socket.on('close', () => {
      logger.info({ contractId }, 'Chat WebSocket closed — cleaning up event bus subscription');
      void unsubscribe();
    });
  });
}
