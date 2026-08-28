/**
 * @assurecode/api-gateway — TOTP-based MFA (V011's mfa_credentials, finally load-bearing).
 *
 * `mfa_credentials`/`users.mfa_enabled` existed since V011 with nothing ever
 * writing a real credential — `mfa_enabled` was a passthrough boolean nothing
 * set true. This is the enroll -> verify -> challenge lifecycle that makes it
 * real: enrolling stores an *inactive* secret (proves nothing yet), verifying
 * a live code activates it and flips `users.mfa_enabled`, and from then on
 * every login must pass a second TOTP check before a session is created.
 *
 * `mfa_credentials.secret_key` is `TEXT`, not `BYTEA` (V011's original
 * shape) — pgp_sym_encrypt returns bytea, so the ciphertext is base64-encoded
 * on the way in/out rather than widening the column, mirroring the encrypted
 * storage `auth_providers.access_token_encrypted` already uses, without a
 * migration.
 */
import { generateSecret, verify, generateURI } from 'otplib';
import type pg from 'pg';

export class MfaAlreadyEnabledError extends Error {}
export class MfaNotPendingError extends Error {}
export class MfaNotEnabledError extends Error {}

/** A fresh, unactivated secret. Proves nothing until verifyEnrollment succeeds. */
export async function startEnrollment(
  pool: pg.Pool,
  userId: string,
  email: string,
  encryptionKey: string,
): Promise<{ secret: string; otpauthUri: string }> {
  const { rows } = await pool.query(`SELECT mfa_enabled FROM users WHERE user_id = $1`, [userId]);
  if (rows[0]?.mfa_enabled) throw new MfaAlreadyEnabledError();

  const secret = generateSecret();
  const otpauthUri = generateURI({ issuer: 'AssureCode', label: email, secret });

  // One pending secret at a time — a second enroll call replaces the first
  // rather than accumulating unverified rows a caller could otherwise pick
  // between.
  await pool.query(`DELETE FROM mfa_credentials WHERE user_id = $1 AND is_active = false`, [userId]);
  await pool.query(
    `INSERT INTO mfa_credentials (user_id, mfa_type, secret_key, is_active)
     VALUES ($1, 'TOTP', encode(pgp_sym_encrypt($2, $3), 'base64'), false)`,
    [userId, secret, encryptionKey],
  );

  return { secret, otpauthUri };
}

/** Activates the pending secret on a correct code, and flips users.mfa_enabled. */
export async function verifyEnrollment(
  pool: pg.Pool,
  userId: string,
  code: string,
  encryptionKey: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT credential_id, pgp_sym_decrypt(decode(secret_key, 'base64'), $2) AS secret
       FROM mfa_credentials WHERE user_id = $1 AND is_active = false
       ORDER BY created_at DESC LIMIT 1`,
    [userId, encryptionKey],
  );
  if (rows.length === 0) throw new MfaNotPendingError();

  const { valid } = await verify({ secret: rows[0].secret, token: code });
  if (!valid) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE mfa_credentials SET is_active = true WHERE credential_id = $1`, [rows[0].credential_id]);
    await client.query(`UPDATE users SET mfa_enabled = true WHERE user_id = $1`, [userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return true;
}

/** Checks a code against the user's ACTIVE secret — the login-time and disable-time check. */
export async function verifyActiveCode(
  pool: pg.Pool,
  userId: string,
  code: string,
  encryptionKey: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT pgp_sym_decrypt(decode(secret_key, 'base64'), $2) AS secret
       FROM mfa_credentials WHERE user_id = $1 AND is_active = true
       ORDER BY created_at DESC LIMIT 1`,
    [userId, encryptionKey],
  );
  if (rows.length === 0) throw new MfaNotEnabledError();

  const { valid } = await verify({ secret: rows[0].secret, token: code });
  return valid;
}

/** Deactivates every credential and flips users.mfa_enabled off. Caller must have already verified a code. */
export async function disableMfa(pool: pg.Pool, userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE mfa_credentials SET is_active = false WHERE user_id = $1`, [userId]);
    await client.query(`UPDATE users SET mfa_enabled = false WHERE user_id = $1`, [userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
