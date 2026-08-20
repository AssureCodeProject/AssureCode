/**
 * PATCH /api/contracts/:contractId/github-repo
 *
 * This route is what makes a real GitHub push auditable at all: a delivery
 * names a repository and nothing that identifies a contract, so webhook-ingest
 * resolves it against the column this route writes. The assertions below are
 * therefore on the stored row, not just on the status code — a 200 over an
 * UPDATE that matched nothing is the exact failure mode that would leave a
 * client believing their repository was wired up.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import server from '../src/server.js';
import { postgresAvailable, announceSkip, serviceAuthHeaders } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
const AUTH = serviceAuthHeaders();
if (!PG_UP) announceSkip('API Gateway — GitHub repo linking', 'a running PostgreSQL on DATABASE_URL');

describe.skipIf(!PG_UP)('PATCH /api/contracts/:contractId/github-repo', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  const contractId = `AC-REPOLINK-${Date.now()}`;

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO contracts (contract_id, client_id, title, requirements, budget_cents, deadline, status)
       VALUES ($1, 'legacy-client', 'repo link test', 'n/a', 250000, '2026-12-31', 'LOCKED')
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM merkle_ledger WHERE contract_id = $1`, [contractId]);
    await pool.query(`DELETE FROM contracts WHERE contract_id = $1`, [contractId]);
    await pool.end();
  });

  it('writes github_repo_full_name to the contract row', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/contracts/${contractId}/github-repo`,
      headers: AUTH,
      payload: { githubRepoFullName: 'acme/widget-api' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().githubRepoFullName).toBe('acme/widget-api');

    const { rows } = await pool.query(
      `SELECT github_repo_full_name FROM contracts WHERE contract_id = $1`,
      [contractId],
    );
    expect(rows[0].github_repo_full_name).toBe('acme/widget-api');
  });

  it('re-points a contract at a different repository', async () => {
    // The reason this is its own route rather than a field on /assign: the
    // repository can be corrected without re-assigning the freelancer.
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/contracts/${contractId}/github-repo`,
      headers: AUTH,
      payload: { githubRepoFullName: 'acme/widget-api-v2' },
    });

    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query(
      `SELECT github_repo_full_name FROM contracts WHERE contract_id = $1`,
      [contractId],
    );
    expect(rows[0].github_repo_full_name).toBe('acme/widget-api-v2');
  });

  it('rejects a clone URL rather than storing something that can never match', async () => {
    // A URL stored here would simply never equal a delivery's
    // repository.full_name, and the mistake would surface much later as a
    // push that appears to belong to no contract.
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/contracts/${contractId}/github-repo`,
      headers: AUTH,
      payload: { githubRepoFullName: 'https://github.com/acme/widget-api.git' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a bare repository name with no owner', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/contracts/${contractId}/github-repo`,
      headers: AUTH,
      payload: { githubRepoFullName: 'widget-api' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a missing body field', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/contracts/${contractId}/github-repo`,
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a contract that does not exist', async () => {
    // An UPDATE matching no rows is not an error to Postgres, so without the
    // rowCount check this would report success for a typo'd contract id.
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/contracts/AC-DOES-NOT-EXIST/github-repo',
      headers: AUTH,
      payload: { githubRepoFullName: 'acme/ghost' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/contracts/${contractId}/github-repo`,
      payload: { githubRepoFullName: 'acme/widget-api' },
    });
    expect(res.statusCode).toBe(401);
  });
});
