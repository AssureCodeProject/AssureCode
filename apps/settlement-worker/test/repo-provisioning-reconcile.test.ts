/**
 * The repo-provisioning leg: attemptProvisioning and
 * reconcileStuckProvisioning.
 *
 * Mirrors score-reconcile.test.ts's shape for the same reason: this is the
 * real state machine attemptProvisioning walks (create repo -> add outside
 * collaborator -> attach webhook -> flip contract ACTIVE), and the suite is
 * the regression guard for its idempotency/retry behaviour, not a re-typed
 * copy of the SQL.
 *
 * GitHub's API is stubbed via vi.stubGlobal('fetch', ...), matching the
 * convention already established in apps/api-gateway/test/github-oauth.test.ts
 * — github-provisioner-client.ts calls the global `fetch`, not an injected
 * one, when the worker doesn't pass a fetchImpl.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { loadDotEnv } from '../../../tools/test-support/env.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';
import { buildDbConfig, getDatabaseUrl, loadConfig } from '@assurecode/config';

loadDotEnv();

const available = await postgresAvailable();
if (!available) announceSkip('repo provisioning reconciliation', 'PostgreSQL (DATABASE_URL)');

const TEST_ORG = 'test-assurecode-org';
process.env.GITHUB_ORG = TEST_ORG;
process.env.GITHUB_TOKEN = 'test-org-token';

describe.skipIf(!available)('repo provisioning reconciliation', () => {
  let pool: pg.Pool;
  let worker: typeof import('../src/worker.js');

  /** Per-test controls for the stubbed GitHub API. */
  let createRepoCalls: string[] = [];
  let collaboratorMode: 'invited' | 'already' | 'unknown-login' = 'invited';
  let webhookShouldFail = false;

  beforeAll(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';

        if (method === 'POST' && url === `https://api.github.com/orgs/${TEST_ORG}/repos`) {
          createRepoCalls.push(url);
          const body = JSON.parse(String(init!.body));
          return new Response(
            JSON.stringify({ id: 42, full_name: `${TEST_ORG}/${body.name}`, html_url: `https://github.com/${TEST_ORG}/${body.name}` }),
            { status: 201 },
          );
        }

        if (method === 'PUT' && url.includes('/collaborators/')) {
          if (collaboratorMode === 'unknown-login') return new Response('', { status: 404 });
          if (collaboratorMode === 'already') return new Response('', { status: 204 });
          return new Response('', { status: 201 });
        }

        if (method === 'POST' && url.endsWith('/hooks')) {
          if (webhookShouldFail) return new Response('server error', { status: 500 });
          return new Response(JSON.stringify({ id: 99 }), { status: 201 });
        }

        return new Response('{}', { status: 404 });
      }),
    );

    worker = await import('../src/worker.js');
    await worker.start();

    pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await pool?.end();
    if (worker.metricsServer) {
      await new Promise<void>((resolve) => worker.metricsServer!.close(() => resolve()));
    }
  });

  async function seedContractAndFreelancer(
    contractId: string,
    freelancerId: string,
    githubLogin: string,
    options: { title?: string; displayName?: string } = {},
  ): Promise<void> {
    const displayName = options.displayName ?? freelancerId;
    await pool.query(
      `INSERT INTO users (user_id, email, password_hash, role, display_name)
       VALUES ($1, $1 || '@example.com', 'unusable-no-login', 'freelancer', $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [freelancerId, displayName],
    );
    await pool.query(
      `INSERT INTO auth_providers (user_id, provider_type, provider_user_id, github_login, token_valid)
       VALUES ($1, 'GITHUB', $1, $2, TRUE)
       ON CONFLICT (provider_type, provider_user_id) DO UPDATE SET github_login = EXCLUDED.github_login, token_valid = TRUE`,
      [freelancerId, githubLogin],
    );
    await pool.query(
      `INSERT INTO contracts (contract_id, client_id, freelancer_id, title, requirements, budget_cents, deadline, status)
       VALUES ($1, 'legacy-client', $2, $3, 'n/a', 100000, '2026-12-31', 'LOCKED')
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId, freelancerId, options.title ?? 'repo provisioning test'],
    );
  }

  async function cleanup(contractId: string, freelancerId: string): Promise<void> {
    await pool.query(`DELETE FROM repo_provisioning WHERE contract_id = $1`, [contractId]);
    await pool.query(`DELETE FROM contracts WHERE contract_id = $1`, [contractId]);
    await pool.query(`DELETE FROM auth_providers WHERE user_id = $1`, [freelancerId]);
    await pool.query(`DELETE FROM users WHERE user_id = $1`, [freelancerId]);
  }

  it('attemptProvisioning walks repo -> collaborator -> webhook -> contract ACTIVE', async () => {
    const contractId = `AC-PROVISION-${Date.now()}`;
    const freelancerId = `freelancer-provision-${Date.now()}`;
    await seedContractAndFreelancer(contractId, freelancerId, 'octocat');
    collaboratorMode = 'invited';
    webhookShouldFail = false;

    await worker.attemptProvisioning(contractId, freelancerId, 'octocat');

    const row = await pool.query(`SELECT * FROM repo_provisioning WHERE contract_id = $1`, [contractId]);
    expect(row.rows[0].status).toBe('COMPLETE');
    expect(row.rows[0].collaborator_status).toBe('INVITED');
    expect(row.rows[0].webhook_status).toBe('ATTACHED');
    // "repo provisioning test" slugified, plus a slugified freelancer
    // component (the display name here is just freelancerId, no spaces --
    // see insertProvisioningRow's firstName split), plus a running sequence
    // number. Not asserting the exact freelancer segment, since it gets
    // truncated to slugifyComponent's 20-char cap.
    expect(row.rows[0].repo_name).toMatch(/^repo-provisioning-test-.+-\d{2}$/);
    expect(row.rows[0].repo_full_name).toBe(`${TEST_ORG}/${row.rows[0].repo_name}`);

    const contractRow = await pool.query(`SELECT status, github_repo_full_name FROM contracts WHERE contract_id = $1`, [contractId]);
    expect(contractRow.rows[0].status).toBe('ACTIVE');
    expect(contractRow.rows[0].github_repo_full_name).toBe(row.rows[0].repo_full_name);

    await cleanup(contractId, freelancerId);
  });

  it('a retry after a mid-pipeline failure resumes without recreating the repo', async () => {
    const contractId = `AC-PROVISION-RETRY-${Date.now()}`;
    const freelancerId = `freelancer-retry-${Date.now()}`;
    await seedContractAndFreelancer(contractId, freelancerId, 'octocat');
    createRepoCalls = [];

    // First attempt: repo succeeds, webhook fails.
    collaboratorMode = 'invited';
    webhookShouldFail = true;
    await worker.attemptProvisioning(contractId, freelancerId, 'octocat').catch(() => undefined);

    let row = await pool.query(`SELECT * FROM repo_provisioning WHERE contract_id = $1`, [contractId]);
    expect(row.rows[0].status).toBe('COLLABORATOR_ADDED');
    expect(createRepoCalls.length).toBe(1);

    // Second attempt: webhook now succeeds. Repo must not be recreated.
    webhookShouldFail = false;
    await worker.attemptProvisioning(contractId, freelancerId, 'octocat');

    row = await pool.query(`SELECT * FROM repo_provisioning WHERE contract_id = $1`, [contractId]);
    expect(row.rows[0].status).toBe('COMPLETE');
    expect(createRepoCalls.length).toBe(1);

    await cleanup(contractId, freelancerId);
  });

  it('reconcileStuckProvisioning marks a row FAILED once it exceeds the attempt cap', async () => {
    const contractId = `AC-PROVISION-CAP-${Date.now()}`;
    const freelancerId = `freelancer-cap-${Date.now()}`;
    await seedContractAndFreelancer(contractId, freelancerId, 'octocat');
    await pool.query(
      `INSERT INTO repo_provisioning (contract_id, github_org, repo_name, freelancer_user_id, freelancer_github_login, attempts)
       VALUES ($1, $2, $3, $4, 'octocat', $5)`,
      [contractId, TEST_ORG, `assurecode-contract-${contractId.toLowerCase()}`, freelancerId, worker.PROVISIONING_MAX_ATTEMPTS],
    );

    await worker.reconcileStuckProvisioning();

    const row = await pool.query(`SELECT status FROM repo_provisioning WHERE contract_id = $1`, [contractId]);
    expect(row.rows[0].status).toBe('FAILED');

    await cleanup(contractId, freelancerId);
  });

  it('an unknown collaborator login flags the freelancer for reconnection instead of retrying forever', async () => {
    const contractId = `AC-PROVISION-UNKNOWN-${Date.now()}`;
    const freelancerId = `freelancer-unknown-${Date.now()}`;
    await seedContractAndFreelancer(contractId, freelancerId, 'a-renamed-account');
    collaboratorMode = 'unknown-login';

    await worker.attemptProvisioning(contractId, freelancerId, 'a-renamed-account');

    const row = await pool.query(`SELECT collaborator_status, last_error FROM repo_provisioning WHERE contract_id = $1`, [contractId]);
    expect(row.rows[0].collaborator_status).toBe('FAILED');
    expect(row.rows[0].last_error).toBe('unknown-login');

    const identityRow = await pool.query(`SELECT token_valid FROM auth_providers WHERE user_id = $1`, [freelancerId]);
    expect(identityRow.rows[0].token_valid).toBe(false);

    collaboratorMode = 'invited';
    await cleanup(contractId, freelancerId);
  });

  it('two contracts with the same title and freelancer first name get sequential -01/-02 repo names', async () => {
    const suffix = Date.now();
    // Keep the title short enough that slugifyComponent's 40-char cap
    // doesn't truncate part of the uniqueness suffix out of the name this
    // test asserts on exactly.
    const shortSuffix = String(suffix).slice(-6);
    const title = `Fintech Dashboard ${shortSuffix}`;
    const contractId1 = `AC-SEQ-A-${suffix}`;
    const contractId2 = `AC-SEQ-B-${suffix}`;
    const freelancerId1 = `freelancer-seq-a-${suffix}`;
    const freelancerId2 = `freelancer-seq-b-${suffix}`;
    // Both freelancers share a first name ("Priya") so the two repos land in
    // the same title+name numbering bucket -- the point of this test.
    await seedContractAndFreelancer(contractId1, freelancerId1, 'octocat', { title, displayName: 'Priya Sharma' });
    await seedContractAndFreelancer(contractId2, freelancerId2, 'octocat', { title, displayName: 'Priya Patel' });

    await worker.attemptProvisioning(contractId1, freelancerId1, 'octocat');
    await worker.attemptProvisioning(contractId2, freelancerId2, 'octocat');

    const row1 = await pool.query(`SELECT repo_name FROM repo_provisioning WHERE contract_id = $1`, [contractId1]);
    const row2 = await pool.query(`SELECT repo_name FROM repo_provisioning WHERE contract_id = $1`, [contractId2]);

    const expectedBase = `Fintech-Dashboard-${shortSuffix}-Priya`;
    expect(row1.rows[0].repo_name).toBe(`${expectedBase}-01`);
    expect(row2.rows[0].repo_name).toBe(`${expectedBase}-02`);

    await cleanup(contractId1, freelancerId1);
    await cleanup(contractId2, freelancerId2);
  });
});
