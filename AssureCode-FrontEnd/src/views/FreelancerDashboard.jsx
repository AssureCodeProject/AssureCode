import React from 'react';
import { useApp } from '../context/AppContext';
import { 
  User, 
  GitBranch, 
  Cpu, 
  ShieldCheck, 
  Coins, 
  MessageSquareCode, 
  ArrowRight, 
  Play, 
  Key, 
  CheckCircle2, 
  Award,
  Layers
} from 'lucide-react';
import { MetricCard } from '../components/common/MetricCard';
import { StatusBadge, Badge } from '../components/common/Badge';
import { formatHash } from '../utils/cryptoUtils';

export function FreelancerDashboard() {
  const { 
    activeContract, 
    contracts, 
    setActiveTab, 
    trustScoreData, 
    triggerPushAndCISandbox, 
    isSandboxRunning 
  } = useApp();

  return (
    <div className="space-y-6">
      {/* Welcome Banner */}
      <div className="glass-panel-glow rounded-2xl p-6 border border-brand-500/30 flex flex-col lg:flex-row lg:items-center justify-between gap-6 relative overflow-hidden">
        <div className="space-y-2 z-10">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
              FREELANCER PERSPECTIVE
            </span>
            <Badge variant="cyan" size="xs">Verified Developer</Badge>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            Developer Workspace & Sandbox
          </h1>
          <p className="text-xs sm:text-sm text-slate-300 max-w-2xl leading-relaxed">
            Deliver code with guaranteed escrow protection. Your payouts are gated by deterministic objective code quality—not arbitrary ratings or subjective reviews.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 z-10">
          <button
            onClick={triggerPushAndCISandbox}
            disabled={isSandboxRunning}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white text-xs font-bold shadow-lg shadow-cyan-500/25 transition-all disabled:opacity-50"
          >
            <Play className="w-4 h-4" />
            <span>{isSandboxRunning ? 'Verifying Sandbox...' : 'Push Commit & Run Sandbox'}</span>
          </button>
        </div>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Assigned Contract"
          value={activeContract?.id || 'ac-4091'}
          subtitle="Contract Branch Active"
          icon={GitBranch}
          color="cyan"
          onClick={() => setActiveTab('WORKSPACE')}
        />
        <MetricCard
          title="Guaranteed Escrow"
          value={`$${activeContract?.budget || 3800}.00`}
          subtitle="Held in Stripe Vault"
          icon={Coins}
          color="emerald"
          onClick={() => setActiveTab('SETTLEMENT')}
        />
        <MetricCard
          title="AST Maintainability"
          value="91.4/100"
          subtitle="Grade A (SEI MI Optimal)"
          icon={Cpu}
          color="purple"
          onClick={() => setActiveTab('CI_SANDBOX')}
        />
        <MetricCard
          title="Trust Score Target"
          value={`${trustScoreData.score}/100`}
          subtitle={trustScoreData.isApproved ? 'Payout Authorized' : '≥ 85 Required'}
          icon={Award}
          color={trustScoreData.score >= 85 ? 'emerald' : 'amber'}
          onClick={() => setActiveTab('SETTLEMENT')}
        />
      </div>

      {/* Developer Contract Focus */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Contract Delivery Status (2 Cols) */}
        <div className="lg:col-span-2 glass-panel rounded-2xl p-6 border border-slate-800 space-y-5">
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div>
              <span className="text-xs font-mono text-indigo-400 font-bold">ACTIVE CONTRACT WORK</span>
              <h3 className="text-base font-bold text-white mt-0.5">{activeContract?.title}</h3>
            </div>
            <StatusBadge status={activeContract?.status} />
          </div>

          <div className="p-4 rounded-xl bg-[#070a12] border border-slate-800 font-mono text-xs text-slate-300 space-y-2">
            <div className="flex items-center justify-between text-slate-500">
              <span>Git Contract Branch:</span>
              <span className="text-cyan-300 font-bold">{activeContract?.contractBranch}</span>
            </div>
            <div className="flex items-center justify-between text-slate-500">
              <span>Genesis Anchor:</span>
              <span className="text-indigo-300">{formatHash(activeContract?.genesisLedgerHash, 8, 8)}</span>
            </div>
            <div className="flex items-center justify-between text-slate-500">
              <span>Merkle Root:</span>
              <span className="text-emerald-300">{formatHash(activeContract?.merkleRoot, 8, 8)}</span>
            </div>
          </div>

          {/* Verification Progress */}
          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Objective CI Verification Metrics
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 flex items-center justify-between">
                <span className="text-slate-400">Hidden Tests:</span>
                <span className="text-emerald-400 font-mono font-bold">8/8 Passed (100%)</span>
              </div>
              <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 flex items-center justify-between">
                <span className="text-slate-400">OWASP Critical Findings:</span>
                <span className="text-emerald-400 font-mono font-bold">0 Vulnerabilities</span>
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-3 border-t border-slate-800 text-xs">
            <button
              onClick={() => setActiveTab('CI_SANDBOX')}
              className="flex items-center gap-1.5 text-indigo-400 hover:text-indigo-300 font-semibold"
            >
              <span>Inspect Full CI Sandbox & Terminal</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Right: Quick Action Cards (1 Col) */}
        <div className="space-y-4">
          <div
            onClick={() => setActiveTab('SCOPE_CHAT')}
            className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 hover:border-brand-500/50 transition-all cursor-pointer space-y-2"
          >
            <div className="flex items-center justify-between">
              <MessageSquareCode className="w-5 h-5 text-indigo-400" />
              <Badge variant="primary" size="xs">RAG Guard</Badge>
            </div>
            <h4 className="text-sm font-bold text-white">Scope Guarded Client Chat</h4>
            <p className="text-xs text-slate-400">
              Communicate safely. Scope Guard protects you from uncompensated scope additions.
            </p>
          </div>

          <div
            onClick={() => setActiveTab('SETTLEMENT')}
            className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 hover:border-emerald-500/50 transition-all cursor-pointer space-y-2"
          >
            <div className="flex items-center justify-between">
              <Coins className="w-5 h-5 text-emerald-400" />
              <Badge variant="success" size="xs">Stripe Payout</Badge>
            </div>
            <h4 className="text-sm font-bold text-white">Escrow Release Vault</h4>
            <p className="text-xs text-slate-400">
              When your trust score hits ≥ 85, settlement triggers automatically via the oracle.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
