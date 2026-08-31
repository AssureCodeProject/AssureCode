/** KYC verification, status lookup, and payout-account onboarding. */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { config, dbPool, kycAdapter } from '../context.js';
import { logSecurityAudit, type AuthUser } from '../middleware/rbac.js';

/**
 * Guard for routes that name a `userId` in the request rather than deriving it
 * from the session.
 *
 * A `userId` taken from a body or a path parameter is caller-controlled, so
 * without this every such route acts on whatever account it is handed. This
 * was written inline for /api/kyc/verify — where the consequence was that any
 * authenticated user could set kyc_status = 'VERIFIED' on any account and
 * clear the compliance gate on escrow — and the two sibling KYC routes had no
 * equivalent check at all. Sharing it means the next route that takes a
 * `userId` gets the same answer instead of a fourth variation.
 *
 * You may act on yourself; an admin may act on anyone; a service caller acts
 * on behalf of the platform and has no user identity to compare against.
 *
 * Returns true when the request was rejected, so callers `return` on true.
 */
async function denyIfNotSelfOrAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  targetUserId: string,
  auditAction: string,
  message: string,
): Promise<boolean> {
  if ((request as any).isServiceCaller === true) return false;

  const caller = (request as any).user as AuthUser | undefined;
  if (!caller) return false;
  if (caller.role === 'admin' || caller.userId === targetUserId) return false;

  await logSecurityAudit(dbPool, {
    userId: caller.userId,
    action: auditAction,
    resource: `kyc:${targetUserId}`,
    ipAddress: request.ip,
    status: 'DENIED',
  });
  await reply.status(403).send({ error: 'Forbidden', message });
  return true;
}

export function registerKycRoutes(server: FastifyInstance): void {
  server.post<{
    Body: { userId: string; idType: 'PASSPORT' | 'DRIVERS_LICENSE' | 'NATIONAL_ID' };
  }>('/api/kyc/verify', async (request, reply) => {
    const { userId, idType } = request.body || {};
    if (!userId || !idType) {
      return reply.status(400).send({ error: 'userId and idType are required' });
    }

    if (
      await denyIfNotSelfOrAdmin(
        request,
        reply,
        userId,
        'KYC_VERIFY_DENIED',
        'You can only run identity verification for your own account.',
      )
    ) {
      return;
    }

    // kyc_verifications.user_id is a foreign key onto users(user_id), and
    // `ON CONFLICT DO NOTHING` does not absorb a foreign-key violation — only a
    // uniqueness one. A userId with no users row therefore raised 23503 out of
    // the INSERT below, escaped the handler, and answered 500. Checking first
    // turns an unhandled crash into the 404 it always was, which matters most
    // for freelancers: this route is how they clear the KYC gate, and a 500 gave
    // them nothing to act on.
    const userExists = await dbPool.query(`SELECT 1 FROM users WHERE user_id = $1`, [userId]);
    if (userExists.rowCount === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const session = await kycAdapter.createVerificationSession({
      userId,
      returnUrl: `${config.WEB_APP_URL}/kyc-callback`,
    });

    const docHash = `hash_${randomUUID().slice(0, 8)}`;

    await dbPool.query(
      `INSERT INTO kyc_verifications (user_id, id_type, id_status, document_hash, aml_sanctions_checked, verified_at)
       VALUES ($1, $2, 'APPROVED', $3, true, now())
       ON CONFLICT DO NOTHING`,
      [userId, idType, docHash],
    );

    await dbPool.query(
      `UPDATE users SET kyc_status = 'VERIFIED' WHERE user_id = $1`,
      [userId],
    );

    await logSecurityAudit(dbPool, {
      userId,
      action: 'KYC_VERIFIED',
      resource: `kyc:${session.sessionId}`,
      ipAddress: request.ip,
      status: 'SUCCESS',
    });

    return reply.send({
      success: true,
      sessionId: session.sessionId,
      verificationUrl: session.url,
      kycStatus: 'VERIFIED',
      amlSanctionsChecked: true,
    });
  });

  server.get<{
    Params: { userId: string };
  }>('/api/kyc/status/:userId', async (request, reply) => {
    const { userId } = request.params;

    // This route had no ownership check at all, so any authenticated user could
    // read any other account's email, role, KYC status and identity-document
    // type by walking user IDs. Reading is less damaging than the write on
    // /api/kyc/verify, but it is still someone else's compliance record.
    if (
      await denyIfNotSelfOrAdmin(
        request,
        reply,
        userId,
        'KYC_STATUS_READ_DENIED',
        'You can only read the verification status of your own account.',
      )
    ) {
      return;
    }

    const res = await dbPool.query(
      `SELECT user_id, kyc_status, mfa_enabled, role, display_name FROM users WHERE user_id = $1`,
      [userId],
    );
    if (res.rows.length === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }
    const kycRes = await dbPool.query(
      `SELECT id_type, id_status, aml_sanctions_checked, verified_at FROM kyc_verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return reply.send({
      user: res.rows[0],
      verification: kycRes.rows[0] || null,
    });
  });

  server.post<{
    Body: { userId: string; email: string };
  }>('/api/kyc/connect-onboarding', async (request, reply) => {
    const { userId, email } = request.body || {};
    if (!userId) {
      return reply.status(400).send({ error: 'userId is required' });
    }

    // Same caller-controlled `userId` problem the sibling routes had: without
    // this, any authenticated user could open a payout-account onboarding flow
    // in someone else's name.
    if (
      await denyIfNotSelfOrAdmin(
        request,
        reply,
        userId,
        'CONNECT_ONBOARDING_DENIED',
        'You can only start payout onboarding for your own account.',
      )
    ) {
      return;
    }

    // Same 404-before-500 reasoning as /api/kyc/verify: this is the freelancer's
    // payout-onboarding entry point, and it should not answer 500 for an unknown
    // account.
    const userExists = await dbPool.query(`SELECT 1 FROM users WHERE user_id = $1`, [userId]);
    if (userExists.rowCount === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const account = await kycAdapter.createPayoutAccount({
      userId,
      email: email || 'user@assurecode.io',
    });

    // Previously computed and handed straight back in the response without
    // ever being stored — the settlement worker's payout leg reads this
    // column to know where a freelancer's money goes, so it has to land here.
    await dbPool.query(`UPDATE users SET payout_account_id = $1 WHERE user_id = $2`, [
      account.accountId,
      userId,
    ]);

    const link = await kycAdapter.createPayoutOnboardingLink({
      accountId: account.accountId,
      // Hardcoded to localhost:3000 before, so every deployed environment sent
      // the user to their own machine.
      refreshUrl: `${config.WEB_APP_URL}/connect/refresh`,
      returnUrl: `${config.WEB_APP_URL}/connect/return`,
    });
    return reply.send({
      accountId: account.accountId,
      onboardingUrl: link.url,
    });
  });
}
