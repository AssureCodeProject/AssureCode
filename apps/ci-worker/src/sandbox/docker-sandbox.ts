/**
 * Sandbox built on a container runtime.
 *
 * Stronger isolation than the Node permission model — namespaces, cgroups, and
 * a kernel-enforced network boundary — but it needs a daemon, which not every
 * host can run. `isAvailable()` probes for one, and the factory in index.ts
 * falls back to NodePermissionSandbox when it is absent.
 *
 * Unlike the original implementation this actually mounts the code under test.
 * That version ran `npm ci && npm test` inside a bare node:20-alpine image with
 * no volume, no clone, and no test bundle, so it executed the image's empty
 * working directory and reported whatever that produced.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  SandboxExecutionResult,
  SandboxOptions,
  SandboxRunner,
  ThreatModel,
} from './types.js';
import { parseTestOutput } from './types.js';

const IMAGE = 'node:20-alpine';

/**
 * Single-quote a value for the `sh -c` string below.
 *
 * The container command is the one place a shell is unavoidable (copy, then
 * run), and the entrypoint path originates from the workspace builder rather
 * than from untrusted input — but quoting it is what keeps that true of any
 * future caller as well. Single quotes suppress every sh metacharacter; the
 * `'\''` dance is how a literal single quote is embedded inside them.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run a binary with an argument array — never a shell string. */
function execFileCapture(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (c) => {
      stdout += String(c);
    });
    child.stderr.on('data', (c) => {
      stderr += String(c);
    });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;

    child.once('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

export class DockerSandbox implements SandboxRunner {
  readonly name = 'docker';

  async isAvailable(): Promise<boolean> {
    const probe = await execFileCapture('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeoutMs: 5_000,
    });
    return probe.code === 0;
  }

  describeThreatModel(): ThreatModel {
    return {
      runner: this.name,
      enforced: [
        'PID, mount, IPC, and network namespace isolation',
        'no network interface at all (--network=none)',
        'cgroup memory limit and CPU quota',
        'read-only bind mounts for code and hidden tests',
        'container removed on exit (--rm), so no state survives a run',
        'wall-clock timeout with process kill',
      ],
      notEnforced: [
        'not a hardware-virtualised boundary — a kernel escape defeats it',
        'the daemon runs as root on the host unless rootless mode is configured',
        'image contents are trusted; a compromised base image is out of scope',
      ],
    };
  }

  async run(contractId: string, options: SandboxOptions = {}): Promise<SandboxExecutionResult> {
    const startedAt = Date.now();
    const sandboxId = `sbx_docker_${contractId}_${startedAt}`;
    const timeoutMs = options.timeoutMs ?? 120_000;
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
      return fail('Docker daemon not reachable. Tests could not be executed.');
    }

    // Clone into a scratch dir when a repo is given; otherwise use workDir.
    let codeDir = options.workDir;
    let cloned: string | undefined;

    try {
      if (options.repoUrl) {
        cloned = await mkdtemp(path.join(tmpdir(), 'assurecode-clone-'));
        const clone = await execFileCapture('git', ['clone', '--quiet', options.repoUrl, cloned], {
          timeoutMs: 60_000,
        });
        if (clone.code !== 0) return fail(`git clone failed: ${clone.stderr.slice(0, 300)}`);

        if (options.commitHash) {
          const checkout = await execFileCapture(
            'git',
            ['-C', cloned, 'checkout', '--quiet', options.commitHash],
            { timeoutMs: 30_000 },
          );
          if (checkout.code !== 0) {
            return fail(`git checkout ${options.commitHash} failed: ${checkout.stderr.slice(0, 300)}`);
          }
        }
        codeDir = cloned;
      }

      if (!codeDir) {
        return fail('Neither repoUrl nor workDir supplied; nothing to execute.');
      }
      try {
        await access(codeDir);
      } catch {
        return fail(`code directory does not exist: ${codeDir}`);
      }

      const args = [
        'run',
        '--rm',
        '--network=none',
        `--memory=${memoryLimitMb}m`,
        '--cpus=1',
        '--read-only',
        '--tmpfs',
        // exec is required: `npm ci` installs binaries under /tmp/app and the
        // test harness runs them. Docker's tmpfs default is noexec, so this is
        // stated explicitly rather than inherited.
        '/tmp:rw,exec,size=64m',
        '-v',
        `${codeDir}:/workspace:ro`,

        // ── Containment beyond the resource limits above ──────────────────
        //
        // memory and cpus bound how much a submission can consume; these bound
        // what it can *do*. Untrusted code from a stranger's repository runs
        // here, so the container gets no capabilities, no route to acquiring
        // any, no ability to fork the host into the ground, and no root.

        // A memory cap does not stop a fork bomb: each child is cheap, and the
        // pressure lands on the host's process table rather than on this
        // container's cgroup. 256 is far above anything `npm test` needs.
        '--pids-limit=256',

        // node:20-alpine ships uid/gid 1000 as `node`. Without this the
        // submission runs as root inside the container — and root inside a
        // container is one namespace escape away from root outside it.
        '--user=1000:1000',

        // Nothing here needs CAP_CHOWN, CAP_NET_RAW or the rest. Dropping all
        // of them is cheaper to reason about than auditing which are harmless.
        '--cap-drop=ALL',

        // Makes setuid binaries unable to gain privileges, which closes the
        // path back to root that --user alone leaves open.
        '--security-opt=no-new-privileges',

        // File-descriptor and process ceilings, so exhaustion inside the
        // sandbox stays inside it.
        '--ulimit',
        'nofile=1024:1024',
        '--ulimit',
        'nproc=256:256',

        // uid 1000's home is /home/node, which --read-only makes unwritable.
        // npm would fall back to writing a cache there and fail the install.
        // Both point at the tmpfs, which is the only writable path in the
        // container and is discarded when it exits.
        '--env',
        'HOME=/tmp',
        '--env',
        'npm_config_cache=/tmp/.npm',
      ];

      if (options.hiddenTestsPath) {
        args.push('-v', `${options.hiddenTestsPath}:/hidden-tests:ro`);
      }

      // Two shapes of run. A workspace built by workspace-builder.ts carries its
      // own dependency-free harness, so it is executed directly — `npm ci` there
      // would fail for want of a lockfile it has no reason to have. A cloned
      // repository is a real project and keeps the install-then-test path.
      const shellCommand = options.entrypoint
        ? 'cp -r /workspace /tmp/app && cd /tmp/app && ' +
          (options.hiddenTestsPath ? 'cp -r /hidden-tests/. /tmp/app/tests/ 2>/dev/null; ' : '') +
          `node ${shellQuote(options.entrypoint)} ${(options.entryArgs ?? []).map(shellQuote).join(' ')}`
        : // /workspace is read-only, so install into a writable overlay under /tmp.
          'cp -r /workspace /tmp/app && cd /tmp/app && ' +
          (options.hiddenTestsPath ? 'cp -r /hidden-tests/. /tmp/app/test/ 2>/dev/null; ' : '') +
          'npm ci --silent 2>/dev/null && npm test -- --json 2>/dev/null';

      args.push('-w', '/workspace', IMAGE, 'sh', '-c', shellCommand);

      const result = await execFileCapture('docker', args, { timeoutMs });
      const { passedTests, totalTests } = parseTestOutput(result.stdout);

      return {
        provisioned: !result.timedOut,
        sandboxId,
        runner: this.name,
        passedTests,
        totalTests,
        rawOutput: (result.stdout.trim() || result.stderr.trim()).slice(0, 20_000),
        exitCode: result.code,
        durationMs: Date.now() - startedAt,
        commitHash: options.commitHash,
        timedOut: result.timedOut,
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    } finally {
      if (cloned) await rm(cloned, { recursive: true, force: true }).catch(() => {});
    }
  }
}
