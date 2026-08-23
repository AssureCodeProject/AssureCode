/**
 * Gateway routes that no other suite exercises.
 *
 * `gateway.test.ts` covers a handful of endpoints, the golden path covers the
 * contract lifecycle, and `razorpay-webhook` / `kyc-ownership` / `idempotency`
 * / `ledger-tamper` each cover their own concern. What was left over is a set
 * of routes with no test at all — probes, auth session endpoints, the PDF
 * upload, and the read side of audits and drift.
 *
 * They are grouped here rather than scattered because they share a property
 * worth pinning: each one has a *refusal* path that must not be confused with
 * an empty success. `/api/audits/:id/results` used to answer 200 with a body of
 * zeros when no audit had run, which reads as "maintainability 0, no
 * vulnerabilities" rather than "never measured" — the same class of mistake the
 * trust score and the readiness probe were both fixed for. These assert the
 * refusals, not just the happy paths.
 */
import { describe, it, expect } from 'vitest';
import server from '../src/server.js';
import { postgresAvailable, announceSkip, serviceAuthHeaders } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
const AUTH = serviceAuthHeaders();
if (!PG_UP) announceSkip('API Gateway — route coverage', 'a running PostgreSQL on DATABASE_URL');

describe('probes', () => {
  it('GET /healthz is unauthenticated and asserts only that the process serves', async () => {
    const res = await server.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  // Readiness must be a different question from liveness, or an orchestrator
  // keeps routing to a replica whose database is gone.
  it.skipIf(!PG_UP)('GET /readyz reports its dependencies individually', async () => {
    const res = await server.inject({ method: 'GET', url: '/readyz' });
    expect([200, 503]).toContain(res.statusCode);

    const body = res.json();
    expect(body).toHaveProperty('db');
    // Redis is probed at the TCP level only — the check must not issue
    // commands, because a readiness probe with side effects is a liability.
    expect(body).toHaveProperty('redis');
    // Named per dependency, not a single boolean: "not ready" that does not say
    // which dependency is down costs an operator the whole diagnosis.
    expect(['ok', 'error', 'not_configured']).toContain(body.redis);
  });

  it('GET /metrics is unauthenticated and exposes the assurecode_ prefix', async () => {
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('assurecode_');
  });
});

describe('auth session routes', () => {
  it('GET /auth/me rejects an unauthenticated caller', async () => {
    const res = await server.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  // A service token has no user identity. The route has to say so rather than
  // invent one, because everything downstream keys off `authenticated`.
  it('GET /auth/me reports a service caller as having no user', async () => {
    const res = await server.inject({ method: 'GET', url: '/auth/me', headers: AUTH });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.authenticated).toBe(false);
    expect(body.serviceCaller).toBe(true);
  });

  it('POST /auth/login refuses a wrong password without saying which field was wrong', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'client@acme.com', password: 'not-the-password' },
    });
    expect(res.statusCode).toBe(401);
    // The message must not distinguish "no such user" from "bad password" —
    // that difference is a user-enumeration oracle.
    expect(JSON.stringify(res.json()).toLowerCase()).not.toMatch(/no such user|user not found/);
  });

  it('POST /auth/logout succeeds for a caller with no session', async () => {
    const res = await server.inject({ method: 'POST', url: '/auth/logout', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });
});

describe('PDF requirements upload', () => {
  it('refuses a request carrying no file', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/pdf/extract',
      headers: { ...AUTH, 'content-type': 'multipart/form-data; boundary=----none' },
      payload: '------none--\r\n',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no file/i);
  });

  it('refuses a non-PDF and names the type it got', async () => {
    const boundary = '----assurecode-test';
    const body =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="notes.txt"\r\n' +
      'Content-Type: text/plain\r\n\r\n' +
      'these are not requirements\r\n' +
      `--${boundary}--\r\n`;

    const res = await server.inject({
      method: 'POST',
      url: '/api/pdf/extract',
      headers: { ...AUTH, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    // Naming the received type is what turns a rejection into a fixable one.
    expect(res.json().error).toContain('text/plain');
  });
});

describe.skipIf(!PG_UP)('read paths refuse rather than fabricate', () => {
  const missing = 'AC-DOES-NOT-EXIST';

  it('GET /api/audits/:id/results is 404 for an unknown contract', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/audits/${missing}/results`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('GET /api/contracts/:id/oracle is 404 for an unknown contract', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/contracts/${missing}/oracle`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/contracts/:id is 200 with an empty chain for an unknown contract', async () => {
    // The chain read is deliberately not a 404: an empty chain is a true
    // statement about a contract id, and the caller can tell it apart from a
    // populated one without a status code to interpret.
    const res = await server.inject({
      method: 'GET',
      url: `/api/contracts/${missing}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().chain).toEqual([]);
  });

  it('POST /api/contracts/:id/drift refuses a contract with no genesis hash', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/contracts/${missing}/drift`,
      headers: AUTH,
      payload: {},
    });

    // 409 is the anchoring refusal: with no ledger entry there is no H0 to
    // judge against, and the guard declines rather than degrading into a
    // free-floating similarity score. 502/503 if scope-guard is not running.
    // Never 200 — a drift number here would be an assessment of nothing.
    expect([409, 502, 503]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(200);
    if (res.statusCode === 409) {
      expect(res.json().error).toMatch(/genesis hash|no ledger entries/i);
    }
  });
});

describe('settlement input validation', () => {
  // The route published whatever body it was handed. An empty one reached the
  // worker as `freelancerId: undefined`, which the oracle approved and the
  // payment captured before the RFC 8785 canonicalizer refused to serialize it
  // — money taken, no ledger entry. These pin the guard that now runs first.
  it.each([
    ['an empty body', {}],
    ['a blank freelancerId', { freelancerId: '   ', amountCents: 1000 }],
    ['a missing amount', { freelancerId: 'FL-1' }],
    ['a zero amount', { freelancerId: 'FL-1', amountCents: 0 }],
    ['a fractional amount', { freelancerId: 'FL-1', amountCents: 10.5 }],
  ])('refuses %s with 400 before publishing anything', async (_label, payload) => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/AC-VALIDATION-TEST/settle',
      headers: AUTH,
      payload,
    });
    expect(res.statusCode).toBe(400);
  });
});
