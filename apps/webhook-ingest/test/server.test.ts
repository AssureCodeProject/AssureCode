import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifyGitHubSignature, fastify } from '../src/server.js';

describe('webhook-ingest', () => {
  const secret = 'test_secret';

  it('verifies valid GitHub HMAC SHA256 signature', () => {
    const payload = JSON.stringify({ ref: 'refs/heads/main' });
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const isValid = verifyGitHubSignature(payload, `sha256=${hmac}`, secret);
    expect(isValid).toBe(true);
  });

  it('rejects invalid GitHub HMAC SHA256 signature', () => {
    const payload = JSON.stringify({ ref: 'refs/heads/main' });
    const isValid = verifyGitHubSignature(payload, 'sha256=invalid', secret);
    expect(isValid).toBe(false);
  });

  it('returns 401 on /webhooks/github when signature is invalid', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-hub-signature-256': 'sha256=invalid',
      },
      payload: { contract_id: 'c1' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 202 on /webhooks/github when signature is valid', async () => {
    const body = { contract_id: 'c1', after: 'abc1234' };
    const rawBody = Buffer.from(JSON.stringify(body));
    // Derive the secret the same way the server does, rather than hardcoding
    // its fallback. The literal 'assurecode_github_secret' only matched while
    // GITHUB_WEBHOOK_SECRET happened to be unset, so the test began failing the
    // moment the services started reading .env — for a signature that was
    // correct, against a server that was working.
    const secretUnderTest = process.env.GITHUB_WEBHOOK_SECRET || 'assurecode_github_secret';
    const hmac = crypto.createHmac('sha256', secretUnderTest).update(rawBody).digest('hex');

    const response = await fastify.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${hmac}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(202);
    const result = JSON.parse(response.body);
    expect(result.status).toBe('accepted');
  });
});
