/**
 * Dual-layer security scanner for untrusted code pushes.
 *
 *   Layer 1 — static pattern matching over the OWASP Top 10:2025 taxonomy.
 *             Deterministic, fast, no network. Rules live in
 *             packages/shared/src/owasp-2025-rules.json so this scanner and the
 *             Python one in apps/ai-service cannot drift apart.
 *
 *   Layer 2 — semantic review by an LLM, delegated to the ai-service
 *             /security-scan endpoint. Catches what patterns cannot: logic
 *             flaws, missing checks, unsafe designs that contain no
 *             characteristic token.
 *
 * The score is the published formula:
 *
 *     S_sec = max(0, 100 - 40*N_c - 20*N_h - 5*N_t)
 *
 * where N_c and N_h are critical and high counts and N_t is the total finding
 * count. Note that a critical finding is charged twice — once at 40 through
 * N_c and again at 5 through N_t — because N_t counts every finding including
 * the critical ones. That is what the published formula says, so it is what is
 * implemented; the double-count is documented rather than silently corrected.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ScanLayer = 'static' | 'llm';

export interface Vulnerability {
  type: string;
  category: string;
  severity: Severity;
  message: string;
  line?: number;
  layer: ScanLayer;
}

export interface SecurityScanResult {
  vulnerabilities: Vulnerability[];
  passed: boolean;
  score: number;
  /** Which layers actually contributed. An absent layer is never inferred. */
  layersRun: ScanLayer[];
  /** Set when Layer 2 was requested but could not run. */
  llmError?: string;
}

interface RuleSpec {
  type: string;
  category: string;
  severity: Severity;
  pattern: string;
  caseInsensitive: boolean;
  message: string;
}

interface RuleFile {
  taxonomyVersion: string;
  categories: Array<{ id: string; name: string }>;
  rules: RuleSpec[];
}

const require = createRequire(import.meta.url);

function loadRules(): RuleFile {
  // Resolve through the workspace package so this works from src/ under vitest
  // and from dist/ under node, without a relative path that differs between them.
  const rulesPath = require.resolve('@assurecode/shared/owasp-2025-rules.json');
  return JSON.parse(readFileSync(rulesPath, 'utf8')) as RuleFile;
}

const RULE_FILE: RuleFile = loadRules();

export const OWASP_TAXONOMY_VERSION = RULE_FILE.taxonomyVersion;
export const OWASP_CATEGORIES = RULE_FILE.categories;

const COMPILED = RULE_FILE.rules.map((rule) => ({
  spec: rule,
  regex: new RegExp(rule.pattern, rule.caseInsensitive ? 'i' : ''),
}));

/**
 * Layer 1: deterministic static scan.
 *
 * Scans line by line so findings carry a line number. Rules whose pattern spans
 * a construct larger than one line (an empty catch block, say) are also tried
 * against the whole source, with the match's line recovered from its offset.
 */
export function performStaticScan(codeString: string): Vulnerability[] {
  const findings: Vulnerability[] = [];
  const seen = new Set<string>();

  const record = (spec: RuleSpec, line: number) => {
    const key = `${spec.type}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      type: spec.type,
      category: spec.category,
      severity: spec.severity,
      message: spec.message,
      line,
      layer: 'static',
    });
  };

  const lines = codeString.split('\n');

  for (const { spec, regex } of COMPILED) {
    // Per-line pass: precise line attribution for single-line patterns.
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) record(spec, i + 1);
    }

    // Whole-source pass: catches constructs that straddle a newline.
    const wholeSource = new RegExp(spec.pattern, spec.caseInsensitive ? 'is' : 's');
    const match = wholeSource.exec(codeString);
    if (match && match.index >= 0) {
      const line = codeString.slice(0, match.index).split('\n').length;
      record(spec, line);
    }
  }

  findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.type.localeCompare(b.type));
  return findings;
}

/** S_sec, per the published formula. See the note at the top of this file. */
export function computeSecurityScore(vulnerabilities: Vulnerability[]): number {
  const criticalCount = vulnerabilities.filter((v) => v.severity === 'CRITICAL').length;
  const highCount = vulnerabilities.filter((v) => v.severity === 'HIGH').length;
  const totalCount = vulnerabilities.length;
  return Math.max(0, 100 - criticalCount * 40 - highCount * 20 - totalCount * 5);
}

/**
 * Layer 1 only. Synchronous, offline, always available.
 *
 * `layersRun` reports exactly `['static']` so a caller can never mistake a
 * static-only result for a full dual-layer scan.
 */
export function performSecurityScan(codeString: string): SecurityScanResult {
  const vulnerabilities = performStaticScan(codeString);
  const criticalCount = vulnerabilities.filter((v) => v.severity === 'CRITICAL').length;
  const highCount = vulnerabilities.filter((v) => v.severity === 'HIGH').length;

  return {
    vulnerabilities,
    passed: criticalCount === 0 && highCount === 0,
    score: computeSecurityScore(vulnerabilities),
    layersRun: ['static'],
  };
}

export interface DualLayerOptions {
  /** Base URL of the ai-service exposing POST /security-scan. */
  aiServiceUrl: string;
  /**
   * Shared secret presented as `x-service-token`. ai-service rejects
   * unauthenticated calls to /security-scan outside development, so omitting
   * this against a configured deployment turns every Layer 2 call into a 401 —
   * which, without `requireLlmLayer`, degrades silently to a static-only scan.
   */
  serviceToken?: string;
  /** Abort the Layer 2 call after this many milliseconds. */
  timeoutMs?: number;
  /**
   * When true, a Layer 2 failure rejects instead of degrading to Layer 1.
   * Settlement paths should set this: silently scoring a contract on half a
   * scan is how an unavailable model becomes a clean bill of health.
   */
  requireLlmLayer?: boolean;
}

/**
 * Layers 1 and 2.
 *
 * If Layer 2 fails and `requireLlmLayer` is not set, the static findings are
 * returned with `layersRun: ['static']` and `llmError` populated. The result is
 * never presented as a completed dual-layer scan.
 */
export async function performDualLayerScan(
  codeString: string,
  options: DualLayerOptions,
): Promise<SecurityScanResult> {
  const staticFindings = performStaticScan(codeString);
  const { aiServiceUrl, serviceToken, timeoutMs = 30_000, requireLlmLayer = false } = options;

  let llmFindings: Vulnerability[] = [];
  let llmError: string | undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${aiServiceUrl.replace(/\/$/, '')}/security-scan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(serviceToken ? { 'x-service-token': serviceToken } : {}),
      },
      body: JSON.stringify({ code: codeString, include_static: false }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`ai-service /security-scan returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const body = (await res.json()) as { vulnerabilities?: Vulnerability[] };
    llmFindings = (body.vulnerabilities ?? []).map((v) => ({ ...v, layer: 'llm' as const }));
  } catch (err) {
    llmError = err instanceof Error ? err.message : String(err);
    if (requireLlmLayer) {
      throw new Error(`Layer 2 security scan unavailable and required: ${llmError}`);
    }
  } finally {
    clearTimeout(timer);
  }

  // Deduplicate: if both layers flag the same rule on the same line, keep the
  // static finding, which carries the precise rule identity.
  const staticKeys = new Set(staticFindings.map((v) => `${v.type}:${v.line}`));
  const merged = [
    ...staticFindings,
    ...llmFindings.filter((v) => !staticKeys.has(`${v.type}:${v.line}`)),
  ];

  const criticalCount = merged.filter((v) => v.severity === 'CRITICAL').length;
  const highCount = merged.filter((v) => v.severity === 'HIGH').length;

  return {
    vulnerabilities: merged,
    passed: criticalCount === 0 && highCount === 0,
    score: computeSecurityScore(merged),
    layersRun: llmError ? ['static'] : ['static', 'llm'],
    ...(llmError ? { llmError } : {}),
  };
}
