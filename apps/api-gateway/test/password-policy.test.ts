/**
 * Pure unit tests for @assurecode/shared's validateNewPassword/
 * isCommonPassword — no server, no database. This is the actual security
 * control (routes/auth.ts calls this same function); the frontend's
 * apps/web/src/utils/passwordPolicy.js mirror is UX-only and not exercised
 * here.
 */
import { describe, it, expect } from 'vitest';
import { validateNewPassword, isCommonPassword, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '@assurecode/shared';

describe('validateNewPassword', () => {
  it('rejects an empty password', () => {
    expect(validateNewPassword('')).toBe('Password is required.');
  });

  it('rejects a password shorter than the minimum', () => {
    expect(validateNewPassword('a1!')).toBe(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`);
  });

  it('accepts a password at exactly the minimum length', () => {
    expect(validateNewPassword('Ab3#Ab3#')).toBeNull();
  });

  it('rejects a password over the maximum length', () => {
    const tooLong = 'A1!'.repeat(50); // 150 chars, well past 128
    expect(validateNewPassword(tooLong)).toBe(`Password must not exceed ${PASSWORD_MAX_LENGTH} characters.`);
  });

  it('accepts a password at exactly the maximum length', () => {
    const atMax = 'Aa1!'.repeat(32); // 128 chars exactly
    expect(atMax.length).toBe(PASSWORD_MAX_LENGTH);
    expect(validateNewPassword(atMax)).toBeNull();
  });

  it('rejects a password containing a plain space', () => {
    expect(validateNewPassword('My Password123!')).toBe('Password cannot contain spaces or whitespace.');
  });

  it('rejects a password containing a tab', () => {
    expect(validateNewPassword('Test\t1234!')).toBe('Password cannot contain spaces or whitespace.');
  });

  it('rejects a password containing a newline', () => {
    expect(validateNewPassword('Test\n1234!')).toBe('Password cannot contain spaces or whitespace.');
  });

  it('rejects a password containing non-ASCII/Unicode characters', () => {
    expect(validateNewPassword('पासवर्ड123!')).toBe(
      'Password contains invalid characters. Use only English letters, numbers, and special characters.',
    );
  });

  it('accepts a valid password using letters, digits, and ASCII special characters', () => {
    expect(validateNewPassword('AssureCode123!')).toBeNull();
    expect(validateNewPassword('A#B$C%123')).toBeNull();
    expect(validateNewPassword('abc12345')).toBeNull();
  });

  it('rejects a well-known common password even if it satisfies length/charset rules', () => {
    expect(validateNewPassword('password123')).toBe('This password is too common. Please choose a different password.');
  });

  it('rejects common passwords case-insensitively', () => {
    expect(validateNewPassword('Qwerty123')).toBe('This password is too common. Please choose a different password.');
  });

  it('message ordering: a password violating multiple rules reports the first one only', () => {
    // Too short AND contains whitespace -- must report the length message,
    // not the whitespace one, since length is checked first.
    expect(validateNewPassword('a b')).toBe(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`);
  });
});

describe('isCommonPassword', () => {
  it('is case-insensitive and trims surrounding whitespace before comparing', () => {
    expect(isCommonPassword('Password123')).toBe(true);
    expect(isCommonPassword('  password123  ')).toBe(true);
  });

  it('does not flag a genuinely uncommon password', () => {
    expect(isCommonPassword('Xk9#mQ2$vLp7')).toBe(false);
  });
});
