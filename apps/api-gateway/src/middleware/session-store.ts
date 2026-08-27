/**
 * @assurecode/api-gateway — server-side session tracking.
 *
 * A JWT alone cannot be revoked: whoever holds it stays authenticated until
 * `exp` (or forever, if nothing sets `exp`). `user_sessions` (V011) existed
 * for exactly this but nothing wrote to it — this module is what makes it
 * load-bearing. Every JWT this service issues carries a `sid` claim that
 * names a row here; auth.ts's onRequest hook checks that row is still
 * active on every authenticated request, and POST /auth/logout revokes it
 * for real instead of only logging that a logout happened.
 */
import { randomUUID, createHash } from 'node:crypto';
import type pg from 'pg';

export interface CreateSessionArgs {
  userId: string;
  token: string;
  userAgent?: string;
  ipAddress?: string;
  ttlSeconds: number;
}

/** sha256 of the token, not the token itself — the row need not be a secret an operator has to protect as carefully as the bearer credential itself. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Create the session row for a freshly-signed JWT.
 *
 * The session id must be generated *before* the JWT is signed (it is one of
 * the token's own claims), so this only persists the row — callers own
 * minting the id and putting it in the token.
 */
export async function createSession(
  pool: pg.Pool,
  sessionId: string,
  args: CreateSessionArgs,
): Promise<void> {
  await pool.query(
    `INSERT INTO user_sessions (session_id, user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval)`,
    [sessionId, args.userId, hashToken(args.token), args.userAgent ?? null, args.ipAddress ?? null, args.ttlSeconds],
  );
}

export function newSessionId(): string {
  return randomUUID();
}

/**
 * A session is active iff its row exists, has not been revoked, and has not
 * expired. Checked on every authenticated request — see auth.ts.
 *
 * Fails closed: a DB error here must not read as "session is fine".
 */
export async function isSessionActive(pool: pg.Pool, sessionId: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM user_sessions
      WHERE session_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [sessionId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** POST /auth/logout's real effect. Idempotent: revoking twice is a no-op, not an error. */
export async function revokeSession(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE user_sessions SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
}
