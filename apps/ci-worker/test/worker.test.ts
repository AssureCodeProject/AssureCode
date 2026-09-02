import { describe, it, expect } from 'vitest';
import { analyzeAST } from '../src/ast-analyzer.js';
import { performSecurityScan } from '../src/security-auditor.js';
import { runInSandbox, selectSandboxRunner } from '../src/sandbox-runner.js';
import { processCodePush } from '../src/worker.js';
import { InMemoryAuditStore, type AuditStore } from '../src/audit-store.js';
import { createEventBus } from '@assurecode/event-bus';
import { EVENT_TOPICS } from '@assurecode/shared';

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

  it('selects a sandbox runner on this host', async () => {
    // Docker where a daemon exists, the Node permission model otherwise. One of
    // the two must always be available, so selection never legitimately fails.
    //
    // DockerSandbox.isAvailable() gives its own `docker info` probe up to 5s
    // internally (docker-sandbox.ts). Vitest's default test timeout is also
    // 5000ms, with zero margin between them — under CI load (this suite runs
    // alongside the Integration Suite pulling Docker images concurrently), the
    // outer test timeout can fire a hair before the inner probe would have
    // resolved on its own, failing a test that was never actually broken. This
    // call can run twice (selectSandboxRunner + isAvailable below), so the test
    // timeout needs headroom for two 5s probes, not one.
    const runner = await selectSandboxRunner();
    expect(['docker', 'node-permission']).toContain(runner.name);
    expect(await runner.isAvailable()).toBe(true);
  }, 15_000);

  it('records which runner produced a result', async () => {
    const res = await runInSandbox('c123', {});
    expect(res.runner).toBeTruthy();
    // No workDir was supplied, so this must not claim to have run anything.
    expect(res.provisioned).toBe(false);
    expect(res.totalTests).toBe(0);
  });

  it('refuses to emit audit telemetry when no code was submitted', async () => {
    // Previously this fell back to a hardcoded sample and published complexity
    // and security numbers for code the freelancer never wrote.
    await expect(processCodePush('contract_test', 'corr_test')).rejects.toThrow(/No code supplied/);
  });
});

describe('audit persistence', () => {
  const code = 'function add(a, b) { return a + b; }';

  it('persists the audit payload with severity counts', async () => {
    const store = new InMemoryAuditStore();
    await processCodePush('c-persist', 'corr-1', code, { auditStore: store });

    expect(store.saved).toHaveLength(1);
    const saved = store.saved[0];
    expect(saved.contractId).toBe('c-persist');
    // criticalVulns is what the settlement gate reads; a total count cannot
    // answer `criticalVulns === 0`.
    expect(saved).toHaveProperty('criticalVulns');
    expect(saved).toHaveProperty('highVulns');
    expect(saved.criticalVulns).toBeTypeOf('number');
    expect(saved.maintainability).toBeGreaterThan(0);

    // The isolation strength a settlement decision rests on must be part of
    // the durable record, not only a log line — see sandbox/index.ts's
    // runInSandbox() and audit-store.ts's AuditPayload.
    expect(saved.sandboxRunner).toBeTruthy();
    expect(['docker', 'node-permission', 'none']).toContain(saved.sandboxRunner);
    expect(saved.threatModel.runner).toBe(saved.sandboxRunner);
    expect(Array.isArray(saved.threatModel.enforced)).toBe(true);
    expect(Array.isArray(saved.threatModel.notEnforced)).toBe(true);
    // Not a simulate-push run (no `demo` option passed) -- must be recorded
    // as such so a real audit is never mistaken for the demo snippet's fixed
    // result, or vice versa (see contracts-audit.ts's simulate-push guard).
    expect(saved.demo).toBe(false);
  });

  it('marks a simulate-push run as demo in the persisted payload', async () => {
    const store = new InMemoryAuditStore();
    await processCodePush('c-demo-flag', 'corr-demo', code, { auditStore: store, demo: true });

    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].demo).toBe(true);
  });

  it('captures which specific hidden tests failed and why', async () => {
    // Subtracts instead of adding -- fails 3 of the demo suite's 5 real
    // assertions (DEMO_TEST_BUNDLE in workspace-builder.ts), so this is a
    // genuine mixed pass/fail run, not every case failing the same way.
    const buggyAdd = 'function add(a, b) { return a - b; } module.exports = { add };';
    const store = new InMemoryAuditStore();
    await processCodePush('c-test-failures', 'corr-fail', buggyAdd, { auditStore: store, demo: true });

    expect(store.saved).toHaveLength(1);
    const saved = store.saved[0];
    expect(saved.testFailures).toBeDefined();
    expect(saved.testFailures!.length).toBeGreaterThan(0);
    expect(saved.testFailures!.length).toBeLessThan(saved.totalTests);
    for (const failure of saved.testFailures!) {
      expect(failure.name).toBeTypeOf('string');
      expect(failure.name.length).toBeGreaterThan(0);
      expect(failure.message).toBeTypeOf('string');
      expect(failure.message.length).toBeGreaterThan(0);
    }
  });

  it('captures the worst-offending functions by cyclomatic complexity', async () => {
    const complexCode = `
      function add(a, b) { return a + b; }
      module.exports = { add };
      function classify(x) {
        if (x === 1) return 'a';
        if (x === 2) return 'b';
        if (x === 3) return 'c';
        if (x === 4) return 'd';
        if (x === 5) return 'e';
        if (x === 6) return 'f';
        if (x === 7) return 'g';
        if (x === 8) return 'h';
        if (x === 9) return 'i';
        if (x === 10) return 'j';
        if (x === 11) return 'k';
        return 'z';
      }
    `;
    const store = new InMemoryAuditStore();
    await processCodePush('c-complex-fn', 'corr-complex', complexCode, { auditStore: store, demo: true });

    expect(store.saved).toHaveLength(1);
    const saved = store.saved[0];
    expect(saved.complexFunctions).toBeDefined();
    expect(saved.complexFunctions!.length).toBeGreaterThan(0);
    const classify = saved.complexFunctions!.find((fn) => fn.name === 'classify');
    expect(classify).toBeDefined();
    expect(classify!.cyclomaticComplexity).toBeGreaterThan(10);
    // Sorted worst-first.
    for (let i = 1; i < saved.complexFunctions!.length; i++) {
      expect(saved.complexFunctions![i - 1].cyclomaticComplexity).toBeGreaterThanOrEqual(
        saved.complexFunctions![i].cyclomaticComplexity,
      );
    }
  });

  it('captures which specific security findings were flagged and where', async () => {
    const vulnerableCode = `
      function add(a, b) { return a + b; }
      module.exports = { add };
      const apiKey = "api_key=123456789012345678";
      eval("console.log('danger')");
    `;
    const store = new InMemoryAuditStore();
    await processCodePush('c-vuln-detail', 'corr-vuln', vulnerableCode, { auditStore: store, demo: true });

    expect(store.saved).toHaveLength(1);
    const saved = store.saved[0];
    expect(saved.vulnerabilityDetails).toBeDefined();
    expect(saved.vulnerabilityDetails!.length).toBeGreaterThan(0);
    expect(saved.vulnerabilityDetails!.length).toBe(saved.vulnerabilities);
    for (const finding of saved.vulnerabilityDetails!) {
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(finding.severity);
      expect(finding.type).toBeTypeOf('string');
      expect(finding.message.length).toBeGreaterThan(0);
    }
  });

  it('cannot report a pass when the Layer 2 security scan did not run', async () => {
    // ai-service is unreachable in this suite, so the dual-layer scan degrades
    // to Layer 1. "No findings" from half a scan is not the same claim as no
    // findings, and must not be able to release money — so `passed` stays
    // false and the degradation is recorded rather than being invisible.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    try {
      const store = new InMemoryAuditStore();
      await processCodePush('c-halfscan', 'corr-3', code, { auditStore: store });

      const saved = store.saved[0] as unknown as {
        securityScanComplete: boolean;
        layersRun: string[];
        passed: boolean;
      };
      expect(saved.securityScanComplete).toBe(false);
      expect(saved.layersRun).toEqual(['static']);
      expect(saved.passed).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not publish AUDIT_COMPLETED when the audit cannot be persisted', async () => {
    // The invariant: the oracle must never ingest signals for an audit the
    // score endpoint has no record of. If the write fails, nothing is emitted.
    const published: string[] = [];
    const bus = createEventBus('');
    await bus.subscribe(EVENT_TOPICS.AUDIT_COMPLETED, async () => {
      published.push('audit');
    });

    const failing: AuditStore = {
      async save() {
        throw new Error('database is down');
      },
    };

    await expect(
      processCodePush('c-failstore', 'corr-2', code, { auditStore: failing }),
    ).rejects.toThrow(/database is down/);
    expect(published).toHaveLength(0);
  });
});
