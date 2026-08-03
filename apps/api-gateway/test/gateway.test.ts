import { describe, it, expect } from 'vitest';
import server from '../src/server.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
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
    it('GET /api/jobs/:jobId returns 404 for unknown job', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/jobs/00000000-0000-0000-0000-000000000000',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Job not found' });
    });

    it('GET /api/contracts/:contractId/verify returns 404 for missing contract', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/contracts/AC-NONEXISTENT/verify',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Contract not found' });
    });
  });

  describe.skipIf(PG_UP)('with the database unreachable', () => {
    // These assert the distinction the gateway previously collapsed: an
    // unreachable database is not evidence that a record is absent. The job
    // route used to answer 404 from its catch block, so this suite passed with
    // no database at all while proving nothing about lookup behaviour.
    it('GET /api/jobs/:jobId reports 503, not a fabricated 404', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/jobs/00000000-0000-0000-0000-000000000000',
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'Job lookup unavailable' });
    });
  });
});
