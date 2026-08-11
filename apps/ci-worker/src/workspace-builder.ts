/**
 * Materialise a runnable work directory for one CI run.
 *
 * The gap this closes
 * -------------------
 * `processCodePush` called `runInSandbox(contractId, { workDir: undefined })`,
 * so both sandbox adapters refused to start and returned
 * `provisioned: false, passedTests: 0, totalTests: 0`. That is the correct
 * refusal for a sandbox with nothing to execute, but nothing ever gave it
 * something to execute — and 0/0 propagates all the way through the system:
 *
 *   overallPassed  requires totalTests > 0        -> always false
 *   /score         posts total_tests: 0 to xai    -> HTTP 409, never scores
 *   oracle         never receives XAI_SCORED      -> blocks every settlement
 *
 * So no contract could be scored or settled, ever. The two halves needed to
 * fix that already existed and were simply never joined: the pushed code
 * arrives on the CODE_PUSH_RECEIVED event, and the contract's test bundle is
 * generated and stored by ai-service. This module puts them in one directory.
 *
 * What gets written
 * -----------------
 *   package.json              CommonJS, so the generated `require` syntax loads
 *   index.js                  the pushed code, as the module under test
 *   tests/generated.test.js   the contract's bundle, fetched from ai-service
 *   harness.cjs               the in-process runner (see sandbox/test-harness.cjs)
 *   node_modules/@jest/globals  shim mapping the bundles' import onto the harness
 *
 * Nothing else is copied in — in particular the repository's `node_modules` is
 * not linked, so untrusted code cannot reach the workspace's real dependency
 * tree even before the sandbox's own filesystem restrictions apply.
 *
 * Honest failure
 * --------------
 * When no bundle can be resolved, `build()` throws rather than substituting an
 * empty suite. An empty suite runs clean and reports 0/0, which is exactly the
 * indeterminate reading the oracle must not confuse with a pass — and it would
 * be indistinguishable from this module working correctly.
 */
import { mkdtemp, mkdir, writeFile, rm, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Ships beside the sandbox adapters; copied into dist/ by scripts/build-workspaces.mjs. */
export const TEST_HARNESS_SOURCE = path.join(HERE, 'sandbox', 'test-harness.cjs');

export interface WorkspaceBuildOptions {
  contractId: string;
  /** The code that was pushed. Written as index.js. */
  code: string;
  /** Base URL of ai-service, which serves the stored bundle. */
  aiServiceUrl: string;
  framework?: 'jest' | 'cypress';
  /** Abort the bundle fetch after this long. */
  timeoutMs?: number;
  /**
   * Used instead of fetching when supplied. Tests pass a bundle directly so
   * they do not need a live ai-service.
   */
  testBundle?: string;
  /**
   * The push carried no freelancer code and the gateway substituted its demo
   * snippet. Pairs that snippet with the matching demo suite below.
   */
  demo?: boolean;
}

export interface Workspace {
  /** Absolute path to hand the sandbox as `workDir`. */
  dir: string;
  /** Entry script the sandbox executes, relative to `dir`. */
  entrypoint: string;
  /** Arguments passed to the entry script. */
  entryArgs: string[];
  /** Where the bundle came from, recorded so a result is attributable. */
  bundleSource: 'ai-service' | 'supplied' | 'demo';
  /** Remove the directory. Always call, in a finally. */
  cleanup(): Promise<void>;
}

/**
 * The suite paired with the gateway's demo snippet.
 *
 * There is no real freelancer code-submission flow yet, so `/simulate-push`
 * substitutes a small `add` module when the caller supplies none. Running the
 * *contract's* generated tests against that snippet would fail for the obvious
 * reason — those tests describe the contract's product, not a two-line adder —
 * and the failure would say nothing about the pipeline.
 *
 * This suite tests the demo snippet on its own terms. Every assertion really
 * executes and the counts are real; what is synthetic is the pairing, and
 * `bundleSource: 'demo'` records that on the result so it is never mistaken
 * for a freelancer's work being verified.
 */
export const DEMO_TEST_BUNDLE = `const { describe, it, expect } = require('@jest/globals');
const { add } = require('../index.js');

describe('demo contract — add()', () => {
  it('sums two positive integers', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('is identity when adding zero', () => {
    expect(add(7, 0)).toBe(7);
  });

  it('handles negative operands', () => {
    expect(add(-4, 1)).toBe(-3);
  });

  it('is commutative', () => {
    expect(add(9, 4)).toBe(add(4, 9));
  });

  it('exports a callable', () => {
    expect(typeof add).toBe('function');
  });
});
`;

export class TestBundleUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TestBundleUnavailableError';
  }
}

const PACKAGE_JSON = JSON.stringify(
  {
    name: 'assurecode-sandbox-run',
    version: '0.0.0',
    private: true,
    // CommonJS: the generated bundles are authored with `require`, per the
    // prompt in ai-service/app/routes/test_gen.py.
    type: 'commonjs',
  },
  null,
  2,
);

/**
 * `require('@jest/globals')` resolves here rather than to a real Jest install.
 * The harness has already published the same names as globals; this shim exists
 * so a bundle that imports them explicitly loads instead of throwing
 * MODULE_NOT_FOUND — which would report 0/0 and look like an infrastructure
 * failure rather than a bundle that ran.
 */
const JEST_GLOBALS_SHIM = `'use strict';
module.exports = {
  describe: globalThis.describe,
  it: globalThis.it,
  test: globalThis.test,
  expect: globalThis.expect,
  beforeAll: globalThis.beforeAll,
  afterAll: globalThis.afterAll,
  beforeEach: globalThis.beforeEach,
  afterEach: globalThis.afterEach,
};
`;

const FENCED_BLOCK = /```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?```/g;

/**
 * Strip markdown fences from a stored bundle.
 *
 * ai-service now strips these before storing (see its test_gen.py), so this is
 * for bundles written before that fix — the artifact store still holds them,
 * and every one begins with ```javascript. Without this they fail to load and
 * the run reports 0/0, which is honest but indistinguishable from a broken
 * pipeline. Cheap to keep, and it makes the worker robust to any producer that
 * hands back a model's raw output.
 */
function stripCodeFences(text: string): string {
  const blocks = [...text.matchAll(FENCED_BLOCK)].map((m) => m[1].trim());
  return blocks.length === 0 ? text.trim() : blocks.join('\n\n').trim();
}

/** Fetch the contract's stored bundle from ai-service. */
async function fetchTestBundle(
  aiServiceUrl: string,
  contractId: string,
  framework: string,
  timeoutMs: number,
): Promise<string> {
  const url = `${aiServiceUrl.replace(/\/$/, '')}/generate-tests/${encodeURIComponent(contractId)}?framework=${framework}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new TestBundleUnavailableError(
      `could not reach ai-service to fetch the test bundle for ${contractId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new TestBundleUnavailableError(
      `ai-service returned HTTP ${res.status} for the ${contractId} test bundle. ` +
        `Generate tests for this contract before pushing code. ${detail.slice(0, 300)}`,
    );
  }

  const body = stripCodeFences(await res.text());
  if (!body.trim()) {
    throw new TestBundleUnavailableError(
      `the stored test bundle for ${contractId} is empty; refusing to run a suite that ` +
        'measures nothing',
    );
  }
  return body;
}

/**
 * Build the directory. The caller owns `cleanup()` and must call it in a
 * `finally` — the sandbox writes into a separate scratch tree, so what is left
 * here after a run is only what this function put in.
 */
export async function buildWorkspace(options: WorkspaceBuildOptions): Promise<Workspace> {
  const { contractId, code, aiServiceUrl, framework = 'jest', timeoutMs = 10_000 } = options;

  if (!code || !code.trim()) {
    throw new TestBundleUnavailableError(
      `no code supplied for ${contractId}; there is nothing to build a workspace around`,
    );
  }

  let bundleSource: Workspace['bundleSource'];
  let bundle: string;
  if (options.testBundle) {
    bundleSource = 'supplied';
    bundle = options.testBundle;
  } else if (options.demo) {
    bundleSource = 'demo';
    bundle = DEMO_TEST_BUNDLE;
  } else {
    bundleSource = 'ai-service';
    bundle = await fetchTestBundle(aiServiceUrl, contractId, framework, timeoutMs);
  }

  // The harness must exist before anything is written — a workspace without a
  // runner is a directory the sandbox would start in and then fail inside,
  // which reads as a sandbox fault rather than a packaging one.
  try {
    await access(TEST_HARNESS_SOURCE);
  } catch {
    throw new TestBundleUnavailableError(
      `test harness missing at ${TEST_HARNESS_SOURCE}. It is a build asset copied by ` +
        'scripts/build-workspaces.mjs; the sandbox cannot run tests without it.',
    );
  }

  const dir = await mkdtemp(path.join(tmpdir(), `assurecode-ws-${contractId}-`));
  const cleanup = () => rm(dir, { recursive: true, force: true }).then(() => undefined);

  try {
    await mkdir(path.join(dir, 'tests'), { recursive: true });
    await mkdir(path.join(dir, 'node_modules', '@jest', 'globals'), { recursive: true });

    await Promise.all([
      writeFile(path.join(dir, 'package.json'), PACKAGE_JSON, 'utf8'),
      writeFile(path.join(dir, 'index.js'), code, 'utf8'),
      writeFile(path.join(dir, 'tests', 'generated.test.js'), bundle, 'utf8'),
      copyFile(TEST_HARNESS_SOURCE, path.join(dir, 'harness.cjs')),
      writeFile(
        path.join(dir, 'node_modules', '@jest', 'globals', 'package.json'),
        JSON.stringify({ name: '@jest/globals', version: '0.0.0', main: 'index.js' }),
        'utf8',
      ),
      writeFile(
        path.join(dir, 'node_modules', '@jest', 'globals', 'index.js'),
        JEST_GLOBALS_SHIM,
        'utf8',
      ),
    ]);

    return {
      dir,
      entrypoint: 'harness.cjs',
      entryArgs: [path.join('tests', 'generated.test.js')],
      bundleSource,
      cleanup,
    };
  } catch (err) {
    await cleanup().catch(() => undefined);
    throw err;
  }
}
