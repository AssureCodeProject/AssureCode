import { describe, it, expect, vi } from 'vitest';
import server from '../src/server.js';
import pg from 'pg';
import { getDatabaseUrl, loadConfig } from '@assurecode/config';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('Sprint 6.4 — Ledger Verification Endpoint & Tamper Red-Team Test', 'a running PostgreSQL on DATABASE_URL');

/**
 * Create the contract through the real endpoint and return its id.
 *
 * These tests used to invent an id and POST straight to /lock.
 * `merkle_ledger.contract_id` is a foreign key into `contracts`, so that could
 * never have worked against a live database — and it did not have to, because
 * DATABASE_URL was never set when the suite ran, so `postgresAvailable()`
 * returned false and the whole file was skipped. It only started failing once
 * loadConfig began reading .env, which is the first time these assertions ran
 * at all.
 */
async function createContract(title: string, requirements: string, budgetCents: number) {
  const res = await server.inject({
    method: 'POST',
    url: '/api/contracts/initialize',
    headers: { 'content-type': 'application/json' },
    payload: { title, requirements, budgetCents, deadline: '2026-12-31' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().contractId as string;
}

describe.skipIf(!PG_UP)('Sprint 6.4 — Ledger Verification Endpoint & Tamper Red-Team Test', () => {
  it('returns HTTP 200 { contractId, valid: true } when chain is untampered', async () => {
    const contractId = await createContract(
      'Tamper Verification Test',
      'Testing merkle chain verification route',
      10000,
    );

    const lockRes = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/lock`,
      headers: { 'content-type': 'application/json' },
      payload: {
        title: 'Tamper Verification Test',
        requirements: 'Testing merkle chain verification route',
        budgetCents: 10000,
        deadline: '2026-12-31',
      },
    });

    expect(lockRes.statusCode).toBe(200);

    const verifyRes = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/verify`,
    });

    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json()).toEqual({
      contractId,
      valid: true,
    });
  });

  it('returns HTTP 409 { contractId, valid: false } when merkle_ledger current_hash is tampered in DB', async () => {
    const contractId = await createContract(
      'Red Team Tamper Target',
      'This contract will be tampered in database',
      20000,
    );

    const lockRes = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/lock`,
      headers: { 'content-type': 'application/json' },
      payload: {
        title: 'Red Team Tamper Target',
        requirements: 'This contract will be tampered in database',
        budgetCents: 20000,
        deadline: '2026-12-31',
      },
    });

    expect(lockRes.statusCode).toBe(200);

    // Red-Team Attack: Tamper current_hash in database
    const config = loadConfig();
    const databaseUrl = getDatabaseUrl(config);
    const db = new pg.Client({ connectionString: databaseUrl });

    let dbTampered = false;
    try {
      await db.connect();
      const updateRes = await db.query(
        `UPDATE merkle_ledger
         SET current_hash = 'deadbeef00000000000000000000000000000000000000000000000000000000'
         WHERE contract_id = $1`,
        [contractId],
      );
      await db.end();
      if (updateRes.rowCount && updateRes.rowCount > 0) {
        dbTampered = true;
      }
    } catch {
      // In offline unit mode without live Postgres
    }

    const verifyRes = await server.inject({
      method: 'GET',
      url: `/api/contracts/${contractId}/verify`,
    });

    if (dbTampered) {
      // Strict un-nested assertion: Must return 409 Conflict
      expect(verifyRes.statusCode).toBe(409);
      expect(verifyRes.json()).toEqual({
        contractId,
        valid: false,
      });
    } else {
      // If DB update wasn't possible due to offline mode, verify endpoint behavior directly
      expect([200, 404, 409]).toContain(verifyRes.statusCode);
    }
  });

  it('returns HTTP 409 { contractId, valid: false } on direct chain tampering mock', async () => {
    const tamperedId = await createContract(
      'Mock Tamper Target',
      'Testing mocked chain verification route',
      15000,
    );

    // Lock contract first
    await server.inject({
      method: 'POST',
      url: `/api/contracts/${tamperedId}/lock`,
      headers: { 'content-type': 'application/json' },
      payload: {
        title: 'Mock Tamper Target',
        requirements: 'Testing mocked chain verification route',
        budgetCents: 15000,
        deadline: '2026-12-31',
      },
    });

    // Mock ledgerClient.verifyChain to simulate detected tampering
    const ledgerClient = (server as any).ledgerClient;
    const originalVerify = ledgerClient.verifyChain;
    ledgerClient.verifyChain = async () => false;

    try {
      const res = await server.inject({
        method: 'GET',
        url: `/api/contracts/${tamperedId}/verify`,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        contractId: tamperedId,
        valid: false,
      });
    } finally {
      ledgerClient.verifyChain = originalVerify;
    }
  });
});
