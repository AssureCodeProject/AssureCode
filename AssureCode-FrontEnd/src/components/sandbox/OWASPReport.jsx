import React from 'react';
import { ShieldAlert, ShieldCheck, AlertTriangle, Bug, Terminal, FileCode, CheckCircle2 } from 'lucide-react';
import { Badge } from '../common/Badge';

export function OWASPReport({ report }) {
  if (!report) return null;

  return (
    <div className="glass-panel rounded-2xl p-6 border border-slate-800 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <h3 className="text-base font-bold text-white">Dual-Layer OWASP 2025 Security Audit</h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Static Semgrep analysis coupled with Cloudflare Workers AI deep semantic vulnerability detection.
          </p>
        </div>

        {/* Severity Summary Pills */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-mono">
            <span className="font-bold">{report.summary.critical}</span> Critical
          </div>
          <div className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-mono">
            <span className="font-bold">{report.summary.high}</span> High
          </div>
          <div className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-mono">
            <span className="font-bold">{report.summary.medium}</span> Medium
          </div>
          <div className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-mono">
            <span className="font-bold">{report.summary.low}</span> Low
          </div>
        </div>
      </div>

      {/* Engine Info Box */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center justify-between">
          <span className="text-slate-400">Layer 1: Static Scanner</span>
          <span className="font-mono text-cyan-300 font-semibold">{report.engineVersions.staticScanner}</span>
        </div>
        <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center justify-between">
          <span className="text-slate-400">Layer 2: LLM Deep Auditor</span>
          <span className="font-mono text-purple-300 font-semibold">{report.engineVersions.llmDeepAuditor}</span>
        </div>
      </div>

      {/* Findings List */}
      <div className="space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Security Findings & Remediations ({report.findings?.length || 0})
        </div>

        {report.findings?.map((finding) => (
          <div
            key={finding.id}
            className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition-all space-y-3"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    finding.severity === 'CRITICAL' || finding.severity === 'HIGH'
                      ? 'danger'
                      : finding.severity === 'MEDIUM'
                      ? 'warning'
                      : 'cyan'
                  }
                  size="xs"
                >
                  {finding.severity}
                </Badge>
                <span className="text-xs font-mono text-indigo-400 font-semibold">{finding.cwe}</span>
                <h4 className="text-xs font-bold text-white">{finding.title}</h4>
              </div>

              <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
                <FileCode className="w-3.5 h-3.5 text-slate-500" />
                <span>{finding.file}:{finding.line}</span>
              </div>
            </div>

            {/* Code Snippet Box */}
            <div className="p-2.5 rounded-lg bg-[#070a12] border border-slate-800/80 font-mono text-xs text-rose-300">
              <code>{finding.codeSnippet}</code>
            </div>

            {/* Explanation & Remediation */}
            <div className="space-y-1 text-xs">
              <div className="text-slate-300 leading-relaxed">
                <span className="text-slate-500 font-semibold">Vulnerability Analysis: </span>
                {finding.explanation}
              </div>
              <div className="text-emerald-300 leading-relaxed">
                <span className="text-slate-500 font-semibold">Recommended Fix: </span>
                {finding.remediation}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
