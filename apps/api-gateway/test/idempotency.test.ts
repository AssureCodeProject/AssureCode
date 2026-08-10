import { describe, it, expect } from 'vitest';
import server from '../src/server.js';
import { IdempotencyKeyHeaderSchema } from '@assurecode/shared';
import { postgresAvailable, announceSkip, serviceAuthHeaders } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
const AUTH = serviceAuthHeaders();
if (!PG_UP) announceSkip('Sprint 6.1 — Idempotency Keys End-to-End', 'a running PostgreSQL on DATABASE_URL');

describe.skipIf(!PG_UP)('Sprint 6.1 — Idempotency Keys End-to-End', () => {
  it('validates IdempotencyKeyHeaderSchema correctly', () => {
    const validHeader1 = IdempotencyKeyHeaderSchema.parse({ 'idempotency-key': 'key-12345' });
    expect(validHeader1['idempotency-key']).toBe('key-12345');

    const validHeader2 = IdempotencyKeyHeaderSchema.parse({ 'x-idempotency-key': 'key-67890' });
    expect(validHeader2['x-idempotency-key']).toBe('key-67890');
  });

  it('replays response and status code when Idempotency-Key header is provided', async () => {
    const key = `test-idempotency-${Date.now()}`;
    const payload = {
      title: 'Idempotent Contract',
      requirements: 'Requirements for idempotency test',
      budgetCents: 50000,
      deadline: '2026-12-31',
    };

    // First request
    const res1 = await server.inject({
      method: 'POST',
      url: '/api/contracts/initialize',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        ...AUTH,
      },
      payload,
    });

    expect(res1.statusCode).toBe(201);
    const data1 = res1.json();
    expect(data1.contractId).toBeDefined();

    // Second request with same idempotency key
    const res2 = await server.inject({
      method: 'POST',
      url: '/api/contracts/initialize',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        ...AUTH,
      },
      payload,
    });

    expect(res2.statusCode).toBe(201);
    const data2 = res2.json();

    // Cached response MUST yield exact identical contractId
    expect(data2.contractId).toBe(data1.contractId);
    expect(data2.clientId).toBe(data1.clientId);
  });

  it('supports x-idempotency-key header replay', async () => {
    const key = `test-x-idempotency-${Date.now()}`;
    const payload = {
      title: 'X-Idempotent Contract',
      requirements: 'Requirements for x-idempotency test',
      budgetCents: 75000,
      deadline: '2026-12-31',
    };

    const res1 = await server.inject({
      method: 'POST',
      url: '/api/contracts/initialize',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': key,
        ...AUTH,
      },
      payload,
    });

    expect(res1.statusCode).toBe(201);
    const data1 = res1.json();

    const res2 = await server.inject({
      method: 'POST',
      url: '/api/contracts/initialize',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': key,
        ...AUTH,
      },
      payload,
    });

    expect(res2.statusCode).toBe(201);
    const data2 = res2.json();
    expect(data2.contractId).toBe(data1.contractId);
  });
});
