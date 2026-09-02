import React from 'react';
import { XCircle, AlertTriangle, Bug } from 'lucide-react';

import { StatusBadge } from './ui/StatusBadge';

const SEVERITY_VARIANT = {
  CRITICAL: 'danger',
  HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'neutral',
};

/**
 * AuditFindingsDetail — the specific, actionable findings behind the
 * aggregate audit numbers: which hidden tests failed and why, which
 * functions are too complex, which security findings were flagged and
 * where. Every contract's requirements differ, so a generic "improve your
 * code" message tells a freelancer nothing; this is the same per-item
 * detail the pipeline already measures (test-harness.cjs, ast-analyzer.ts,
 * security-auditor.ts) surfaced instead of collapsed to counts.
 *
 * Each section renders only when its array is non-empty -- a contract with
 * no findings in a category shows nothing for it, not an empty panel.
 */
export function AuditFindingsDetail({ testFailures, complexFunctions, vulnerabilityDetails }) {
  const hasTestFailures = Array.isArray(testFailures) && testFailures.length > 0;
  const hasComplexFunctions = Array.isArray(complexFunctions) && complexFunctions.length > 0;
  const hasVulnerabilities = Array.isArray(vulnerabilityDetails) && vulnerabilityDetails.length > 0;

  if (!hasTestFailures && !hasComplexFunctions && !hasVulnerabilities) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 font-mono text-xs text-prose-muted uppercase tracking-wider border-b border-rule pb-2">
        <Bug className="w-4 h-4 text-signal" />
        <span>What to fix</span>
      </div>

      {hasTestFailures && (
        <div className="bg-ink-2 border border-rule p-5 font-mono">
          <div className="flex items-center gap-2 text-fail text-xs uppercase tracking-wider mb-3">
            <XCircle className="w-4 h-4" />
            <span>Failing Hidden Tests ({testFailures.length})</span>
          </div>
          <div className="space-y-3">
            {testFailures.map((t, i) => (
              <div key={i} className="bg-ink border border-rule p-3">
                <p className="text-xs text-prose font-semibold font-sans">{t.name}</p>
                <p className="text-[11px] text-prose-muted mt-1 font-sans break-words">{t.message}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasComplexFunctions && (
        <div className="bg-ink-2 border border-rule p-5 font-mono">
          <div className="flex items-center gap-2 text-warn text-xs uppercase tracking-wider mb-3">
            <AlertTriangle className="w-4 h-4" />
            <span>High-Complexity Functions ({complexFunctions.length})</span>
          </div>
          <p className="text-[11px] text-prose-muted mb-3 font-sans">
            Consider splitting these into smaller functions — each one has more independent decision
            paths than a reviewer (or a maintainability score) can easily follow.
          </p>
          <div className="space-y-2">
            {complexFunctions.map((fn, i) => (
              <div key={i} className="flex items-center justify-between bg-ink border border-rule p-3">
                <span className="text-xs text-prose font-sans">
                  <span className="font-semibold">{fn.name || '(anonymous)'}</span>
                  <span className="text-prose-muted"> — line {fn.line}</span>
                </span>
                <span className="text-xs font-bold text-warn shrink-0 ml-3">
                  complexity {fn.cyclomaticComplexity}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasVulnerabilities && (
        <div className="bg-ink-2 border border-rule p-5 font-mono">
          <div className="flex items-center gap-2 text-fail text-xs uppercase tracking-wider mb-3">
            <Bug className="w-4 h-4" />
            <span>Security Findings ({vulnerabilityDetails.length})</span>
          </div>
          <div className="space-y-2">
            {vulnerabilityDetails.map((v, i) => (
              <div key={i} className="bg-ink border border-rule p-3">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <StatusBadge variant={SEVERITY_VARIANT[v.severity] || 'neutral'} size="sm">
                    {v.severity}
                  </StatusBadge>
                  <span className="text-[11px] text-prose-muted">{v.category}</span>
                  {v.line !== undefined && v.line !== null && (
                    <span className="text-[11px] text-prose-dim">line {v.line}</span>
                  )}
                </div>
                <p className="text-xs text-prose font-sans mt-1 break-words">{v.message}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default AuditFindingsDetail;
