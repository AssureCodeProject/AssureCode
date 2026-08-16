/**
 * Tests for fetching the pushed source of a real GitHub push.
 *
 * The gap being closed: webhook-ingest publishes `code.push.received` with
 * repository coordinates but no file contents, so `processCodePush` refused
 * every webhook-originated push and only the gateway's `/simulate-push` — which
 * carries a two-line demo module inline — ever reached the pipeline.
 *
 * `fetch` is injected, so these run offline. The one thing they cannot cover is
 * GitHub's live behaviour; the shapes asserted here are from its documented
 * git/trees and git/blobs responses.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  GitHubSourceFetcher,
  SourceUnavailableError,
  createSourceFetcher,
  isAuditableSourcePath,
  isCommitSha,
  parseGitHubSlug,
} from '../src/source-fetcher.js';

const SHA = 'a'.repeat(40);

/** Minimal stub of the two GitHub endpoints the fetcher uses. */
function githubStub(files: Record<string, string>, opts: { truncated?: boolean } = {}) {
  const blobUrl = (path: string) => `https://api.github.com/blobs/${encodeURIComponent(path)}`;

  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);

    if (href.includes('/git/trees/')) {
      return new Response(
        JSON.stringify({
          truncated: Boolean(opts.truncated),
          tree: Object.keys(files).map((path) => ({
            path,
            type: 'blob',
            url: blobUrl(path),
          })),
        }),
        { status: 200 },
      );
    }

    const match = Object.keys(files).find((path) => href === blobUrl(path));
    if (match !== undefined) {
      return new Response(
        JSON.stringify({
          encoding: 'base64',
          content: Buffer.from(files[match], 'utf-8').toString('base64'),
        }),
        { status: 200 },
      );
    }

    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('parseGitHubSlug', () => {
  it.each([
    ['https://github.com/acme/widgets.git', 'acme/widgets'],
    ['https://github.com/acme/widgets', 'acme/widgets'],
    ['http://github.com/acme/widgets/', 'acme/widgets'],
    ['git@github.com:acme/widgets.git', 'acme/widgets'],
    ['https://www.github.com/acme/widgets', 'acme/widgets'],
  ])('parses %s', (url, expected) => {
    expect(parseGitHubSlug(url)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['https://gitlab.com/acme/widgets', 'a different host'],
    ['not a url', 'nonsense'],
    ['https://github.com/acme', 'no repo segment'],
  ])('rejects %s (%s)', (url) => {
    expect(parseGitHubSlug(url)).toBeNull();
  });

  it('rejects a traversal segment rather than building an escaping path', () => {
    expect(parseGitHubSlug('https://github.com/../..')).toBeNull();
  });
});

describe('isCommitSha', () => {
  it('accepts a full and an abbreviated sha', () => {
    expect(isCommitSha(SHA)).toBe(true);
    expect(isCommitSha('a1b2c3d')).toBe(true);
  });

  it('rejects branch names and short prefixes', () => {
    // The security-relevant case: resolving a branch would audit whatever HEAD
    // points at when the worker runs, letting a freelancer push benign code and
    // force-push something else once the audit starts.
    for (const value of ['main', 'refs/heads/main', 'HEAD', 'abc', '']) {
      expect(isCommitSha(value)).toBe(false);
    }
  });
});

describe('isAuditableSourcePath', () => {
  it.each(['src/index.js', 'a/b/c.ts', 'x.jsx', 'y.mjs', 'z.cjs', 'w.tsx'])(
    'includes %s',
    (path) => expect(isAuditableSourcePath(path)).toBe(true),
  );

  it.each([
    'node_modules/lodash/index.js',
    'dist/bundle.js',
    'build/out.js',
    'coverage/lcov.js',
    '.git/hooks/pre-commit.js',
  ])('excludes generated or vendored %s', (path) =>
    expect(isAuditableSourcePath(path)).toBe(false),
  );

  it('excludes type declarations, which contain no logic', () => {
    expect(isAuditableSourcePath('types/index.d.ts')).toBe(false);
  });

  it('excludes the test suite, which is not the deliverable', () => {
    expect(isAuditableSourcePath('src/a.test.js')).toBe(false);
    expect(isAuditableSourcePath('src/a.spec.tsx')).toBe(false);
  });

  it('excludes non-source files', () => {
    expect(isAuditableSourcePath('README.md')).toBe(false);
    expect(isAuditableSourcePath('package.json')).toBe(false);
  });
});

describe('GitHubSourceFetcher.fetchSource', () => {
  it('concatenates auditable sources with a path banner per file', async () => {
    const fetchImpl = githubStub({
      'src/a.js': 'const a = 1;',
      'src/b.js': 'const b = 2;',
    });
    const fetcher = new GitHubSourceFetcher({ fetchImpl });

    const source = await fetcher.fetchSource({
      repoUrl: 'https://github.com/acme/widgets.git',
      commitHash: SHA,
    });

    // The banner is what lets a reported line number be traced to a file.
    expect(source).toContain('// ==== src/a.js ====');
    expect(source).toContain('const a = 1;');
    expect(source).toContain('// ==== src/b.js ====');
    expect(source).toContain('const b = 2;');
  });

  it('orders files deterministically so the same commit yields the same input', async () => {
    // An audit whose input ordering varies is not reproducible, and line
    // numbers in stored findings would drift between runs of the same commit.
    const files = { 'src/z.js': 'const z = 1;', 'src/a.js': 'const a = 1;' };
    const fetcher = new GitHubSourceFetcher({ fetchImpl: githubStub(files) });
    const ref = { repoUrl: 'https://github.com/acme/widgets', commitHash: SHA };

    const first = await fetcher.fetchSource(ref);
    const second = await fetcher.fetchSource(ref);

    expect(first).toBe(second);
    expect(first.indexOf('src/a.js')).toBeLessThan(first.indexOf('src/z.js'));
  });

  it('skips vendored and generated files', async () => {
    const fetchImpl = githubStub({
      'src/a.js': 'const a = 1;',
      'node_modules/dep/index.js': 'const vendored = true;',
      'dist/bundle.js': 'const built = true;',
    });
    const fetcher = new GitHubSourceFetcher({ fetchImpl });

    const source = await fetcher.fetchSource({
      repoUrl: 'https://github.com/acme/widgets',
      commitHash: SHA,
    });

    expect(source).toContain('const a = 1;');
    expect(source).not.toContain('vendored');
    expect(source).not.toContain('built');
  });

  it('requests the tree pinned to the commit sha, not a branch', async () => {
    const fetchImpl = githubStub({ 'a.js': 'x' });
    await new GitHubSourceFetcher({ fetchImpl }).fetchSource({
      repoUrl: 'https://github.com/acme/widgets',
      commitHash: SHA,
    });

    const treeCall = (fetchImpl as any).mock.calls.find((c: any[]) =>
      String(c[0]).includes('/git/trees/'),
    );
    expect(String(treeCall[0])).toContain(SHA);
  });

  it('sends the token when one is configured', async () => {
    const fetchImpl = githubStub({ 'a.js': 'x' });
    await new GitHubSourceFetcher({ fetchImpl, token: 'ghp_secret' }).fetchSource({
      repoUrl: 'https://github.com/acme/widgets',
      commitHash: SHA,
    });

    const headers = (fetchImpl as any).mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer ghp_secret');
  });

  it('omits the Authorization header entirely when no token is set', async () => {
    const fetchImpl = githubStub({ 'a.js': 'x' });
    await new GitHubSourceFetcher({ fetchImpl }).fetchSource({
      repoUrl: 'https://github.com/acme/widgets',
      commitHash: SHA,
    });

    expect((fetchImpl as any).mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});

describe('GitHubSourceFetcher failure modes — all refuse, none fall back', () => {
  const fetcher = () => new GitHubSourceFetcher({ fetchImpl: githubStub({ 'a.js': 'x' }) });

  it('rejects a non-GitHub URL', async () => {
    await expect(
      fetcher().fetchSource({ repoUrl: 'https://gitlab.com/a/b', commitHash: SHA }),
    ).rejects.toThrow(SourceUnavailableError);
  });

  it('refuses a branch reference', async () => {
    await expect(
      fetcher().fetchSource({ repoUrl: 'https://github.com/a/b', commitHash: 'main' }),
    ).rejects.toThrow(/pinned to the exact commit/);
  });

  it('refuses a truncated tree rather than auditing part of the repo', async () => {
    // A partial view would report "no findings" over code it never saw.
    const f = new GitHubSourceFetcher({
      fetchImpl: githubStub({ 'a.js': 'x' }, { truncated: true }),
    });
    await expect(
      f.fetchSource({ repoUrl: 'https://github.com/a/b', commitHash: SHA }),
    ).rejects.toThrow(/too large/);
  });

  it('refuses when the commit contains no auditable source', async () => {
    const f = new GitHubSourceFetcher({ fetchImpl: githubStub({ 'README.md': '# hi' }) });
    await expect(
      f.fetchSource({ repoUrl: 'https://github.com/a/b', commitHash: SHA }),
    ).rejects.toThrow(/no auditable source files/);
  });

  it('enforces the byte cap', async () => {
    const f = new GitHubSourceFetcher({
      fetchImpl: githubStub({ 'big.js': 'x'.repeat(500) }),
      maxBytes: 100,
    });
    await expect(
      f.fetchSource({ repoUrl: 'https://github.com/a/b', commitHash: SHA }),
    ).rejects.toThrow(/exceeds the 100-byte audit limit/);
  });

  it('explains a 404 in terms of the likely cause', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const f = new GitHubSourceFetcher({ fetchImpl });
    await expect(
      f.fetchSource({ repoUrl: 'https://github.com/a/b', commitHash: SHA }),
    ).rejects.toThrow(/private and no GITHUB_TOKEN/);
  });

  it('explains a 403 as the unauthenticated rate limit', async () => {
    const fetchImpl = vi.fn(async () => new Response('limit', { status: 403 })) as unknown as typeof fetch;
    const f = new GitHubSourceFetcher({ fetchImpl });
    await expect(
      f.fetchSource({ repoUrl: 'https://github.com/a/b', commitHash: SHA }),
    ).rejects.toThrow(/60\/hour/);
  });

  it('surfaces a transport failure rather than returning empty source', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const f = new GitHubSourceFetcher({ fetchImpl });
    await expect(
      f.fetchSource({ repoUrl: 'https://github.com/a/b', commitHash: SHA }),
    ).rejects.toThrow(SourceUnavailableError);
  });
});

describe('createSourceFetcher', () => {
  it('returns null when the GitHub path is not enabled', () => {
    // Null is checkable at startup; a fetcher that throws on first use would
    // report a transport error for what is actually "the feature is off".
    expect(createSourceFetcher({} as NodeJS.ProcessEnv)).toBeNull();
    expect(createSourceFetcher({ ENABLE_GITHUB_SOURCE_FETCH: 'false' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns a fetcher when explicitly enabled', () => {
    const fetcher = createSourceFetcher({
      ENABLE_GITHUB_SOURCE_FETCH: 'true',
    } as NodeJS.ProcessEnv);
    expect(fetcher).toBeInstanceOf(GitHubSourceFetcher);
  });
});
