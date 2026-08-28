/**
 * The sandbox port.
 *
 * Objective 2 requires an ephemeral zero-trust pipeline that evaluates
 * untrusted code. Which isolation primitive provides that is a deployment
 * concern, not a pipeline concern, so it sits behind this interface — the same
 * composition-root pattern the Python service uses for Embedder, RagStore and
 * LlmClient.
 *
 * Two adapters ship:
 *
 *   NodePermissionSandbox — Node's permission model plus an egress guard.
 *     Runs anywhere Node >= 22.15 does, including hardware that cannot host a
 *     container runtime.
 *
 *   DockerSandbox — a container with --network=none. Stronger isolation where
 *     a daemon is available.
 *
 * Each adapter declares its own threat model in `describeThreatModel()`, and
 * the result records which adapter produced it. A verification result that
 * cannot say what isolated it is not evidence of anything.
 */

export interface SandboxOptions {
  /** Repository to clone. When absent, `workDir` must already hold the code. */
  repoUrl?: string;
  /** Commit to check out. Recorded in the result for auditability. */
  commitHash?: string;
  /**
   * Directory holding the code under test, used when repoUrl is absent.
   * Hidden tests, when present, are already written into this same tree by
   * workspace-builder.ts before the sandbox runs — there is no separate
   * hidden-tests mount.
   */
  workDir?: string;
  /**
   * Entry script the sandbox executes, relative to `workDir`. Defaults to the
   * harness the workspace builder writes.
   *
   * This replaced a `command: string[]` shaped like an npm invocation
   * (`['npm','test','--','--reporter=json']`). Nothing could run it as written:
   * the runner is invoked directly as a Node entrypoint because child processes
   * are denied, and the old code dropped `command[0]` and passed the remaining
   * `['test', ...]` as arguments — so `test` was read as a filename filter.
   */
  entrypoint?: string;
  /** Arguments passed to `entrypoint`. */
  entryArgs?: string[];
  timeoutMs?: number;
  /** Memory ceiling in megabytes. */
  memoryLimitMb?: number;
}

export interface SandboxExecutionResult {
  /** False when the sandbox could not be established. Never means "passed". */
  provisioned: boolean;
  sandboxId: string;
  /** Which adapter ran, so a result is always attributable. */
  runner: string;
  passedTests: number;
  totalTests: number;
  rawOutput: string;
  exitCode: number;
  durationMs: number;
  commitHash?: string;
  /** True when the process was killed for exceeding its time budget. */
  timedOut: boolean;
  /**
   * The isolation guarantees `runner` actually provided, attached by
   * runInSandbox() from the selected adapter's describeThreatModel() (or a
   * "nothing was provisioned" stand-in when selection itself failed). Carried
   * through into audit_results by worker.ts so a settlement decision's
   * isolation strength is part of the durable record, not only a log line.
   *
   * Optional here (not on every adapter's own construction of this type) —
   * runInSandbox() is the one place that attaches it, so an individual
   * adapter's run() is not required to know about it.
   */
  threatModel?: ThreatModel;
}

export interface ThreatModel {
  /** Human-readable adapter name. */
  runner: string;
  /** Controls this adapter actually enforces. */
  enforced: string[];
  /** Controls it does NOT enforce — stated so the paper can quote them. */
  notEnforced: string[];
}

export interface SandboxRunner {
  readonly name: string;
  /** Whether this adapter can run on the current host, checked cheaply. */
  isAvailable(): Promise<boolean>;
  run(contractId: string, options?: SandboxOptions): Promise<SandboxExecutionResult>;
  describeThreatModel(): ThreatModel;
}

/**
 * Parse JSON test-runner output (Jest / Vitest) into real counts.
 *
 * Returns { 0, 0 } when the output cannot be parsed. That is the indeterminate
 * signal, and the settlement oracle must treat it as "unknown", never as a
 * pass — zero of zero tests passing is not a passing build. This contract was
 * correct in the original implementation and is preserved verbatim.
 */
export function parseTestOutput(stdout: string): { passedTests: number; totalTests: number } {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      // Jest JSON reporter: { numPassedTests, numFailedTests, numTotalTests }
      if (typeof parsed.numPassedTests === 'number') {
        return {
          passedTests: Number(parsed.numPassedTests),
          totalTests: Number(
            parsed.numTotalTests ?? parsed.numPassedTests + (parsed.numFailedTests ?? 0),
          ),
        };
      }
      // Vitest JSON: { passed, failed, total }
      if (typeof parsed.passed === 'number' && typeof parsed.total === 'number') {
        return { passedTests: Number(parsed.passed), totalTests: Number(parsed.total) };
      }
    } catch {
      // Not valid JSON — keep scanning.
    }
  }
  return { passedTests: 0, totalTests: 0 };
}
