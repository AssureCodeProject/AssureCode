import { describe, it, expect, vi } from 'vitest';
import server from '../src/server.js';
import pg from 'pg';
import { loadConfig, getDatabaseUrl } from '@assurecode/config';

describe('Sprint 6.1 — Idempotency Concurrency & Race Condition Challenge', () => {
  it('empirically challenges 5 concurrent requests with exact same idempotency key', async () => {
    const key = `test-concurrent-key-${Date.now()}`;
    const contractId = `AC-CONCURRENCY-${Date.now()}`;
    const payload = {
      title: 'Concurrent Lock Test Contract',
      requirements: 'Testing 5 concurrent lock requests with same key',
      budgetCents: 100000,
      deadline: '2026-12-31',
    };

    // Prepare 5 concurrent HTTP requests with exact same x-idempotency-key
    const concurrentRequests = Array.from({ length: 5 }, () =>
      server.inject({
        method: 'POST',
        url: `/api/contracts/${contractId}/lock`,
        headers: {
          'content-type': 'application/json',
          'x-idempotency-key': key,
        },
        payload,
      })
    );

    // Fire all 5 requests simultaneously
    const responses = await Promise.all(concurrentRequests);

    // All callers expect 200 OK
    const statusCodes = responses.map((r) => r.statusCode);
    const bodies = responses.map((r) => r.json());

    console.log('[CONCURRENCY TEST] Status codes:', statusCodes);
    console.log('[CONCURRENCY TEST] Returned bodies:', bodies);

    // Verify if all returned bodies are identical
    const firstBodyJson = JSON.stringify(bodies[0]);
    const allBodiesIdentical = bodies.every(
      (b) => JSON.stringify(b) === firstBodyJson
    );

    // Check DB for number of ledger entries created for this contractId
    const config = loadConfig();
    const databaseUrl = getDatabaseUrl(config);
    const pool = new pg.Pool({ connectionString: databaseUrl });

    let ledgerEntriesCount = 0;
    try {
      const res = await pool.query(
        "SELECT COUNT(*) FROM merkle_ledger WHERE contract_id = $1 AND action_type = 'CONTRACT_LOCKED'",
        [contractId]
      );
      ledgerEntriesCount = parseInt(res.rows[0].count, 10);
    } catch {
      // In offline unit test mode without live postgres pool
      ledgerEntriesCount = 5; // Default expected count under current non-atomic middleware
    } finally {
      await pool.end().catch(() => {});
    }

    console.log(
      `[CONCURRENCY TEST] Total CONTRACT_LOCKED ledger entries created in DB: ${ledgerEntriesCount}`
    );

    // Empirical Assertion for Sprint 6.1 Requirements:
    // 1 unique database ledger entry must be created
    // ALL 5 callers must receive identical cached HTTP response payload
    expect(allBodiesIdentical).toBe(true);
    expect(ledgerEntriesCount).toBe(1);
  });
});
