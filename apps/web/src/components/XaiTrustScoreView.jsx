import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  ShieldCheck,
  Target,
  Layers,
  Bug,
  BrainCircuit,
  ChevronRight,
  TrendingUp,
  Cpu,
  Clock,
} from 'lucide-react';
import RadialGauge from './ui/RadialGauge';
import StatusBadge from './ui/StatusBadge';
import { mockXaiData } from '../data/mockXaiData';

export function XaiTrustScoreView({ contractData, onProceedToEscrow }) {
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [showAuditTrail, setShowAuditTrail] = useState(true);

  const [data, setData] = useState(mockXaiData);

  useEffect(() => {
    if (!contractData?.contractId) return;
    let cancelled = false;

    fetch(`/api/contracts/${contractData.contractId}/score`)
      .then((res) => {
        if (!res.ok) throw new Error(`XAI score fetch failed: ${res.status}`);
        return res.json();
      })
      .then((apiData) => {
        if (cancelled) return;
        const scoreVal = apiData?.trustScore;
        setData((prev) => ({
          ...prev,
          score: Math.round((scoreVal ?? (prev.score / 100)) * 100),
          status:
            scoreVal != null && scoreVal >= 0.9
              ? 'TRUSTED_FREELANCER'
              : scoreVal != null && scoreVal >= 0.7
              ? 'CONDITIONALLY_TRUSTED'
              : 'PENDING_REVIEW',
          lastEvaluated: apiData.scoredAt || prev.lastEvaluated,
          ...(apiData.justifications?.length > 0 && {
            auditLog: apiData.justifications.map((j, i) => ({
              id: `LOG-${String(i + 1).padStart(3, '0')}`,
              action: 'XAI Score Factor',
              timestamp: apiData.scoredAt || new Date().toISOString(),
              rationale: j,
              agent: 'XAI-Engine',
              scoreDelta: 0,
              newScore: Math.round((scoreVal ?? 0.92) * 100),
            })),
          }),
        }));
      })
      .catch(() => {
        // Fall back to static mock data
      });

    return () => {
      cancelled = true;
    };
  }, [contractData?.contractId]);

  const getCategoryIcon = (iconName) => {
    switch (iconName) {
      case 'ShieldCheck':
        return ShieldCheck;
      case 'Target':
        return Target;
      case 'Layers':
        return Layers;
      case 'Bug':
        return Bug;
      default:
        return BrainCircuit;
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8 font-sans">
      {/* ── Section Header ─────────────────────────────────────────── */}
      <div className="border-b border-rule pb-6">
        <div className="flex items-center justify-between font-mono text-xs text-prose-muted uppercase tracking-widest mb-3">
          <span>PHASE 03 of 04 ───────────────────────────────────────────</span>
          <span className="text-signal font-semibold">✓ SCORED</span>
        </div>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-4xl sm:text-5xl font-display font-bold text-prose tracking-tight">
              XAI Trust Score.
            </h1>
            <p className="text-prose-muted mt-2 text-base max-w-2xl">
              Algorithmic quality model & Poincaré zero-drift scope verification.
            </p>
          </div>

          {onProceedToEscrow && (
            <button
              id="btn-proceed-escrow"
              onClick={onProceedToEscrow}
              className="px-6 py-3.5 bg-signal text-ink font-mono font-bold text-xs uppercase tracking-wider hover:opacity-90 transition-all flex items-center gap-2 self-start md:self-auto"
            >
              <span>Proceed to Escrow Settlement</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* ── Hero Trust Score Overview Card ───────────────────────────── */}
      <div className="bg-ink-2 border border-rule p-8 font-mono">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-center">
          {/* Radial Score Gauge */}
          <div className="md:col-span-5 flex flex-col items-center justify-center p-4 border-b md:border-b-0 md:border-r border-rule">
            <RadialGauge
              value={data.score}
              max={100}
              size={190}
              strokeWidth={12}
              colorMode="auto"
              centerContent={
                <div className="flex flex-col items-center justify-center">
                  <span className="text-5xl font-bold font-mono text-prose tracking-tight">
                    {data.score}
                  </span>
                  <span className="text-xs font-mono uppercase tracking-widest text-signal mt-1">
                    GRADE {data.grade}
                  </span>
                </div>
              }
            />
            <div className="mt-4 flex items-center gap-2 text-xs text-prose-muted">
              <span>Confidence Rating: <strong className="text-prose font-bold">99.4%</strong></span>
            </div>
          </div>

          {/* Key Indicators */}
          <div className="md:col-span-7 space-y-6">
            <div className="flex flex-wrap items-center gap-3">
              <span className="px-3 py-1 text-xs font-mono font-bold tracking-wider bg-ink text-signal border border-rule">
                {data.status}
              </span>
              <StatusBadge status="VERIFIED" label="Zero-Trust Validated" size="sm" />
            </div>

            <div>
              <h3 className="text-2xl font-bold text-prose tracking-tight font-display">
                Contract #{contractData?.contractId || 'CTR-2026-8941'}
              </h3>
              <p className="text-xs text-prose-muted mt-1">
                Evaluated: {new Date(data.lastEvaluated).toLocaleString()}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="bg-ink p-3 border border-rule">
                <span className="text-[10px] text-prose-muted uppercase block">Boundary</span>
                <p className="text-sm font-bold text-signal">{data.ragScopeGuard.boundaryAdherence}%</p>
              </div>
              <div className="bg-ink p-3 border border-rule">
                <span className="text-[10px] text-prose-muted uppercase block">Similarity</span>
                <p className="text-sm font-bold text-prose">{data.ragScopeGuard.semSimilarityScore}</p>
              </div>
              <div className="bg-ink p-3 border border-rule">
                <span className="text-[10px] text-prose-muted uppercase block">Scope Risk</span>
                <p className="text-sm font-bold text-signal">{data.ragScopeGuard.outOfScopeRisk}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Category Breakdown ────────────────────────────────── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between font-mono text-xs text-prose-muted uppercase border-b border-rule pb-2">
          <span className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-signal" />
            CATEGORY WEIGHT BREAKDOWN
          </span>
          <span>4 Assessment Vectors</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {data.categories.map((cat) => {
            const Icon = getCategoryIcon(cat.icon);
            const isSelected = selectedCategory === cat.id;

            return (
              <div
                key={cat.id}
                onClick={() => setSelectedCategory(isSelected ? null : cat.id)}
                className={`p-5 bg-ink-2 border transition-all cursor-pointer font-mono ${
                  isSelected ? 'border-signal bg-ink-3' : 'border-rule hover:border-rule-hi'
                }`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-ink border border-rule">
                      <Icon className="w-4 h-4 text-signal" />
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-prose font-sans">{cat.name}</h4>
                      <span className="text-[11px] text-prose-muted">Weight: {cat.weight}%</span>
                    </div>
                  </div>

                  <span className="text-base font-bold text-signal">{cat.score}/100</span>
                </div>

                <div className="w-full bg-ink h-1.5 border border-rule overflow-hidden mb-3">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${cat.score}%` }}
                    transition={{ duration: 0.8 }}
                    className="h-full bg-signal"
                  />
                </div>

                <p className="text-xs text-prose-muted leading-relaxed font-sans">{cat.details}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── ScopeGuard & Feature Importance ──────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 font-mono text-xs">
        <div className="bg-ink-2 border border-rule p-6 space-y-4">
          <div className="flex items-center gap-2 mb-2 text-prose font-bold text-sm uppercase">
            <Target className="w-4 h-4 text-signal" />
            <span>RAG ScopeGuard Metrics</span>
          </div>

          <div className="space-y-3">
            <div className="flex justify-between items-center bg-ink p-3 border border-rule">
              <span className="text-prose-muted">Semantic Boundary Adherence</span>
              <span className="font-bold text-signal">{data.ragScopeGuard.boundaryAdherence}%</span>
            </div>

            <div className="flex justify-between items-center bg-ink p-3 border border-rule">
              <span className="text-prose-muted">Cosine Similarity Index</span>
              <span className="font-bold text-prose">{data.ragScopeGuard.semSimilarityScore}</span>
            </div>

            <div className="flex justify-between items-center bg-ink p-3 border border-rule">
              <span className="text-prose-muted">Out-of-Scope Queries</span>
              <span className="font-bold text-signal">{data.ragScopeGuard.outOfScopeQueries}</span>
            </div>
          </div>
        </div>

        <div className="bg-ink-2 border border-rule p-6 space-y-4">
          <div className="flex items-center gap-2 mb-2 text-prose font-bold text-sm uppercase">
            <TrendingUp className="w-4 h-4 text-signal" />
            <span>Feature Importance Weights</span>
          </div>

          <div className="space-y-3">
            {data.featureImportance.map((feat, idx) => (
              <div key={idx} className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-prose-muted">{feat.name}</span>
                  <span className="text-signal">{feat.delta}</span>
                </div>
                <div className="w-full bg-ink h-1.5 border border-rule overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${feat.importance * 100}%` }}
                    transition={{ duration: 0.6, delay: idx * 0.05 }}
                    className="h-full bg-signal"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Explainability Audit Trail ────────────────────────────────── */}
      <div className="bg-ink-2 border border-rule p-6 font-mono text-xs">
        <div className="flex items-center justify-between mb-4 border-b border-rule pb-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-signal" />
            <span className="font-bold text-prose uppercase">Explainability Audit Trail</span>
          </div>
          <button
            onClick={() => setShowAuditTrail(!showAuditTrail)}
            className="text-prose-muted hover:text-prose transition-colors"
          >
            [{showAuditTrail ? 'hide log' : 'show log'}]
          </button>
        </div>

        {showAuditTrail && (
          <div className="space-y-3">
            {data.auditLog.map((log) => (
              <div key={log.id} className="p-3 bg-ink border border-rule space-y-1">
                <div className="flex items-center justify-between text-prose-muted">
                  <span className="text-signal font-bold">{log.id} │ {log.action}</span>
                  <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
                </div>
                <p className="text-prose font-sans text-xs">{log.rationale}</p>
                <div className="pt-1 text-[11px] text-prose-muted flex justify-between border-t border-rule/50">
                  <span>Agent: {log.agent}</span>
                  <span className="text-signal">Impact: {log.scoreDelta >= 0 ? `+${log.scoreDelta}` : log.scoreDelta} → Score: {log.newScore}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default XaiTrustScoreView;

