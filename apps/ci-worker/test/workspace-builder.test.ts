/**
 * The workspace builder is what gives the sandbox something to execute.
 *
 * Before it existed, `processCodePush` passed `workDir: undefined`, both
 * sandbox adapters refused to start, and every run reported 0/0 — which made
 * `overallPassed` permanently false, made /score answer 409, and left the
 * settlement oracle with no trust score to gate on. So the assertion that
 * matters most here is the plainest one: a built workspace produces
 * `totalTests > 0` when actually run.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildWorkspace,
  DEMO_TEST_BUNDLE,
  TestBundleUnavailableError,
  type Workspace,
} from '../src/workspace-builder.js';
import { NodePermissionSandbox } from '../src/sandbox/node-permission-sandbox.js';
import { parseTestOutput } from '../src/sandbox/types.js';

const DEMO_CODE = `function add(a, b) {
  return a + b;
}

module.exports = { add };
`;

const built: Workspace[] = [];

afterEach(async () => {
  await Promise.all(built.splice(0).map((w) => w.cleanup().catch(() => undefined)));
});

async function build(options: Parameters<typeof buildWorkspace>[0]): Promise<Workspace> {
  const ws = await buildWorkspace(options);
  built.push(ws);
  return ws;
}

describe('workspace builder — layout', () => {
  it('writes every file the sandbox needs to run', async () => {
    const ws = await build({
      contractId: 'AC-WS1',
      code: DEMO_CODE,
      aiServiceUrl: 'http://unused',
      testBundle: DEMO_TEST_BUNDLE,
    });

    for (const rel of [
      'package.json',
      'index.js',
      'harness.cjs',
      path.join('tests', 'generated.test.js'),
      path.join('node_modules', '@jest', 'globals', 'index.js'),
      path.join('node_modules', '@jest', 'globals', 'package.json'),
    ]) {
      await expect(access(path.join(ws.dir, rel)), `${rel} should exist`).resolves.toBeUndefined();
    }

    expect(ws.entrypoint).toBe('harness.cjs');
    // path.posix, deliberately. This argument is consumed inside the sandbox
    // container, which is Linux whatever the host is. Asserting path.join here
    // meant the test agreed with the bug on Windows: the harness was handed
    // "tests\generated.test.js", found nothing, and reported 0 of 0 tests —
    // which the pipeline reads as indeterminate rather than as a failure, so
    // everything stayed green while no test had executed.
    expect(ws.entryArgs).toEqual(['tests/generated.test.js']);
  });

  it('writes the pushed code as the module under test', async () => {
    const ws = await build({
      contractId: 'AC-WS2',
      code: DEMO_CODE,
      aiServiceUrl: 'http://unused',
      testBundle: DEMO_TEST_BUNDLE,
    });
    expect(await readFile(path.join(ws.dir, 'index.js'), 'utf8')).toBe(DEMO_CODE);
  });

  it('declares CommonJS, matching the require syntax the bundles are generated in', async () => {
    const ws = await build({
      contractId: 'AC-WS3',
      code: DEMO_CODE,
      aiServiceUrl: 'http://unused',
      testBundle: DEMO_TEST_BUNDLE,
    });
    const pkg = JSON.parse(await readFile(path.join(ws.dir, 'package.json'), 'utf8'));
    expect(pkg.type).toBe('commonjs');
  });

  it('does not link the repository node_modules into the workspace', async () => {
    const ws = await build({
      contractId: 'AC-WS4',
      code: DEMO_CODE,
      aiServiceUrl: 'http://unused',
      testBundle: DEMO_TEST_BUNDLE,
    });
    // Only the @jest/globals shim is present; untrusted code must not be able
    // to reach the workspace's real dependency tree.
    await expect(access(path.join(ws.dir, 'node_modules', 'vitest'))).rejects.toThrow();
  });

  it('records where the bundle came from', async () => {
    const supplied = await build({
      contractId: 'AC-WS5',
      code: DEMO_CODE,
      aiServiceUrl: 'http://unused',
      testBundle: DEMO_TEST_BUNDLE,
    });
    expect(supplied.bundleSource).toBe('supplied');

    const demo = await build({
      contractId: 'AC-WS6',
      code: DEMO_CODE,
      aiServiceUrl: 'http://unused',
      demo: true,
    });
    expect(demo.bundleSource).toBe('demo');
  });

  it('cleans up after itself', async () => {
    const ws = await buildWorkspace({
      contractId: 'AC-WS7',
      code: DEMO_CODE,
      aiServiceUrl: 'http://unused',
      testBundle: DEMO_TEST_BUNDLE,
    });
    await ws.cleanup();
    await expect(access(ws.dir)).rejects.toThrow();
  });
});

describe('workspace builder — refusals', () => {
  it('refuses to build around no code', async () => {
    await expect(
      buildWorkspace({
        contractId: 'AC-WS8',
        code: '   ',
        aiServiceUrl: 'http://unused',
        testBundle: DEMO_TEST_BUNDLE,
      }),
    ).rejects.toThrow(TestBundleUnavailableError);
  });

  it('refuses an empty bundle rather than running a suite that measures nothing', async () => {
    // An empty suite runs clean and reports 0/0 — indistinguishable from this
    // module working correctly, which is the whole reason it must not happen.
    await expect(
      buildWorkspace({
        contractId: 'AC-WS9',
        code: DEMO_CODE,
        // Unroutable address, so the fetch fails fast rather than hanging.
        aiServiceUrl: 'http://127.0.0.1:1',
        timeoutMs: 500,
      }),
    ).rejects.toThrow(TestBundleUnavailableError);
  });

  it('names the contract when ai-service cannot supply a bundle', async () => {
    await expect(
      buildWorkspace({
        contractId: 'AC-NAMED',
        code: DEMO_CODE,
        aiServiceUrl: 'http://127.0.0.1:1',
        timeoutMs: 500,
      }),
    ).rejects.toThrow(/AC-NAMED/);
  });
});

describe('workspace builder — executed under the sandbox', () => {
  it('produces a run with real, non-zero test counts', async () => {
    const ws = await build({
      contractId: 'AC-RUN1',
      code: DEMO_CODE,
      aiServiceUrl: 'http://unused',
      demo: true,
    });

    const sandbox = new NodePermissionSandbox();
    if (!(await sandbox.isAvailable())) return; // Node < 22.15; covered elsewhere.

    const res = await sandbox.run('AC-RUN1', {
      workDir: ws.dir,
      entrypoint: ws.entrypoint,
      entryArgs: ws.entryArgs,
      timeoutMs: 30_000,
    });

    // The regression this whole module exists to prevent.
    expect(res.totalTests).toBeGreaterThan(0);
    expect(res.passedTests).toBe(res.totalTests);
    expect(res.provisioned).toBe(true);
  });

  it('reports genuine failures rather than rounding them up to a pass', async () => {
    const ws = await build({
      contractId: 'AC-RUN2',
      code: 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n',
      aiServiceUrl: 'http://unused',
      demo: true,
    });

    const sandbox = new NodePermissionSandbox();
    if (!(await sandbox.isAvailable())) return;

    const res = await sandbox.run('AC-RUN2', {
      workDir: ws.dir,
      entrypoint: ws.entrypoint,
      entryArgs: ws.entryArgs,
      timeoutMs: 30_000,
    });

    expect(res.totalTests).toBeGreaterThan(0);
    expect(res.passedTests).toBeLessThan(res.totalTests);
  });

  it('reports 0/0 when the bundle cannot even load', async () => {
    const ws = await build({
      contractId: 'AC-RUN3',
      code: DEMO_CODE,
      aiServiceUrl: 'http://unused',
      testBundle: 'this is not ( valid javascript',
    });

    const sandbox = new NodePermissionSandbox();
    if (!(await sandbox.isAvailable())) return;

    const res = await sandbox.run('AC-RUN3', {
      workDir: ws.dir,
      entrypoint: ws.entrypoint,
      entryArgs: ws.entryArgs,
      timeoutMs: 30_000,
    });

    // Indeterminate, never a pass.
    expect(res.totalTests).toBe(0);
    expect(res.passedTests).toBe(0);
  });
});

describe('harness output contract', () => {
  it('emits the shape parseTestOutput already reads', () => {
    const line = JSON.stringify({
      numPassedTests: 5,
      numFailedTests: 1,
      numPendingTests: 0,
      numTotalTests: 6,
    });
    expect(parseTestOutput(`  ✓ a\n${line}\n`)).toEqual({ passedTests: 5, totalTests: 6 });
  });
});

describe('sandbox entrypoint', () => {
  it('runs the supplied entry script instead of the old npm-shaped command', async () => {
    // The previous default was ['npm','test','--','--reporter=json'] with
    // command[0] dropped, so `test` reached the runner as a filename filter.
    const dir = await mkdtemp(path.join(tmpdir(), 'assurecode-entry-'));
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        path.join(dir, 'harness.cjs'),
        'process.stdout.write(JSON.stringify({numPassedTests:2,numFailedTests:0,numTotalTests:2})+"\\n");\n',
        'utf8',
      );

      const sandbox = new NodePermissionSandbox();
      if (!(await sandbox.isAvailable())) return;

      const res = await sandbox.run('AC-ENTRY', {
        workDir: dir,
        entrypoint: 'harness.cjs',
        entryArgs: [],
        timeoutMs: 20_000,
      });
      expect(res.totalTests).toBe(2);
      expect(res.passedTests).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
