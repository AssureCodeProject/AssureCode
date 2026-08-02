import { describe, it, expect } from 'vitest';
import { analyzeAST } from '../src/ast-analyzer.js';
import { performSecurityScan } from '../src/security-auditor.js';
import { runInSandbox } from '../src/sandbox-runner.js';
import { processCodePush } from '../src/worker.js';

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

  it('provisions sandbox runner successfully', async () => {
    const res = await runInSandbox('c123', { networkDisabled: true });
    expect(res.provisioned).toBe(true);
    expect(res.passedTests).toBe(5);
  });

  it('executes full processCodePush pipeline without errors', async () => {
    await expect(processCodePush('contract_test', 'corr_test')).resolves.not.toThrow();
  });
});
