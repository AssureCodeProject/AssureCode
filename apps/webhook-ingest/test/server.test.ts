import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadConfig, getDatabaseUrl, buildDbConfig } from '@assurecode/config';
import { EVENT_TOPICS } from '@assurecode/shared';
import { verifyGitHubSignature, resolveContractId, fastify, eventBus } from '../src/server.js';
import { postgresAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const PG_UP = await postgresAvailable();
if (!PG_UP) announceSkip('webhook-ingest — contract resolution', 'a running PostgreSQL on DATABASE_URL');

/**
 * Derive the secret the same way the server does, rather than hardcoding its
 * fallback. The literal 'assurecode_github_secret' only matched while
 * GITHUB_WEBHOOK_SECRET happened to be unset, so the tests began failing the
 * moment the services started reading .env — for a signature that was correct,
 * against a server that was working.
 */
const SECRET = process.env.GITHUB_WEBHOOK_SECRET || 'assurecode_github_secret';

/** Sign a body exactly as GitHub does, and post it as the given event type. */
function deliver(body: unknown, event: string | null = 'push') {
  const raw = Buffer.from(JSON.stringify(body));
  const hmac = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${hmac}`,
  };
  if (event !== null) headers['x-github-event'] = event;
  return fastify.inject({ method: 'POST', url: '/webhooks/github', headers, payload: body });
}

/** A realistic push delivery for `owner/repo` at `sha`. */
function pushPayload(fullName: string, sha = 'a'.repeat(40)) {
  return {
    ref: 'refs/heads/main',
    after: sha,
    deleted: false,
    head_commit: { id: sha },
    repository: {
      name: fullName.split('/')[1],
      full_name: fullName,
      clone_url: `https://github.com/${fullName}.git`,
      html_url: `https://github.com/${fullName}`,
    },
    pusher: { name: 'freelancer-jane' },
  };
}

describe('webhook-ingest signature verification', () => {
  const secret = 'test_secret';

  it('verifies valid GitHub HMAC SHA256 signature', () => {
    const payload = JSON.stringify({ ref: 'refs/heads/main' });
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    expect(verifyGitHubSignature(payload, `sha256=${hmac}`, secret)).toBe(true);
  });

  it('rejects invalid GitHub HMAC SHA256 signature', () => {
    const payload = JSON.stringify({ ref: 'refs/heads/main' });
    expect(verifyGitHubSignature(payload, 'sha256=invalid', secret)).toBe(false);
  });

  it('returns 401 on /webhooks/github when signature is invalid', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'x-hub-signature-256': 'sha256=invalid', 'x-github-event': 'push' },
      payload: { contract_id: 'c1' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an unsigned request before considering the event type', async () => {
    // Ordering regression: if the event gate ran first, a `ping` would be
    // acknowledged with 200 without its signature ever being checked, and an
    // unauthenticated caller could probe the endpoint freely.
    const response = await fastify.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'x-hub-signature-256': 'sha256=invalid', 'x-github-event': 'ping' },
      payload: { zen: 'Design for failure.' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('webhook-ingest event filtering', () => {
  it('ignores a ping without publishing', async () => {
    // GitHub sends this the moment the webhook is created and disables a hook
    // that answers with a non-2xx, so it must be 200 — but there is nothing
    // to audit in it.
    const res = await deliver({ zen: 'Design for failure.', hook_id: 1 }, 'ping');
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe(true);
    expect(res.json().event).toBe('ping');
  });

  it('ignores a pull_request event', async () => {
    const res = await deliver({ action: 'opened', number: 7 }, 'pull_request');
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe(true);
  });

  it('ignores a delivery with no event header at all', async () => {
    const res = await deliver(pushPayload('acme/widget'), null);
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe(true);
  });

  it('ignores a branch deletion', async () => {
    // The null SHA is 40 hex characters, so it satisfies ci-worker's
    // commit-SHA check and would send it after a commit that does not exist.
    const body = { ...pushPayload('acme/widget', '0'.repeat(40)), deleted: true };
    const res = await deliver(body);
    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe('branch deleted');
  });

  it('rejects a push carrying no repository', async () => {
    const res = await deliver({ ref: 'refs/heads/main', after: 'a'.repeat(40) });
    expect(res.statusCode).toBe(400);
  });
});

describe('resolveContractId', () => {
  it('prefers an in-flight contract, via the query ordering', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      async query(sql: string, params: unknown[]) {
        calls.push({ sql, params });
        return { rows: [{ contract_id: 'AC-ACTIVE' }] };
      },
    };

    expect(await resolveContractId(pool, 'acme/widget')).toBe('AC-ACTIVE');
    expect(calls[0].params).toEqual(['acme/widget']);
    // The ordering is the whole reason a non-unique column is safe here: two
    // pushes of the same commit must resolve to the same contract.
    expect(calls[0].sql).toContain("status IN ('LOCKED','IN_PROGRESS')");
    expect(calls[0].sql).toContain('created_at DESC');
    expect(calls[0].sql).toContain('LIMIT 1');
  });

  it('returns null when no contract is linked', async () => {
    const pool = { async query() { return { rows: [] }; } };
    expect(await resolveContractId(pool, 'stranger/repo')).toBeNull();
  });
});

describe.skipIf(!PG_UP)('webhook-ingest contract resolution against a live database', () => {
  const config = loadConfig();
  const pool = new pg.Pool(buildDbConfig(getDatabaseUrl(config)));
  const linkedRepo = `assurecode-test/webhook-${Date.now()}`;
  const contractId = `AC-WH-${Date.now()}`;

  beforeAll(async () => {
    // 'legacy-client' is the fallback account V012 seeds, so the client_id FK
    // is satisfied without depending on tools/seed-users.py having run.
    await pool.query(
      `INSERT INTO contracts (contract_id, client_id, title, requirements, budget_cents, deadline, status, github_repo_full_name)
       VALUES ($1, 'legacy-client', 'Webhook ingest test', 'requirements', 100000, '2026-12-31', 'IN_PROGRESS', $2)
       ON CONFLICT (contract_id) DO NOTHING`,
      [contractId, linkedRepo],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM contracts WHERE contract_id = $1', [contractId]);
    await pool.end();
  });

  it('rejects a push for a repository no contract is linked to', async () => {
    // Previously this published an event with contractId 'unknown-contract',
    // which could only ever fail downstream on the audit_results foreign key.
    const res = await deliver(pushPayload(`nobody/unlinked-${Date.now()}`));
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain('No contract is linked');
  });

  it('resolves the linked contract and publishes the push coordinates', async () => {
    // The server's own bus, not a fresh createEventBus() — that returns a new
    // InMemoryBus per call, so a self-built one would never see this publish.
    const received: Array<Record<string, any>> = [];
    const unsubscribe = await eventBus.subscribe(
      EVENT_TOPICS.CODE_PUSH_RECEIVED,
      async (event) => {
        received.push(event.payload as Record<string, any>);
      },
    );

    const sha = 'b'.repeat(40);
    const res = await deliver(pushPayload(linkedRepo, sha));
    await unsubscribe();

    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('accepted');

    const event = received.find((p) => p.contractId === contractId);
    expect(event, 'a CODE_PUSH_RECEIVED event for the resolved contract').toBeDefined();
    // These two are what let ci-worker fetch the exact source that was pushed.
    expect(event!.commitHash).toBe(sha);
    expect(event!.repoUrl).toBe(`https://github.com/${linkedRepo}.git`);
    expect(event!.ref).toBe('refs/heads/main');
    expect(event!.pusher).toBe('freelancer-jane');
  });
});
