import { describe, it, expect } from 'vitest';
import server from '../src/server.js';
import { postgresAvailable, announceSkip, serviceAuthHeaders } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
const AUTH = serviceAuthHeaders();
if (!PG_UP) announceSkip('API Gateway — DB-backed lookups', 'a running PostgreSQL on DATABASE_URL');

describe('API Gateway New Endpoints', () => {
  it('GET /healthz returns ok status', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/healthz',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  describe.skipIf(!PG_UP)('with a live database', () => {
    it('GET /api/contracts/:contractId/verify returns 404 for missing contract', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/contracts/AC-NONEXISTENT/verify',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Contract not found' });
    });

    it('POST /root/sign refuses a contract with no sealed root', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/contracts/AC-NONEXISTENT/root/sign',
        headers: AUTH,
      });
      // 409, not 500 and not a signature over nothing.
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/No Merkle root recorded/);
    });

    it('GET /root distinguishes a missing contract from an unsealed one', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/contracts/AC-NONEXISTENT/root',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
      // The UI renders these differently — "no contract selected" is not the
      // same statement as "this contract has not settled yet".
      expect(res.json().reason).toBe('no-contract');
    });

    // settlement-worker calls this route on every AUDIT_COMPLETED to make the
    // gateway publish XAI_SCORED. Until that trigger existed the only caller
    // was a React effect, so nothing pinned that a machine caller is admitted
    // here — and a regression would stall the settlement pipeline silently.
    it('GET /api/contracts/:contractId/score admits a service-token caller', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/contracts/AC-NONEXISTENT/score',
        headers: AUTH,
      });
      // 404 means the request reached the handler and failed on the contract,
      // not on the credential.
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Contract not found' });
    });
  });

  it('GET /api/contracts/:contractId/score rejects an unauthenticated caller', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/contracts/AC-NONEXISTENT/score',
    });
    expect(res.statusCode).toBe(401);
  });

  // Signing is an assertion by the platform about its own ledger. No user
  // session should be able to mint one, so the route is service-callers-only
  // on top of the global auth hook.
  it('POST /root/sign rejects an unauthenticated caller', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/contracts/AC-NONEXISTENT/root/sign',
    });
    expect(res.statusCode).toBe(401);
  });

  describe.skipIf(PG_UP)('with the database unreachable', () => {
    // The distinction the gateway must not collapse: an unreachable database is
    // not evidence that a record is absent. This assertion used to live on
    // GET /api/jobs/:jobId, which no longer exists — the jobs table was dropped
    // in V016 because nothing ever advanced a row out of 'queued'. It moves
    // here because /root has the same hazard and a worse consequence: a 404
    // read as "no root" renders in the footer as an unsigned ledger, which is a
    // claim about the ledger we have not earned.
    it('GET /root reports 503, not a fabricated 404', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/contracts/AC-NONEXISTENT/root',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().reason).toBe('unavailable');
    });
  });
});
