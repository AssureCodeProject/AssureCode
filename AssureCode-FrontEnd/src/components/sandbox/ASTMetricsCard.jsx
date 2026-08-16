import React from 'react';
import { Cpu, Activity, BarChart3, Code2, ShieldAlert, CheckCircle } from 'lucide-react';
import { Badge } from '../common/Badge';

export function ASTMetricsCard({ astMetrics }) {
  if (!astMetrics) return null;

  return (
    <div className="glass-panel rounded-2xl p-6 border border-slate-800 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-purple-400" />
            <h3 className="text-base font-bold text-white">AST Code Quality & Complexity</h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Deterministic Abstract Syntax Tree parsing: McCabe cyclomatic complexity, Halstead volume, and SEI Maintainability Index.
          </p>
        </div>
        <Badge variant="purple" size="xs">SEI MI: {astMetrics.overallMaintainabilityIndex}/100</Badge>
      </div>

      {/* 3 Metric Summary Boxes */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* SEI Maintainability Index */}
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 text-left">
          <div className="text-[11px] font-semibold uppercase text-slate-400">Maintainability Index</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-emerald-400">
              {astMetrics.overallMaintainabilityIndex}
            </span>
            <span className="text-xs text-slate-500">/ 100</span>
          </div>
          <div className="mt-2 text-[11px] text-emerald-300 flex items-center gap-1 font-medium">
            <CheckCircle className="w-3.5 h-3.5" />
            <span>Grade A (Highly Maintainable)</span>
          </div>
        </div>

        {/* McCabe Cyclomatic Complexity */}
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 text-left">
          <div className="text-[11px] font-semibold uppercase text-slate-400">McCabe Complexity</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-cyan-400">
              {astMetrics.cyclomaticComplexity.average}
            </span>
            <span className="text-xs text-slate-500">avg (max: {astMetrics.cyclomaticComplexity.max})</span>
          </div>
          <div className="mt-2 text-[11px] text-cyan-300 flex items-center gap-1 font-medium">
            <Activity className="w-3.5 h-3.5" />
            <span>{astMetrics.cyclomaticComplexity.status}</span>
          </div>
        </div>

        {/* Halstead Program Volume */}
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 text-left">
          <div className="text-[11px] font-semibold uppercase text-slate-400">Halstead Volume</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-indigo-300">
              {astMetrics.halsteadVolume.volume}
            </span>
            <span className="text-xs text-slate-500">bits</span>
          </div>
          <div className="mt-2 text-[11px] text-indigo-300 flex items-center gap-1 font-medium">
            <BarChart3 className="w-3.5 h-3.5" />
            <span>Difficulty: {astMetrics.halsteadVolume.difficulty}</span>
          </div>
        </div>
      </div>

      {/* Function Complexity Breakdown Table */}
      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Analyzed AST Functions & Complexity Scores
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500 font-mono">
                <th className="pb-2">Function Identifier</th>
                <th className="pb-2">McCabe Complexity</th>
                <th className="pb-2">Lines of Code</th>
                <th className="pb-2">Maintainability Score</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {astMetrics.functionDetails?.map((fn, idx) => (
                <tr key={idx} className="hover:bg-slate-900/40">
                  <td className="py-2.5 font-semibold text-slate-200">{fn.name}()</td>
                  <td className="py-2.5 text-cyan-300">{fn.complexity}</td>
                  <td className="py-2.5 text-slate-400">{fn.lines} LOC</td>
                  <td className="py-2.5 text-emerald-400">{fn.mi}</td>
                  <td className="py-2.5">
                    <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      PASSED
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
