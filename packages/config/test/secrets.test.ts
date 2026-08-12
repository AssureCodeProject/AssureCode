import { describe, it, expect, vi } from 'vitest';
import {
  isPlaceholderSecret,
  findInsecureSecrets,
  assertProductionSecrets,
} from '../src/secrets.js';

describe('isPlaceholderSecret', () => {
  it('treats absent and blank values as placeholders', () => {
    expect(isPlaceholderSecret(undefined)).toBe(true);
    expect(isPlaceholderSecret(null)).toBe(true);
    expect(isPlaceholderSecret('')).toBe(true);
    // A Secret key set to whitespace is an easy YAML accident and
    // authenticates nobody, so it must not read as configured.
    expect(isPlaceholderSecret('   ')).toBe(true);
  });

  it('rejects the dev defaults that ship in the schema', () => {
    expect(isPlaceholderSecret('dev_insecure_jwt_secret_change_me')).toBe(true);
    expect(isPlaceholderSecret('dev_insecure_service_token_change_me')).toBe(true);
    expect(isPlaceholderSecret('assurecode_github_secret')).toBe(true);
  });

  it('rejects the REPLACE_ME the tracked k8s manifest ships', () => {
    expect(isPlaceholderSecret('REPLACE_ME')).toBe(true);
    // Surrounding whitespace should not smuggle it past the check.
    expect(isPlaceholderSecret('  REPLACE_ME  ')).toBe(true);
  });

  it('accepts a real secret', () => {
    expect(isPlaceholderSecret('S0kFn2mQ9xLpVz7wA1cE4rT6yU8iO0pB')).toBe(false);
  });
});

describe('findInsecureSecrets', () => {
  it('returns only the offending key names, never their values', () => {
    const result = findInsecureSecrets(
      {
        JWT_SECRET: 'REPLACE_ME',
        SERVICE_TOKEN: 'a-real-token',
        GITHUB_WEBHOOK_SECRET: undefined,
      },
      ['JWT_SECRET', 'SERVICE_TOKEN', 'GITHUB_WEBHOOK_SECRET'],
    );

    expect(result).toEqual(['JWT_SECRET', 'GITHUB_WEBHOOK_SECRET']);
    // The point of returning names is that the caller can log the result.
    expect(result.join()).not.toContain('a-real-token');
  });

  it('returns empty when every required secret is real', () => {
    expect(
      findInsecureSecrets({ JWT_SECRET: 'real', SERVICE_TOKEN: 'also-real' }, [
        'JWT_SECRET',
        'SERVICE_TOKEN',
      ]),
    ).toEqual([]);
  });

  it('ignores keys that were not asked about', () => {
    expect(
      findInsecureSecrets({ JWT_SECRET: 'real', UNRELATED: 'REPLACE_ME' }, ['JWT_SECRET']),
    ).toEqual([]);
  });
});

describe('assertProductionSecrets', () => {
  it('does nothing outside production, so dev defaults stay runnable', () => {
    const onFail = vi.fn();
    const onError = vi.fn();

    for (const nodeEnv of ['development', 'test', undefined]) {
      assertProductionSecrets({ NODE_ENV: nodeEnv, JWT_SECRET: 'REPLACE_ME' }, ['JWT_SECRET'], {
        onFail,
        onError,
      });
    }

    expect(onFail).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('fails in production on a placeholder, naming the key', () => {
    const onFail = vi.fn();
    const onError = vi.fn();

    assertProductionSecrets(
      { NODE_ENV: 'production', JWT_SECRET: 'REPLACE_ME', SERVICE_TOKEN: 'real' },
      ['JWT_SECRET', 'SERVICE_TOKEN'],
      { onFail, onError },
    );

    expect(onFail).toHaveBeenCalledWith(['JWT_SECRET']);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toContain('JWT_SECRET');
  });

  it('passes in production when every secret is real', () => {
    const onFail = vi.fn();

    assertProductionSecrets(
      { NODE_ENV: 'production', JWT_SECRET: 'real-one', SERVICE_TOKEN: 'real-two' },
      ['JWT_SECRET', 'SERVICE_TOKEN'],
      { onFail },
    );

    expect(onFail).not.toHaveBeenCalled();
  });

  it('honours an explicit nodeEnv over the one in the source', () => {
    const onFail = vi.fn();

    assertProductionSecrets({ NODE_ENV: 'development', JWT_SECRET: 'REPLACE_ME' }, ['JWT_SECRET'], {
      nodeEnv: 'production',
      onFail,
      onError: () => {},
    });

    expect(onFail).toHaveBeenCalledWith(['JWT_SECRET']);
  });
});
