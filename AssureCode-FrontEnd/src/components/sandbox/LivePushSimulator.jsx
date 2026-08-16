import React from 'react';
import { useApp } from '../../context/AppContext';
import { GitCommit, GitPullRequest, Play, CheckCircle2, ShieldCheck, Loader2, Sparkles } from 'lucide-react';
import { Badge } from '../common/Badge';

export function LivePushSimulator() {
  const { activeContract, triggerPushAndCISandbox, isSandboxRunning, sandboxProgress } = useApp();

  if (!activeContract) return null;

  return (
    <div className="glass-panel rounded-2xl p-6 border border-slate-800 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <GitCommit className="w-5 h-5 text-cyan-400" />
            <h3 className="text-base font-bold text-white">GitHub Webhook & Sandbox Trigger</h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            HMAC SHA-256 verified webhook delivers <code className="text-indigo-300 font-mono">code.push.received</code> event to Ephemeral Docker Sandbox.
          </p>
        </div>

        <button
          onClick={triggerPushAndCISandbox}
          disabled={isSandboxRunning}
          className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white text-xs font-bold shadow-lg shadow-cyan-500/20 transition-all disabled:opacity-50"
        >
          {isSandboxRunning ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Verifying Sandbox ({sandboxProgress}%)...</span>
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              <span>Simulate Git Push & Verification</span>
            </>
          )}
        </button>
      </div>

      {/* Commit & Branch Details */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
        <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800">
          <div className="text-slate-500 font-semibold">Repository Branch</div>
          <div className="font-mono text-cyan-300 font-bold mt-0.5">{activeContract.contractBranch}</div>
        </div>

        <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800">
          <div className="text-slate-500 font-semibold">Webhook Ingest</div>
          <div className="font-mono text-emerald-400 font-bold mt-0.5 flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5" />
            HMAC SHA-256 (Valid)
          </div>
        </div>

        <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800">
          <div className="text-slate-500 font-semibold">Sandbox Constraints</div>
          <div className="font-mono text-indigo-300 font-bold mt-0.5">net=none | mem=512MB</div>
        </div>
      </div>

      {/* Progress Bar when running */}
      {isSandboxRunning && (
        <div className="space-y-1.5 animate-fade-in">
          <div className="flex justify-between text-xs text-slate-400 font-mono">
            <span>Executing Ephemeral Sandbox Pipeline...</span>
            <span className="text-cyan-400 font-bold">{sandboxProgress}%</span>
          </div>
          <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-cyan-500 to-indigo-500 transition-all duration-300 rounded-full"
              style={{ width: `${sandboxProgress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
