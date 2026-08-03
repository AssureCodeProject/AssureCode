import { describe, it, expect } from 'vitest';
import { analyzeAST } from '../src/ast-analyzer.js';
import { performSecurityScan } from '../src/security-auditor.js';
import { runInSandbox } from '../src/sandbox-runner.js';
import { processCodePush } from '../src/worker.js';
import { dockerAvailable, announceSkip } from '../../../tools/test-support/infra.js';

const DOCKER_UP = dockerAvailable();
if (!DOCKER_UP) announceSkip('sandbox provisioning', 'a running Docker daemon');

describe('ci-worker modules', () => {
  it('analyzes AST cyclomatic complexity and maintainability index', () => {
    const code = `
      function test(a, b) {
        if (a > b) {
          return a;
        } else if (b > a) {
          return b;
        }
        return 0;
      }
    `;
    const res = analyzeAST(code);
    expect(res.cyclomaticComplexity).toBeGreaterThan(1);
    expect(res.maintainabilityIndex).toBeGreaterThan(0);
    expect(res.functionCount).toBe(1);
  });

  it('detects OWASP security vulnerabilities in code', () => {
    const vulnerableCode = `
      const apiKey = "api_key=123456789012345678";
      eval("console.log('danger')");
    `;
    const scan = performSecurityScan(vulnerableCode);
    expect(scan.passed).toBe(false);
    expect(scan.vulnerabilities.length).toBeGreaterThanOrEqual(1);
    expect(scan.vulnerabilities.some((v) => v.type === 'DYNAMIC_CODE_EXECUTION' || v.type === 'HARDCODED_SECRET')).toBe(true);
  });

  it.skipIf(!DOCKER_UP)('provisions sandbox runner successfully', async () => {
    const res = await runInSandbox('c123', { networkDisabled: true });
    expect(res.provisioned).toBe(true);
  });

  it.skipIf(DOCKER_UP)('reports the sandbox as unprovisioned when Docker is absent', async () => {
    // The honest failure mode: no daemon means no isolation, so the runner must
    // say so rather than return a result that looks like a passing test run.
    const res = await runInSandbox('c123', { networkDisabled: true });
    expect(res.provisioned).toBe(false);
  });

  it('executes full processCodePush pipeline without errors', async () => {
    await expect(processCodePush('contract_test', 'corr_test')).resolves.not.toThrow();
  });
});
