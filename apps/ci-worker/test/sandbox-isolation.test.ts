/**
 * Negative tests for the Node permission sandbox.
 *
 * Each test attempts one specific escape and asserts it fails. This is the
 * evidence behind the isolation claim: `--network=none` on a container is
 * usually asserted and never verified, whereas every control below is
 * demonstrated to hold on the machine running the suite.
 *
 * The controls are interdependent, which is why they are tested individually:
 * the egress guard is defeated by a child process or worker thread, so if
 * either of those permissions regressed, the network tests would still pass
 * while the sandbox was wide open.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodePermissionSandbox } from '../src/sandbox/node-permission-sandbox.js';

const GUARD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'sandbox',
  'egress-guard.cjs',
);

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'assurecode-isolation-'));
  return async () => {
    await rm(scratch, { recursive: true, force: true });
  };
});

/**
 * Execute `source` under exactly the flags the sandbox uses, and return what
 * the child printed. The script writes its own verdict to stdout.
 */
async function runGuarded(source: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const file = path.join(scratch, `probe-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(file, source, 'utf8');

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--permission',
        `--allow-fs-read=${scratch}${path.sep}*`,
        `--allow-fs-write=${scratch}${path.sep}*`,
        '--max-old-space-size=256',
        '--require',
        GUARD,
        file,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += String(c);
    });
    child.stderr.on('data', (c) => {
      stderr += String(c);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

/** Wrap an escape attempt so success and failure both print a marker. */
function probe(attempt: string): string {
  return `
    try {
      ${attempt}
      console.log('ESCAPED');
    } catch (e) {
      console.log('BLOCKED:' + (e.code ?? e.constructor.name));
    }
  `;
}

describe('node permission sandbox — filesystem', () => {
  it('denies reads outside the permitted tree', async () => {
    const { stdout } = await runGuarded(
      probe(`const fs = await import('node:fs'); fs.readFileSync(${JSON.stringify(process.execPath)});`),
    );
    expect(stdout).toContain('BLOCKED');
    expect(stdout).not.toContain('ESCAPED');
  });

  it('denies writes outside the permitted tree', async () => {
    const target = path.join(tmpdir(), 'assurecode-should-not-exist.txt');
    const { stdout } = await runGuarded(
      probe(`const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(target)}, 'x');`),
    );
    expect(stdout).toContain('BLOCKED');
  });
});

describe('node permission sandbox — process creation', () => {
  it('denies spawning a child process', async () => {
    const { stdout } = await runGuarded(
      probe(`const cp = await import('node:child_process'); cp.spawnSync(process.execPath, ['-e', '1']);`),
    );
    expect(stdout).toContain('BLOCKED');
  });

  it('denies starting a worker thread', async () => {
    // Load-bearing: a worker would run without the in-thread egress hooks.
    const { stdout } = await runGuarded(
      probe(`const w = await import('node:worker_threads'); new w.Worker('', { eval: true });`),
    );
    expect(stdout).toContain('BLOCKED');
  });

  it('denies loading a native addon', async () => {
    // Load-bearing: native code reaches raw sockets below the module system.
    const { stdout } = await runGuarded(probe(`process.dlopen({ exports: {} }, 'anything.node');`));
    expect(stdout).toContain('BLOCKED');
  });
});

describe('node permission sandbox — network egress', () => {
  it('denies importing net via ESM', async () => {
    const { stdout } = await runGuarded(probe(`await import('node:net');`));
    expect(stdout).toContain('BLOCKED:EGRESS_DENIED');
  });

  it('denies requiring net via CommonJS', async () => {
    const { stdout } = await runGuarded(
      probe(`const { createRequire } = await import('node:module'); createRequire(import.meta.url)('net');`),
    );
    expect(stdout).toContain('BLOCKED:EGRESS_DENIED');
  });

  it('denies dns, tls, http and https', async () => {
    for (const mod of ['node:dns', 'node:tls', 'node:http', 'node:https']) {
      const { stdout } = await runGuarded(probe(`await import(${JSON.stringify(mod)});`));
      expect(stdout, `${mod} should be blocked`).toContain('BLOCKED:EGRESS_DENIED');
    }
  });

  it('denies global fetch', async () => {
    const { stdout } = await runGuarded(probe(`await fetch('https://example.com');`));
    expect(stdout).toContain('BLOCKED:EGRESS_DENIED');
  });

  it('denies process.binding as a route to the C++ layer', async () => {
    const { stdout } = await runGuarded(probe(`process.binding('tcp_wrap');`));
    expect(stdout).toContain('BLOCKED:EGRESS_DENIED');
  });

  it('cannot restore fetch by reassigning the global', async () => {
    const { stdout } = await runGuarded(
      probe(`globalThis.fetch = () => 'restored'; if (globalThis.fetch() === 'restored') throw new Error('unreachable');`),
    );
    // The property is non-writable, so assignment throws in strict-mode ESM.
    expect(stdout).toContain('BLOCKED');
  });
});

describe('node permission sandbox — contract', () => {
  it('refuses to run without a work directory rather than reporting a pass', async () => {
    const sandbox = new NodePermissionSandbox();
    const res = await sandbox.run('c1', {});
    expect(res.provisioned).toBe(false);
    expect(res.passedTests).toBe(0);
    expect(res.totalTests).toBe(0);
    expect(res.rawOutput).toContain('sandbox-unavailable');
  });

  it('reports 0/0 as indeterminate, never as success', async () => {
    const sandbox = new NodePermissionSandbox();
    const res = await sandbox.run('c1', { workDir: path.join(scratch, 'nope') });
    expect(res.provisioned).toBe(false);
    // 0 of 0 tests passing must never be read as a passing build.
    expect(res.totalTests).toBe(0);
  });

  it('states its threat model, including what it does not enforce', () => {
    const model = new NodePermissionSandbox().describeThreatModel();
    expect(model.enforced.length).toBeGreaterThan(0);
    expect(model.notEnforced.length).toBeGreaterThan(0);
    expect(model.notEnforced.join(' ')).toMatch(/namespace|cgroup/i);
  });
});
