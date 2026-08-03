/**
 * Sandbox composition root.
 *
 * Selection order is deliberate: Docker when a daemon is present because it is
 * the stronger boundary, otherwise the Node permission sandbox. The choice is
 * recorded on every result via `runner`, so a verification outcome always
 * carries the isolation strength it was produced under.
 *
 * Set SANDBOX_RUNNER=node|docker to pin one explicitly. Pinning a runner that
 * is unavailable is an error rather than a silent downgrade — a run that
 * quietly used weaker isolation than the operator asked for is exactly the kind
 * of unstated assumption this pipeline exists to eliminate.
 */
import { DockerSandbox } from './docker-sandbox.js';
import { NodePermissionSandbox } from './node-permission-sandbox.js';
import type { SandboxExecutionResult, SandboxOptions, SandboxRunner } from './types.js';

export { DockerSandbox } from './docker-sandbox.js';
export { NodePermissionSandbox } from './node-permission-sandbox.js';
export { parseTestOutput } from './types.js';
export type {
  SandboxExecutionResult,
  SandboxOptions,
  SandboxRunner,
  ThreatModel,
} from './types.js';

export async function selectSandboxRunner(preference?: string): Promise<SandboxRunner> {
  const docker = new DockerSandbox();
  const node = new NodePermissionSandbox();
  const requested = (preference ?? process.env.SANDBOX_RUNNER ?? '').toLowerCase();

  if (requested === 'docker') {
    if (!(await docker.isAvailable())) {
      throw new Error(
        'SANDBOX_RUNNER=docker was requested but no Docker daemon is reachable. ' +
          'Refusing to fall back silently to weaker isolation.',
      );
    }
    return docker;
  }

  if (requested === 'node') {
    if (!(await node.isAvailable())) {
      throw new Error(
        `SANDBOX_RUNNER=node was requested but Node ${process.versions.node} lacks ` +
          'module.registerHooks(); network egress could not be blocked. Node >= 22.15 required.',
      );
    }
    return node;
  }

  if (await docker.isAvailable()) return docker;
  return node;
}

/**
 * Run the contract's tests under whichever sandbox this host supports.
 *
 * A failure to provision returns `provisioned: false` with 0/0 tests, which the
 * settlement oracle reads as indeterminate — never as a pass.
 */
export async function runInSandbox(
  contractId: string,
  options: SandboxOptions = {},
): Promise<SandboxExecutionResult> {
  let runner: SandboxRunner;
  try {
    runner = await selectSandboxRunner();
  } catch (err) {
    return {
      provisioned: false,
      sandboxId: `sbx_${contractId}_${Date.now()}_unavailable`,
      runner: 'none',
      passedTests: 0,
      totalTests: 0,
      rawOutput: `[sandbox-unavailable] ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
      durationMs: 0,
      commitHash: options.commitHash,
      timedOut: false,
    };
  }
  return runner.run(contractId, options);
}
