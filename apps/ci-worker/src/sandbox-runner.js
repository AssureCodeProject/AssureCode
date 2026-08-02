import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

function parseTestOutput(stdout) {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.numPassedTests === 'number') {
        return {
          passedTests: Number(parsed.numPassedTests),
          totalTests: Number(
            parsed.numTotalTests ?? parsed.numPassedTests + (parsed.numFailedTests ?? 0),
          ),
        };
      }
      if (typeof parsed.passed === 'number' && typeof parsed.total === 'number') {
        return { passedTests: Number(parsed.passed), totalTests: Number(parsed.total) };
      }
    } catch {}
  }
  return { passedTests: 0, totalTests: 0 };
}

export async function runInSandbox(contractId, options = {}) {
  const sandboxId = `sbx_${contractId}_${Date.now()}`;
  const networkFlag = options.networkDisabled ? '--network=none' : '';

  try {
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
  } catch (err) {
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
