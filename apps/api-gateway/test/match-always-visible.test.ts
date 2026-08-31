/**
 * POST /api/contracts/:contractId/match — always-visible GitHub-connected
 * freelancers.
 *
 * ai-service is not running in this test environment (only Postgres is
 * required, per postgresAvailable() below), so /match deterministically
 * takes its degraded trust-score-ranked fallback path
 * (apps/api-gateway/src/routes/contracts-lifecycle.ts) rather than needing
 * a mocked ai-service response — this suite is about the merge step applied
 * to that path's output (withAlwaysVisibleFreelancers), not the ranking
 * itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import server from '../src/server.js';
import { postgresAvailable, announceSkip, serviceAuthHeaders } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
const AUTH = serviceAuthHeaders();
if (!PG_UP) announceSkip('API Gateway — always-visible matchmaker freelancers', 'a running PostgreSQL on DATABASE_URL');

describe.skipIf(!PG_UP)('POST /api/contracts/:contractId/match — always-visible GitHub-connected freelancers', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  const contractId = `AC-MATCH-VISIBLE-${Date.now()}`;
  const connectedId = `freelancer-connected-${Date.now()}`;
  const staleId = `freelancer-stale-${Date.now()}`;
  const noProfileId = `freelancer-noprofile-${Date.now()}`;

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO contracts (contract_id, client_id, title, requirements, budget_cents, deadline, status)
       VALUES ($1, 'legacy-client', 'match visibility test', 'n/a', 100000, '2026-12-31', 'DRAFT')
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId],
    );

    for (const id of [connectedId, staleId]) {
      await pool.query(
        `INSERT INTO users (user_id, email, password_hash, role, display_name)
         VALUES ($1, $1 || '@example.com', 'unusable-no-login', 'freelancer', $1)
         ON CONFLICT (user_id) DO NOTHING`,
        [id],
      );
      // No real ai-service embedder in this test env -- a zero vector still
      // satisfies the NOT NULL column, and this suite doesn't assert on
      // ranking order, only on presence/absence in the merged results.
      await pool.query(
        `INSERT INTO freelancer_profiles (freelancer_id, skills, profile_text, profile_embedding)
         VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (freelancer_id) DO NOTHING`,
        [id, ['cobol'], `${id} (unrelated skills)`, `[${new Array(384).fill(0).join(',')}]`],
      );
    }

    await pool.query(
      `INSERT INTO auth_providers (user_id, provider_type, provider_user_id, github_login, token_valid)
       VALUES ($1, 'GITHUB', $1, $1, TRUE)
       ON CONFLICT (provider_type, provider_user_id) DO NOTHING`,
      [connectedId],
    );
    // Stale connection: token_valid=FALSE, e.g. after a provisioning attempt
    // 404'd on a renamed GitHub login (see settlement-worker's
    // attemptProvisioning) -- must NOT be treated as "connected."
    await pool.query(
      `INSERT INTO auth_providers (user_id, provider_type, provider_user_id, github_login, token_valid)
       VALUES ($1, 'GITHUB', $1, $1, FALSE)
       ON CONFLICT (provider_type, provider_user_id) DO NOTHING`,
      [staleId],
    );

    // The exact real-world gap this fix closes: a genuinely GitHub-connected
    // freelancer whose freelancer_profiles row never got created (the
    // best-effort ai-service /embed call at connect time failed or timed
    // out -- see ensureFreelancerProfile in auth.ts). No freelancer_profiles
    // row exists for this user at all -- must still be visible.
    await pool.query(
      `INSERT INTO users (user_id, email, password_hash, role, display_name)
       VALUES ($1, $1 || '@example.com', 'unusable-no-login', 'freelancer', $1)
       ON CONFLICT (user_id) DO NOTHING`,
      [noProfileId],
    );
    await pool.query(
      `INSERT INTO auth_providers (user_id, provider_type, provider_user_id, github_login, token_valid)
       VALUES ($1, 'GITHUB', $1, $1, TRUE)
       ON CONFLICT (provider_type, provider_user_id) DO NOTHING`,
      [noProfileId],
    );
  });

  afterAll(async () => {
    for (const id of [connectedId, staleId, noProfileId]) {
      await pool.query(`DELETE FROM auth_providers WHERE user_id = $1`, [id]);
      await pool.query(`DELETE FROM freelancer_profiles WHERE freelancer_id = $1`, [id]);
      await pool.query(`DELETE FROM users WHERE user_id = $1`, [id]);
    }
    await pool.query(`DELETE FROM contracts WHERE contract_id = $1`, [contractId]);
    await pool.end();
  });

  it('includes a GitHub-connected freelancer even with completely unrelated skills', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/match`,
      headers: AUTH,
      payload: { requirements: 'Solidity smart contract audit for a DeFi protocol', topK: 2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids: string[] = body.results.map((r: any) => r.freelancer_id);
    expect(ids).toContain(connectedId);
    expect(body.count).toBe(body.results.length);
  });

  it('includes a GitHub-connected freelancer that has no freelancer_profiles row at all', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/match`,
      headers: AUTH,
      payload: { requirements: 'Solidity smart contract audit for a DeFi protocol', topK: 2 },
    });
    expect(res.statusCode).toBe(200);
    const ids: string[] = res.json().results.map((r: any) => r.freelancer_id);
    expect(ids).toContain(noProfileId);
  });

  it('excludes a freelancer whose GitHub connection has gone stale (token_valid=false)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/match`,
      headers: AUTH,
      payload: { requirements: 'Solidity smart contract audit for a DeFi protocol', topK: 2 },
    });
    const ids: string[] = res.json().results.map((r: any) => r.freelancer_id);
    expect(ids).not.toContain(staleId);
  });

  it('an always-visible freelancer is honestly marked as an unmeasured skill match, not a fabricated one', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/contracts/${contractId}/match`,
      headers: AUTH,
      payload: { requirements: 'Solidity smart contract audit for a DeFi protocol', topK: 2 },
    });
    const match = res.json().results.find((r: any) => r.freelancer_id === connectedId);
    expect(match.explanation.skill_score).toBe(0);
    expect(match.explanation.matched_skills).toEqual([]);
  });
});
