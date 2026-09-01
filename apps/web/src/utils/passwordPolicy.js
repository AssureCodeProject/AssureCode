/**
 * UX-only mirror of @assurecode/shared's validateNewPassword/isCommonPassword.
 *
 * The frontend has no workspace dependency on @assurecode/shared today, so
 * this is a small, hand-kept-in-sync duplicate rather than a shared import —
 * intentional: the backend (apps/api-gateway/src/routes/auth.ts, via
 * @assurecode/shared) is the authoritative validator. This file exists only
 * to give the user an inline message before a round trip, never as the
 * actual security control.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

// A short subset of the backend's ~180-entry list — enough to catch the
// most obvious cases in the UI; the full list stays server-side only.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'letmein123', 'welcome123', 'admin1234', 'iloveyou1', 'sunshine1',
  'football1', 'baseball1', 'monkey123', 'dragon123', 'master123', 'trustno1',
  'passw0rd', 'passw0rd1', 'abc123456', 'abcd1234', '1qaz2wsx', 'demo1234',
]);

export function isCommonPassword(password) {
  return COMMON_PASSWORDS.has(password.trim().toLowerCase());
}

/** Same rule order as the backend: empty -> too short -> too long ->
 *  whitespace -> invalid characters -> common. Returns the first violated
 *  message, or null if the password looks fine. */
export function validateNewPassword(password) {
  if (!password) return 'Password is required.';
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must not exceed ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (/\s/.test(password)) {
    return 'Password cannot contain spaces or whitespace.';
  }
  if (!/^[\x21-\x7E]+$/.test(password)) {
    return 'Password contains invalid characters. Use only English letters, numbers, and special characters.';
  }
  if (isCommonPassword(password)) {
    return 'This password is too common. Please choose a different password.';
  }
  return null;
}

/** Cheap UX-only format check — the backend's `validator.isEmail()` is
 *  authoritative. Deliberately permissive (require an @ and a dot after it)
 *  rather than a strict RFC 5322 regex, which tends to reject valid
 *  addresses more often than it catches typos. */
export function isLikelyValidEmail(email) {
  const trimmed = email.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

export function validateEmail(email) {
  if (!email || !email.trim()) return 'Email address is required.';
  if (!isLikelyValidEmail(email)) return 'Please enter a valid email address.';
  return null;
}

export const PASSWORD_HELPER_TEXT =
  'Password must be 8–128 characters long and can contain English letters, numbers, and special characters. Spaces are not allowed.';
