/**
 * Three thin GitHub API calls behind AssureCode's own org credential
 * (GITHUB_TOKEN + GITHUB_ORG, see packages/config): create a private repo
 * for a contract, add the assigned freelancer as an outside collaborator,
 * and attach the webhook that already exists for freelancer-owned repos
 * (apps/api-gateway/src/routes/contracts-lifecycle.ts:329-377) -- this is
 * the same webhook body shape, just fired with the org's token instead of
 * a freelancer's.
 *
 * No SDK: every other GitHub call site in this repo (auth.ts, ci-worker's
 * source-fetcher.ts) is raw fetch, and three call sites don't earn a new
 * dependency.
 *
 * Each function is written to be safely re-callable: GitHub's "already
 * exists" responses are treated as reconciliation, not failure, so a retry
 * after a partial success (repo created, DB write lost) finds and reuses
 * what is already there instead of erroring or duplicating it. Nothing here
 * throws for an expected GitHub response; a thrown error means the network
 * call itself failed, which the caller (attemptProvisioning in worker.ts)
 * catches and records as a retryable attempt.
 */

const GITHUB_API = 'https://api.github.com';

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'assurecode-settlement-worker',
    Accept: 'application/vnd.github+json',
  };
}

export interface ProvisionerDeps {
  org: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface CreatedRepo {
  repoId: number;
  repoFullName: string;
  repoHtmlUrl: string;
}

/**
 * Create `{org}/{name}` as a private repo, or reconcile onto it if a prior
 * attempt already created it (name collision -> 422 -> GET the existing
 * repo instead of treating this as failure).
 */
export async function createOrgRepo(name: string, deps: ProvisionerDeps): Promise<CreatedRepo> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${GITHUB_API}/orgs/${encodeURIComponent(deps.org)}/repos`, {
    method: 'POST',
    headers: { ...ghHeaders(deps.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, private: true }),
  });

  if (res.status === 201) {
    const body = (await res.json()) as { id: number; full_name: string; html_url: string };
    return { repoId: body.id, repoFullName: body.full_name, repoHtmlUrl: body.html_url };
  }

  if (res.status === 422) {
    // Name already taken -- almost certainly by us, on a prior attempt that
    // crashed before persisting the result. Fetch it back rather than fail.
    const existing = await doFetch(`${GITHUB_API}/repos/${encodeURIComponent(deps.org)}/${encodeURIComponent(name)}`, {
      headers: ghHeaders(deps.token),
    });
    if (existing.ok) {
      const body = (await existing.json()) as { id: number; full_name: string; html_url: string };
      return { repoId: body.id, repoFullName: body.full_name, repoHtmlUrl: body.html_url };
    }
  }

  const detail = await res.text().catch(() => '');
  throw new Error(`createOrgRepo(${deps.org}/${name}) failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
}

export type CollaboratorOutcome =
  | { kind: 'invited' }
  | { kind: 'already-collaborator' }
  | { kind: 'unknown-login' };

/**
 * Invite `login` to `{org}/{repo}` with push (write) access, never org
 * membership. GitHub's own semantics already give us idempotency here: 201
 * on a fresh invite, 204 if they're already a collaborator -- both are
 * success. A 404 means the login on file doesn't exist (renamed/deleted
 * account); the caller uses this to flag the freelancer's GitHub identity
 * as needing reconnection rather than retrying forever.
 */
export async function addOutsideCollaborator(
  repoFullName: string,
  login: string,
  deps: ProvisionerDeps,
): Promise<CollaboratorOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${GITHUB_API}/repos/${repoFullName}/collaborators/${encodeURIComponent(login)}`, {
    method: 'PUT',
    headers: { ...ghHeaders(deps.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ permission: 'push' }),
  });

  if (res.status === 201) return { kind: 'invited' };
  if (res.status === 204) return { kind: 'already-collaborator' };
  if (res.status === 404) return { kind: 'unknown-login' };

  const detail = await res.text().catch(() => '');
  throw new Error(`addOutsideCollaborator(${repoFullName}, ${login}) failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
}

export interface AttachedWebhook {
  webhookId: number;
}

/**
 * Attach the push webhook to `{repoFullName}`, reusing the same body shape
 * already established for freelancer-owned repos in
 * contracts-lifecycle.ts:346-364. On "hook already exists" (422), find and
 * reuse the one matching our own callback URL rather than erroring.
 */
export async function attachWebhook(
  repoFullName: string,
  callbackUrl: string,
  secret: string,
  deps: ProvisionerDeps,
): Promise<AttachedWebhook> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${GITHUB_API}/repos/${repoFullName}/hooks`, {
    method: 'POST',
    headers: { ...ghHeaders(deps.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: ['push'],
      config: { url: callbackUrl, content_type: 'json', secret },
    }),
  });

  if (res.status === 201) {
    const body = (await res.json()) as { id: number };
    return { webhookId: body.id };
  }

  if (res.status === 422) {
    const existing = await doFetch(`${GITHUB_API}/repos/${repoFullName}/hooks`, {
      headers: ghHeaders(deps.token),
    });
    if (existing.ok) {
      const hooks = (await existing.json()) as Array<{ id: number; config?: { url?: string } }>;
      const match = hooks.find((h) => h.config?.url === callbackUrl);
      if (match) return { webhookId: match.id };
    }
  }

  const detail = await res.text().catch(() => '');
  throw new Error(`attachWebhook(${repoFullName}) failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
}
