/**
 * @assurecode/api-gateway — Enterprise RBAC & Security Middleware.
 *
 * Provides Role-Based Access Control (RBAC), KYC verification enforcement,
 * and automated security audit logging.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';

export interface AuthUser {
  userId: string;
  email: string;
  role: 'client' | 'freelancer' | 'auditor' | 'admin';
  kycStatus: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
  mfaEnabled: boolean;
}

/**
 * Machine callers (benchmark harnesses, verify scripts) authenticate with
 * SERVICE_TOKEN and have no user identity — auth.ts sets `request.user` to
 * undefined and flags them instead.
 *
 * Both guards below must let them through. Without this they would answer 401
 * "authentication required" to a caller that *is* authenticated, just not as a
 * person, and every tools/ script would start failing the moment the guards
 * were attached.
 */
function isServiceCaller(request: FastifyRequest): boolean {
  return (request as any).isServiceCaller === true;
}

/** Check if the authenticated user has one of the allowed roles. */
export function requireRole(allowedRoles: Array<'client' | 'freelancer' | 'auditor' | 'admin'>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (isServiceCaller(request)) return;

    const user = (request as any).user as AuthUser | undefined;

    if (!user) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication token required for this resource',
      });
    }

    if (!allowedRoles.includes(user.role)) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: `Role '${user.role}' is not authorized. Allowed roles: ${allowedRoles.join(', ')}`,
      });
    }
  };
}

/**
 * Enforce KYC verification compliance for high-value operations.
 *
 * The status is read from the database rather than from the JWT claim. A token
 * is a snapshot taken at login: a user who completes KYC mid-session still
 * carries `kycStatus: 'UNVERIFIED'` in their token until they log in again, so
 * a claim-based check would refuse the very users who had just verified — and,
 * worse, would keep honouring 'VERIFIED' for a user whose status was revoked
 * for as long as their token lived. The token says who you are; the database
 * says what you are currently allowed to do.
 */
export function requireKycVerified(pool: Pool) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (isServiceCaller(request)) return;

    const user = (request as any).user as AuthUser | undefined;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }

    let kycStatus: string;
    try {
      const res = await pool.query(`SELECT kyc_status FROM users WHERE user_id = $1`, [user.userId]);
      if (res.rowCount === 0) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'The account this token was issued for no longer exists.',
        });
      }
      kycStatus = res.rows[0].kyc_status;
    } catch (err) {
      // An unreadable compliance status is not a verified one. Failing closed
      // is the only safe direction for a gate on moving money.
      request.log?.error?.({ err, userId: user.userId }, 'KYC status lookup failed');
      return reply.status(503).send({
        error: 'KYC_CHECK_UNAVAILABLE',
        message: 'Could not confirm identity verification status; refusing to proceed.',
      });
    }

    if (kycStatus !== 'VERIFIED') {
      return reply.status(403).send({
        error: 'KYC_REQUIRED',
        message: 'Identity verification (KYC) required before performing this operation.',
        kycStatus,
      });
    }
  };
}

/** Record security audit event into security_audit_logs. */
export async function logSecurityAudit(
  dbPool: Pool,
  params: {
    userId?: string;
    action: string;
    resource: string;
    ipAddress?: string;
    status?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  },
): Promise<void> {
  try {
    await dbPool.query(
      `INSERT INTO security_audit_logs (user_id, action, resource, ip_address, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [params.userId || null, params.action, params.resource, params.ipAddress || null, params.status || 'SUCCESS'],
    );
  } catch (err) {
    console.error('[security-audit] Failed to log security audit event:', err);
  }
}
