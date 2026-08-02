import { describe, it, expect } from 'vitest';
import server from '../src/server.js';

describe('API Gateway New Endpoints', () => {
  it('GET /healthz returns ok status', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/healthz',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

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
