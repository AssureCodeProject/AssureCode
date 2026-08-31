/**
 * GET /auth/github, GET /auth/github/callback, POST /auth/github/exchange,
 * GET /api/github/repos.
 *
 * GITHUB_CLIENT_ID must be set before src/server.ts is imported — the routes
 * are only registered when it is present (an unconfigured deployment keeps
 * running password-only login untouched). That is why the import below is
 * dynamic, after the env vars are set, rather than a static top-of-file
 * import like the other route test files use.
 *
 * GitHub's own endpoints (token exchange, /user) and ai-service's /embed are
 * mocked — hitting the real GitHub API from CI is neither possible (no
 * network) nor desirable (it would need a real OAuth app and a real user to
 * click through). Postgres is real: this suite skips, rather than mocks it
 * away, when DATABASE_URL is unreachable.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('API Gateway — GitHub OAuth', 'a running PostgreSQL on DATABASE_URL');

const TEST_CLIENT_ID = 'test_github_client_id';
const TEST_TOKEN_KEY = 'test_github_token_encryption_key';
process.env.GITHUB_CLIENT_ID = TEST_CLIENT_ID;
process.env.GITHUB_CLIENT_SECRET = 'test_github_client_secret';
process.env.GITHUB_TOKEN_ENCRYPTION_KEY = TEST_TOKEN_KEY;
process.env.WEB_APP_URL = process.env.WEB_APP_URL || 'http://localhost:3000';

const { default: server } = await import('../src/server.js');

const GITHUB_USER_ID = `${999900000 + Math.floor(Math.random() * 90000)}`;
const GITHUB_LOGIN = `octocat-test-${GITHUB_USER_ID}`;
const GITHUB_EMAIL = `${GITHUB_LOGIN}@example.com`;
const GITHUB_ACCESS_TOKEN = `gho_test_token_${GITHUB_USER_ID}`;

function mockFetch(url: string) {
  if (url === 'https://github.com/login/oauth/access_token') {
    return Promise.resolve(
      new Response(
        JSON.stringify({ access_token: GITHUB_ACCESS_TOKEN, scope: 'read:user,user:email,public_repo', token_type: 'bearer' }),
        { status: 200 },
      ),
    );
  }
  if (url === 'https://api.github.com/user') {
    return Promise.resolve(
      new Response(
        JSON.stringify({ id: Number(GITHUB_USER_ID), login: GITHUB_LOGIN, name: 'Octocat Test', email: GITHUB_EMAIL }),
        { status: 200 },
      ),
    );
  }
  if (url === 'https://api.github.com/user/repos?per_page=100&sort=pushed') {
    return Promise.resolve(
      new Response(
        JSON.stringify([{ name: 'widget-api', full_name: `${GITHUB_LOGIN}/widget-api`, private: false }]),
        { status: 200 },
      ),
    );
  }
  if (url.includes('/embed')) {
    return Promise.resolve(
      new Response(JSON.stringify({ vector: new Array(384).fill(0.01), dim: 384 }), { status: 200 }),
    );
  }
  return Promise.resolve(new Response(JSON.stringify({}), { status: 404 }));
}

describe.skipIf(!PG_UP)('GitHub OAuth', () => {
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(loadConfig())));
  let createdUserId: string | null = null;
  let exchangeCode: string | null = null;
  let sessionToken: string | null = null;

  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn(mockFetch));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (createdUserId) {
      await pool.query(`DELETE FROM freelancer_profiles WHERE freelancer_id = $1`, [createdUserId]);
      await pool.query(`DELETE FROM auth_providers WHERE user_id = $1`, [createdUserId]);
      await pool.query(`DELETE FROM security_audit_logs WHERE user_id = $1`, [createdUserId]);
      await pool.query(`DELETE FROM users WHERE user_id = $1`, [createdUserId]);
    }
    await pool.end();
  });

  it('GET /auth/github redirects to GitHub with client_id and a signed state, unauthenticated', async () => {
    const res = await server.inject({ method: 'GET', url: '/auth/github' });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe(TEST_CLIENT_ID);
    expect(location.searchParams.get('state')).toBeTruthy();
    // No 'public_repo': repos are org-provisioned by AssureCode's own
    // credential now (settlement-worker's github-provisioner-client), so
    // this connection only needs enough to identify who the freelancer is.
    expect(location.searchParams.get('scope')).toBe('read:user user:email');
  });

  it('GET /auth/github/callback rejects a tampered state', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/auth/github/callback?code=whatever&state=not.a.validstate',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${loadConfig().WEB_APP_URL}/?error=github_oauth_failed`);
  });

  it('completes the OAuth round trip: creates the user, encrypts the token, and mints a redeemable exchange code', async () => {
    const authRes = await server.inject({ method: 'GET', url: '/auth/github' });
    const state = new URL(authRes.headers.location as string).searchParams.get('state')!;

    const callbackRes = await server.inject({
      method: 'GET',
      url: `/auth/github/callback?code=fake_github_code&state=${encodeURIComponent(state)}`,
    });
    expect(callbackRes.statusCode).toBe(302);

    const redirectUrl = new URL(callbackRes.headers.location as string);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(`${loadConfig().WEB_APP_URL}/auth/github/callback`);
    exchangeCode = redirectUrl.searchParams.get('code');
    expect(exchangeCode).toBeTruthy();

    const userRow = await pool.query(`SELECT user_id, role, password_hash FROM users WHERE email = $1`, [GITHUB_EMAIL]);
    expect(userRow.rowCount).toBe(1);
    expect(userRow.rows[0].role).toBe('freelancer');
    expect(userRow.rows[0].password_hash).toBe('unusable-no-login');
    createdUserId = userRow.rows[0].user_id;

    const providerRow = await pool.query(
      `SELECT pgp_sym_decrypt(access_token_encrypted, $2) AS token, github_login, token_valid
         FROM auth_providers WHERE user_id = $1 AND provider_type = 'GITHUB'`,
      [createdUserId, TEST_TOKEN_KEY],
    );
    expect(providerRow.rowCount).toBe(1);
    expect(providerRow.rows[0].token).toBe(GITHUB_ACCESS_TOKEN);
    // Needed to invite this freelancer as an outside collaborator on their
    // assigned contract's provisioned repo (GitHub's collaborator-invite
    // endpoint takes a login, not the numeric id already stored above).
    expect(providerRow.rows[0].github_login).toBe(GITHUB_LOGIN);
    expect(providerRow.rows[0].token_valid).toBe(true);

    const profileRow = await pool.query(`SELECT freelancer_id FROM freelancer_profiles WHERE freelancer_id = $1`, [createdUserId]);
    expect(profileRow.rowCount).toBe(1);
  });

  it('POST /auth/github/exchange redeems the code for a real session JWT', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/github/exchange',
      payload: { code: exchangeCode },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe(GITHUB_EMAIL);
    sessionToken = body.token;
  });

  it('POST /auth/github/exchange rejects an invalid code', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/auth/github/exchange',
      payload: { code: 'not-a-real-code' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /auth/github/exchange rejects a missing code', async () => {
    const res = await server.inject({ method: 'POST', url: '/auth/github/exchange', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/github/repos rejects an unauthenticated request', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/github/repos' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/github/repos lists the connected account repos for the signed-in freelancer', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/github/repos',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ name: 'widget-api', full_name: `${GITHUB_LOGIN}/widget-api`, private: false }]);
  });

  it('GET /api/freelancer/github-status reports CONNECTED for the linked account', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/freelancer/github-status',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'CONNECTED', githubLogin: GITHUB_LOGIN });
  });

  it('reconnecting via GitHub resets token_valid after a provisioning failure flagged it stale', async () => {
    // Simulate what settlement-worker's attemptProvisioning does on a
    // 404 "unknown login" adding this freelancer as a repo collaborator.
    await pool.query(`UPDATE auth_providers SET token_valid = FALSE WHERE user_id = $1 AND provider_type = 'GITHUB'`, [
      createdUserId,
    ]);
    const staleStatusRes = await server.inject({
      method: 'GET',
      url: '/api/freelancer/github-status',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(staleStatusRes.json().status).toBe('RECONNECTION_REQUIRED');

    const authRes = await server.inject({ method: 'GET', url: '/auth/github' });
    const state = new URL(authRes.headers.location as string).searchParams.get('state')!;
    const callbackRes = await server.inject({
      method: 'GET',
      url: `/auth/github/callback?code=fake_github_code_reconnect&state=${encodeURIComponent(state)}`,
    });
    expect(callbackRes.statusCode).toBe(302);

    const row = await pool.query(`SELECT token_valid FROM auth_providers WHERE user_id = $1 AND provider_type = 'GITHUB'`, [
      createdUserId,
    ]);
    expect(row.rows[0].token_valid).toBe(true);
  });
});
