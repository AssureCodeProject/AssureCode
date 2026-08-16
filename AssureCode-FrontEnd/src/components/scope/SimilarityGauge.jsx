import React from 'react';
import { SCOPE_THRESHOLD } from '../../utils/scopeGuardEngine';
import { Sparkles, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '../common/Badge';

export function SimilarityGauge({ similarity = 0.842, threshold = SCOPE_THRESHOLD, showDetails = true, chunks = [] }) {
  const percentage = Math.min(100, Math.max(0, similarity * 100));
  const thresholdPercentage = threshold * 100;
  const isAllowed = similarity >= threshold;

  return (
    <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-3 font-mono text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-indigo-400" />
          <span className="font-semibold text-slate-200">RAG Cosine Similarity Meter</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-400">Threshold: {thresholdPercentage.toFixed(2)}%</span>
          <Badge variant={isAllowed ? 'success' : 'danger'} size="xs">
            {isAllowed ? 'IN-SCOPE (ALLOWED)' : 'SCOPE CREEP (BLOCKED)'}
          </Badge>
        </div>
      </div>

      {/* Visual Bar Gauge with Threshold Marker */}
      <div className="space-y-1">
        <div className="relative w-full h-4 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
          {/* Active fill */}
          <div
            className={`h-full transition-all duration-500 rounded-full ${
              isAllowed
                ? 'bg-gradient-to-r from-cyan-500 via-indigo-500 to-emerald-400 shadow-sm shadow-emerald-500/50'
                : 'bg-gradient-to-r from-rose-600 to-rose-400 shadow-sm shadow-rose-500/50'
            }`}
            style={{ width: `${percentage}%` }}
          />

          {/* Threshold Line */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-amber-400 z-10"
            style={{ left: `${thresholdPercentage}%` }}
            title={`Threshold: ${thresholdPercentage.toFixed(2)}%`}
          />
        </div>

        <div className="flex justify-between text-[10px] text-slate-500">
          <span>0.00 (Unrelated)</span>
          <span className="text-amber-400 font-bold">| {threshold} (Gate)</span>
          <span>1.00 (Exact Match)</span>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs pt-1">
        <span className="text-slate-400">Calculated Cosine Score:</span>
        <span className={`font-bold ${isAllowed ? 'text-emerald-400' : 'text-rose-400'}`}>
          {(similarity * 100).toFixed(2)}% ({similarity.toFixed(4)})
        </span>
      </div>

      {/* Top Matching Chunks Preview */}
      {showDetails && chunks && chunks.length > 0 && (
        <div className="pt-2 border-t border-slate-800 space-y-1.5 text-[11px]">
          <div className="text-slate-500 font-semibold uppercase text-[10px]">
            Top Retained Contract Chunks (pgvector):
          </div>
          {chunks.slice(0, 3).map((chunk, idx) => (
            <div key={idx} className="flex items-center justify-between p-1.5 rounded bg-slate-950/60 text-slate-300">
              <span className="truncate max-w-[240px] text-[10px]">{chunk.title}</span>
              <span className="text-indigo-400 font-semibold font-mono text-[10px]">
                {(chunk.similarity * 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
