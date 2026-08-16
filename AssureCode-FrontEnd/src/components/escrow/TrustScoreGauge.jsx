import React from 'react';
import { Award, ShieldCheck, CheckCircle2, AlertTriangle, HelpCircle } from 'lucide-react';
import { SETTLEMENT_SCORE_THRESHOLD } from '../../utils/trustScoreModel';
import { Badge } from '../common/Badge';

export function TrustScoreGauge({ trustScoreData }) {
  if (!trustScoreData) return null;

  const { score, isApproved, components, formula } = trustScoreData;
  const isPassing = score >= SETTLEMENT_SCORE_THRESHOLD;

  return (
    <div className="glass-panel rounded-2xl p-6 border border-slate-800 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <Award className="w-5 h-5 text-indigo-400" />
            <h3 className="text-base font-bold text-white">Deterministic Trust Score Model</h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5 font-mono">
            {formula}
          </p>
        </div>

        <Badge variant={isPassing ? 'success' : 'danger'}>
          {isPassing ? 'Oracle Approved (≥ 85)' : 'Settlement Blocked (< 85)'}
        </Badge>
      </div>

      {/* Main Score Display & Factors */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-center">
        {/* Big Score Gauge */}
        <div className="p-6 rounded-2xl bg-gradient-to-b from-slate-900 to-[#070a12] border border-slate-800 text-center space-y-3 relative overflow-hidden">
          <div className="relative z-10">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Overall Trust Score
            </div>
            <div className="mt-2 flex items-baseline justify-center gap-1 font-mono">
              <span className={`text-5xl font-black ${isPassing ? 'text-emerald-400' : 'text-rose-400'}`}>
                {score}
              </span>
              <span className="text-sm text-slate-500 font-semibold">/ 100</span>
            </div>
            <div className="mt-2 text-xs font-semibold flex items-center justify-center gap-1 text-slate-300">
              {isApproved ? (
                <span className="text-emerald-400 flex items-center gap-1">
                  <ShieldCheck className="w-4 h-4" />
                  Escrow Payout Authorized
                </span>
              ) : (
                <span className="text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="w-4 h-4" />
                  Gated by Settlement Oracle
                </span>
              )}
            </div>
          </div>

          <div
            className={`absolute inset-0 opacity-10 blur-2xl ${
              isPassing ? 'bg-emerald-500' : 'bg-rose-500'
            }`}
          />
        </div>

        {/* 4 Factor Contribution Bars */}
        <div className="lg:col-span-2 space-y-3.5">
          {/* Factor 1: Test Suite Pass Rate */}
          <div className="space-y-1 text-xs">
            <div className="flex justify-between text-slate-300">
              <span className="font-semibold flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-cyan-400" />
                1. Hidden Test Suite Pass Rate (35%)
              </span>
              <span className="font-mono text-cyan-300 font-bold">
                {components.tests.score}/100 (+{components.tests.weightedContribution} pts)
              </span>
            </div>
            <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
              <div
                className="h-full bg-cyan-400 rounded-full transition-all duration-500"
                style={{ width: `${components.tests.score}%` }}
              />
            </div>
          </div>

          {/* Factor 2: AST Maintainability Index */}
          <div className="space-y-1 text-xs">
            <div className="flex justify-between text-slate-300">
              <span className="font-semibold flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-purple-400" />
                2. AST Maintainability Index (25%)
              </span>
              <span className="font-mono text-purple-300 font-bold">
                {components.maintainability.score}/100 (+{components.maintainability.weightedContribution} pts)
              </span>
            </div>
            <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
              <div
                className="h-full bg-purple-400 rounded-full transition-all duration-500"
                style={{ width: `${components.maintainability.score}%` }}
              />
            </div>
          </div>

          {/* Factor 3: OWASP Security Audit */}
          <div className="space-y-1 text-xs">
            <div className="flex justify-between text-slate-300">
              <span className="font-semibold flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                3. OWASP 2025 Security Scan (25%)
              </span>
              <span className="font-mono text-emerald-300 font-bold">
                {components.security.score}/100 (+{components.security.weightedContribution} pts)
              </span>
            </div>
            <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
              <div
                className="h-full bg-emerald-400 rounded-full transition-all duration-500"
                style={{ width: `${components.security.score}%` }}
              />
            </div>
          </div>

          {/* Factor 4: Scope Adherence */}
          <div className="space-y-1 text-xs">
            <div className="flex justify-between text-slate-300">
              <span className="font-semibold flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-indigo-400" />
                4. Scope Guard Adherence (15%)
              </span>
              <span className="font-mono text-indigo-300 font-bold">
                {components.scope.score}/100 (+{components.scope.weightedContribution} pts)
              </span>
            </div>
            <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
              <div
                className="h-full bg-indigo-400 rounded-full transition-all duration-500"
                style={{ width: `${components.scope.score}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
