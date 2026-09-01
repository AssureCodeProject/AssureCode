/**
 * A user's own persisted notifications (see V024's `notifications` table).
 * The only writer today is apps/settlement-worker/src/worker.ts, reacting to
 * ASSIGNMENT_ACCEPTED/ASSIGNMENT_REJECTED/REPOSITORY_PROVISIONED — this file
 * is read/mark-read only. Scoped to `request.user.userId` throughout: there
 * is no notion of one user reading another's notifications, so unlike the
 * contract routes there is no separate ownership check to write — the WHERE
 * clause on every query already is the ownership check.
 */
import type { FastifyInstance } from 'fastify';
import { type AuthUser } from '../middleware/rbac.js';
import { dbPool } from '../context.js';

export function registerNotificationsRoutes(server: FastifyInstance): void {
  server.get('/api/notifications', async (request, reply) => {
    const user = (request as any).user as AuthUser | undefined;
    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }

    const unreadOnly = (request.query as { unread?: string })?.unread === 'true';
    const result = await dbPool.query(
      `SELECT notification_id, contract_id, type, message, read_at, created_at
         FROM notifications
        WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''}
        ORDER BY created_at DESC
        LIMIT 50`,
      [user.userId],
    );

    return reply.send({
      notifications: result.rows.map((row) => ({
        notificationId: row.notification_id,
        contractId: row.contract_id,
        type: row.type,
        message: row.message,
        readAt: row.read_at,
        createdAt: row.created_at,
      })),
    });
  });

  server.patch<{ Params: { notificationId: string } }>(
    '/api/notifications/:notificationId/read',
    async (request, reply) => {
      const user = (request as any).user as AuthUser | undefined;
      if (!user) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required' });
      }

      const result = await dbPool.query(
        `UPDATE notifications SET read_at = NOW()
          WHERE notification_id = $1 AND user_id = $2 AND read_at IS NULL
        RETURNING notification_id`,
        [request.params.notificationId, user.userId],
      );
      // Not found and already-read both report the same 200 — a mark-read
      // retry (double click, network retry) is not an error, it's a no-op.
      return reply.send({ notificationId: request.params.notificationId, read: true, updated: (result.rowCount ?? 0) > 0 });
    },
  );
}
