/**
 * Sandbox built on Node's permission model.
 *
 * Isolation comes from four withheld capabilities plus one preloaded guard:
 *
 *   --permission                 turns the model on; everything is denied by default
 *   --allow-fs-read=<workdir>    the only readable tree
 *   --allow-fs-write=<tmp>       the only writable tree
 *   (no --allow-child-process)   cannot spawn its way out
 *   (no --allow-worker)          cannot start a thread that escapes the guard
 *   (no --allow-addons)          cannot dlopen native code to reach raw sockets
 *   --require egress-guard.cjs   removes net/tls/dns/http/fetch/process.binding
 *   --max-old-space-size         heap ceiling
 *   + wall-clock timeout and kill
 *
 * The guard and the flags are load-bearing together, not separately: the guard
 * alone could be escaped via a child process or worker, and the flags alone
 * leave network egress open. test/sandbox-isolation.test.ts asserts each route
 * individually so a regression in any one of them fails loudly.
 *
 * What this does NOT provide, relative to a container: no PID/mount/user
 * namespace, no cgroup CPU quota, and no protection against a V8 or Node
 * vulnerability that defeats the permission model itself. Those are stated in
 * describeThreatModel() and belong in the paper's threat-model section rather
 * than being papered over.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  SandboxExecutionResult,
  SandboxOptions,
  SandboxRunner,
  ThreatModel,
} from './types.js';
import { parseTestOutput } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The guard is authored as .cjs and is not compiled by tsc, so it sits beside
 * this file in src/ during tests and must be copied into dist/ by the build.
 */
export const EGRESS_GUARD_PATH = path.join(HERE, 'egress-guard.cjs');

export class NodePermissionSandbox implements SandboxRunner {
  readonly name = 'node-permission';

  async isAvailable(): Promise<boolean> {
    // registerHooks landed in Node 22.15; without it ESM egress cannot be
    // blocked in-thread and the isolation claim would not hold.
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major > 22) return true;
    if (major === 22 && minor >= 15) return true;
    return false;
  }

  describeThreatModel(): ThreatModel {
    return {
      runner: this.name,
      enforced: [
        'filesystem reads confined to the work directory',
        'filesystem writes confined to a per-run temp directory',
        'no child process creation',
        'no worker thread creation',
        'no native addon loading',
        'no outbound network (net, tls, dgram, http, https, http2, dns, fetch, WebSocket)',
        'no process.binding escape to the C++ layer',
        'heap ceiling via --max-old-space-size',
        'wall-clock timeout with process kill',
      ],
      notEnforced: [
        'no PID, mount, or user namespace isolation',
        'no cgroup CPU quota — the process competes for CPU with the host',
        'no protection against a V8 or Node vulnerability that defeats the permission model',
        'environment variables of the parent are not scrubbed unless explicitly cleared',
      ],
    };
  }

  async run(contractId: string, options: SandboxOptions = {}): Promise<SandboxExecutionResult> {
    const startedAt = Date.now();
    const sandboxId = `sbx_node_${contractId}_${startedAt}`;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const memoryLimitMb = options.memoryLimitMb ?? 512;

    const fail = (message: string): SandboxExecutionResult => ({
      provisioned: false,
      sandboxId: `${sandboxId}_unavailable`,
      runner: this.name,
      passedTests: 0,
      totalTests: 0,
      rawOutput: `[sandbox-unavailable] ${message}`,
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      commitHash: options.commitHash,
      timedOut: false,
    });

    if (!(await this.isAvailable())) {
      return fail(
        `Node ${process.versions.node} lacks module.registerHooks(); ESM network imports ` +
          'could not be blocked, so the isolation guarantee would not hold. Node >= 22.15 required.',
      );
    }

    const workDir = options.workDir;
    if (!workDir) {
      return fail('No workDir supplied. The sandbox will not execute code it cannot locate.');
    }

    try {
      await access(workDir);
    } catch {
      return fail(`workDir does not exist: ${workDir}`);
    }

    try {
      await access(EGRESS_GUARD_PATH);
    } catch {
      return fail(
        `Egress guard missing at ${EGRESS_GUARD_PATH}. Refusing to run untrusted code ` +
          'without the control that blocks its network access.',
      );
    }

    const scratch = await mkdtemp(path.join(tmpdir(), 'assurecode-sbx-'));

    try {
      // The runner is invoked directly as a Node entrypoint: child processes
      // are denied, so npm cannot be spawned to do it. The workspace builder
      // writes `harness.cjs` into workDir for exactly this call.
      const entrypoint = options.entrypoint ?? 'harness.cjs';
      const entryArgs = options.entryArgs ?? [];

      const nodeArgs = [
        '--permission',
        `--allow-fs-read=${workDir}${path.sep}*`,
        `--allow-fs-read=${scratch}${path.sep}*`,
        `--allow-fs-write=${scratch}${path.sep}*`,
        `--max-old-space-size=${memoryLimitMb}`,
        '--require',
        EGRESS_GUARD_PATH,
        path.join(workDir, entrypoint),
        ...entryArgs,
      ];

      const child = spawn(process.execPath, nodeArgs, {
        cwd: workDir,
        env: {
          // Deliberately minimal: the parent's environment may hold the
          // Cloudflare token, database URL, and Stripe key.
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'test',
          CI: 'true',
          TMPDIR: scratch,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      const exitCode = await new Promise<number>((resolve) => {
        child.once('error', () => resolve(-1));
        child.once('close', (code) => resolve(code ?? -1));
      });
      clearTimeout(timer);

      const { passedTests, totalTests, testFailures } = parseTestOutput(stdout);

      return {
        provisioned: !timedOut,
        sandboxId,
        runner: this.name,
        passedTests,
        totalTests,
        testFailures,
        rawOutput: (stdout.trim() || stderr.trim()).slice(0, 20_000),
        exitCode,
        durationMs: Date.now() - startedAt,
        commitHash: options.commitHash,
        timedOut,
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}
