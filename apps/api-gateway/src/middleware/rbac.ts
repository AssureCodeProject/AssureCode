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

/** Check if the authenticated user has one of the allowed roles. */
export function requireRole(allowedRoles: Array<'client' | 'freelancer' | 'auditor' | 'admin'>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
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

/** Enforce KYC verification compliance for high-value operations. */
export function requireKycVerified() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user as AuthUser | undefined;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }

    if (user.kycStatus !== 'VERIFIED') {
      return reply.status(403).send({
        error: 'KYC_REQUIRED',
        message: 'Identity verification (KYC) required before performing this operation.',
        kycStatus: user.kycStatus,
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
