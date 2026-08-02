import pg from 'pg';
import { createHash } from 'node:crypto';

/**
 * Empirical Verification Harness for Sprint 6 Remediation
 */
export function calculateSha256Node(payload: Record<string, unknown>, previousHash: string): string {
  const serialized = JSON.stringify(payload) + previousHash;
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

export function testSettlementGuardLogic(
  dbResult: { rowCount: number } | undefined
): { allowed: boolean; reason: string } {
  if (!dbResult || dbResult.rowCount !== 1) {
    return {
      allowed: false,
      reason: 'Settlement request rejected: Failed to acquire DB lock or settlement already in progress',
    };
  }
  return { allowed: true, reason: 'Lock acquired' };
}
