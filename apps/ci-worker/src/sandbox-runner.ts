import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface SandboxOptions {
  repoUrl?: string;
  commitHash?: string;
  networkDisabled?: boolean;
  timeoutMs?: number;
}

export interface SandboxExecutionResult {
  provisioned: boolean;
  sandboxId: string;
  passedTests: number;
  totalTests: number;
  rawOutput: string;
  exitCode: number;
}

/**
 * BUG-003: Parse JSON test-runner output (Jest / Vitest) to extract real counts.
 * Returns { 0, 0 } when output is unparseable — signals the oracle that test
 * status is indeterminate (NOT a pass).
 */
function parseTestOutput(stdout: string): { passedTests: number; totalTests: number } {
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
      // Not valid JSON — continue scanning
    }
  }
  return { passedTests: 0, totalTests: 0 };
}

export async function runInSandbox(
  contractId: string,
  options: SandboxOptions = {},
): Promise<SandboxExecutionResult> {
  const sandboxId = `sbx_${contractId}_${Date.now()}`;
  const networkFlag = options.networkDisabled ? '--network=none' : '';

  try {
    // BUG-003: Run the actual test suite and parse real results.
    // The container image must contain the project source and test runner.
    // `--json` / `--reporter=json` produces machine-parseable output on stdout.
    const cmd = [
      'docker run --rm',
      networkFlag,
      '--memory=512m --cpus=1',
      'node:20-alpine',
      `sh -c "npm ci --silent 2>/dev/null && npm test -- --json 2>/dev/null"`,
    ]
      .filter(Boolean)
      .join(' ');

    const { stdout, stderr } = await execAsync(cmd, {
      timeout: options.timeoutMs || 60_000,
    });

    const { passedTests, totalTests } = parseTestOutput(stdout);

    return {
      provisioned: true,
      sandboxId,
      passedTests,
      totalTests,
      rawOutput: stdout.trim() || stderr.trim(),
      exitCode: 0,
    };
  } catch (err: any) {
    // Docker daemon unavailable or container failed to start.
    // Do NOT auto-pass: returning 0/0 tells the oracle tests are indeterminate.
    return {
      provisioned: false,
      sandboxId: `${sandboxId}_unavailable`,
      passedTests: 0,
      totalTests: 0,
      rawOutput: `[sandbox-unavailable] ${err?.message ?? 'Docker daemon not reachable. Tests could not be executed.'}`,
      exitCode: 1,
    };
  }
}
