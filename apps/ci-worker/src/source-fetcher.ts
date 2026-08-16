/**
 * Fetching the pushed source for a GitHub `code.push.received` event.
 *
 * The gap this closes is documented at the top of worker.ts: webhook-ingest
 * publishes `contractId`, `commitHash`, `repoUrl` and `ref` but no `code`,
 * because it never fetches the repository. `processCodePush` then refuses with
 * "No code supplied" — the correct refusal for a push whose contents it cannot
 * see — so the only path that ever reached the pipeline was the gateway's
 * `/simulate-push`, which carries code inline.
 *
 * Why HTTP rather than `git clone`
 * --------------------------------
 * worker.ts suggests cloning in the workspace builder, noting that
 * NodePermissionSandbox cannot shell out to git. But the clone does not need to
 * happen inside the sandbox at all — the worker fetches, then hands the sandbox
 * a directory. Fetching over HTTP keeps that true without requiring a `git`
 * binary in the image, which matters because infra/docker/Dockerfile.ci-worker
 * is a slim base and adding git to the image that executes untrusted code adds
 * a capability for no benefit.
 *
 * GitHub serves a commit's full tree at
 * `codeload.github.com/{owner}/{repo}/tar.gz/{sha}` — one request, no git, and
 * pinned to the exact SHA the webhook reported rather than to whatever the
 * branch points at by the time the worker gets around to it. That pinning is
 * the security-relevant part: resolving `ref` instead of `commitHash` would let
 * a freelancer push benign code, wait for the audit to start, and force-push
 * something else.
 *
 * Unconfigured is explicit, not silent
 * ------------------------------------
 * With no fetcher configured this raises `SourceUnavailableError` naming the
 * reason. It does not fall back to demo code. An audit run against a different
 * body of code than the one that was pushed is worse than no audit, because it
 * produces a trust score that looks like evidence.
 */

/** Raised when the pushed source cannot be obtained. Never swallowed. */
export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

export interface PushRef {
  /** Repository clone or HTML URL from the webhook payload. */
  repoUrl: string;
  /** Exact commit SHA. Never a branch name — see the header. */
  commitHash: string;
}

/** The seam. `worker.ts` depends on this, not on GitHub. */
export interface SourceFetcher {
  fetchSource(ref: PushRef): Promise<string>;
}

/** Files worth auditing. Anything else is noise in a JS/TS contract. */
const AUDITABLE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'];

/** Directories never worth auditing, whatever they contain. */
const EXCLUDED_SEGMENTS = ['node_modules/', '.git/', 'dist/', 'build/', 'coverage/', '.next/'];

export function isAuditableSourcePath(path: string): boolean {
  if (EXCLUDED_SEGMENTS.some((segment) => path.includes(segment))) return false;
  if (path.endsWith('.d.ts')) return false; // declarations contain no logic
  if (/(^|\/)[^/]*\.(test|spec)\.[jt]sx?$/.test(path)) return false; // the suite is not the deliverable
  return AUDITABLE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * `https://github.com/owner/repo.git` → `owner/repo`.
 *
 * Returns null rather than throwing so the caller can produce one error
 * mentioning the actual URL, which is more useful than a parse exception.
 */
export function parseGitHubSlug(repoUrl: string): string | null {
  if (!repoUrl) return null;

  const match = repoUrl.match(
    /^(?:https?:\/\/|git@)(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
  );
  if (!match) return null;

  const [, owner, repo] = match;
  // A path segment of '..' would escape the codeload URL's path.
  if (owner === '..' || repo === '..') return null;
  return `${owner}/${repo}`;
}

/** A 40-hex commit SHA, or a 7+ char abbreviation. Rejects branch names. */
export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

export interface GitHubSourceFetcherOptions {
  /**
   * Token for private repositories and for a usable rate limit. Public repos
   * work unauthenticated, at 60 requests/hour/IP.
   */
  token?: string;
  timeoutMs?: number;
  /** Cap on concatenated source. Guards against a repo that will not fit. */
  maxBytes?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetches a commit's auditable source from GitHub and concatenates it.
 *
 * Concatenation rather than a directory because everything downstream — the
 * AST analyzer, the OWASP scanner, `performDualLayerScan` — takes a single
 * string. Each file is preceded by a `// ==== path ====` banner so a reported
 * line number can still be traced back to a file.
 */
export class GitHubSourceFetcher implements SourceFetcher {
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubSourceFetcherOptions = {}) {
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxBytes = options.maxBytes ?? 2_000_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchSource(ref: PushRef): Promise<string> {
    const slug = parseGitHubSlug(ref.repoUrl);
    if (!slug) {
      throw new SourceUnavailableError(
        `not a recognisable GitHub repository URL: ${ref.repoUrl || '(empty)'}`,
      );
    }

    if (!isCommitSha(ref.commitHash)) {
      // A branch name here would audit whatever HEAD points at when the worker
      // runs, which is not necessarily what was pushed.
      throw new SourceUnavailableError(
        `refusing to fetch source for a non-commit reference (${ref.commitHash || '(empty)'}); ` +
          'the audit must be pinned to the exact commit the webhook reported',
      );
    }

    const url = `https://api.github.com/repos/${slug}/git/trees/${ref.commitHash}?recursive=1`;

    const tree = await this.getJson(url);
    const entries: Array<{ path: string; type: string; url: string; size?: number }> =
      Array.isArray((tree as any)?.tree) ? (tree as any).tree : [];

    if ((tree as any)?.truncated) {
      // GitHub truncates very large trees. Auditing a silently partial view of
      // the repository would report "no findings" over code it never saw.
      throw new SourceUnavailableError(
        `the tree for ${slug}@${ref.commitHash} is too large for a single listing; ` +
          'a partial audit would misreport coverage',
      );
    }

    const sources = entries.filter((e) => e.type === 'blob' && isAuditableSourcePath(e.path));
    if (sources.length === 0) {
      throw new SourceUnavailableError(
        `no auditable source files found in ${slug}@${ref.commitHash}`,
      );
    }

    const parts: string[] = [];
    let total = 0;

    for (const entry of sources.sort((a, b) => a.path.localeCompare(b.path))) {
      const blob = await this.getJson(entry.url);
      const content = decodeBlob(blob);
      if (content === null) continue;

      total += content.length;
      if (total > this.maxBytes) {
        throw new SourceUnavailableError(
          `source for ${slug}@${ref.commitHash} exceeds the ${this.maxBytes}-byte audit limit`,
        );
      }
      parts.push(`// ==== ${entry.path} ====\n${content}`);
    }

    if (parts.length === 0) {
      throw new SourceUnavailableError(
        `every source file in ${slug}@${ref.commitHash} was unreadable`,
      );
    }

    return parts.join('\n\n');
  }

  private async getJson(url: string): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'assurecode-ci-worker',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SourceUnavailableError(
        `could not reach GitHub for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (res.status === 404) {
      throw new SourceUnavailableError(
        `GitHub returned 404 for ${url} — the commit may not exist, or the repository is ` +
          'private and no GITHUB_TOKEN is configured',
      );
    }
    if (res.status === 403) {
      throw new SourceUnavailableError(
        `GitHub returned 403 for ${url} — unauthenticated requests are limited to 60/hour; ` +
          'set GITHUB_TOKEN',
      );
    }
    if (!res.ok) {
      throw new SourceUnavailableError(`GitHub returned HTTP ${res.status} for ${url}`);
    }

    try {
      return await res.json();
    } catch {
      throw new SourceUnavailableError(`GitHub returned a non-JSON body for ${url}`);
    }
  }
}

/** Decode a GitHub blob response, or null if it is not decodable text. */
function decodeBlob(blob: unknown): string | null {
  const record = blob as { content?: unknown; encoding?: unknown } | null;
  if (!record || typeof record.content !== 'string') return null;
  if (record.encoding !== 'base64') {
    return record.encoding === 'utf-8' ? record.content : null;
  }
  try {
    return Buffer.from(record.content, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Build the fetcher from configuration, or null when the real-repository path
 * is not configured.
 *
 * Null is a deliberate, checkable value rather than a fetcher that fails on
 * first use: the caller reports "the GitHub path is not enabled" instead of a
 * transport error, which is a very different diagnosis.
 */
export function createSourceFetcher(env: NodeJS.ProcessEnv = process.env): SourceFetcher | null {
  if (env.ENABLE_GITHUB_SOURCE_FETCH !== 'true') return null;
  return new GitHubSourceFetcher({ token: env.GITHUB_TOKEN });
}
