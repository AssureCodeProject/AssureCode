import React from 'react';
import { useApp } from '../context/AppContext';
import { 
  Briefcase, 
  Sparkles, 
  ShieldCheck, 
  Coins, 
  Cpu, 
  MessageSquareCode, 
  ArrowRight, 
  Layers, 
  FilePlus2, 
  DollarSign, 
  CheckCircle2,
  Lock
} from 'lucide-react';
import { MetricCard } from '../components/common/MetricCard';
import { StatusBadge, Badge } from '../components/common/Badge';
import { formatHash } from '../utils/cryptoUtils';

export function ClientDashboard() {
  const { activeContract, contracts, setActiveTab, trustScoreData, freelancers } = useApp();

  return (
    <div className="space-y-6">
      {/* Welcome Banner */}
      <div className="glass-panel-glow rounded-2xl p-6 border border-brand-500/30 flex flex-col lg:flex-row lg:items-center justify-between gap-6 relative overflow-hidden">
        <div className="space-y-2 z-10">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
              CLIENT PERSPECTIVE
            </span>
            <Badge variant="success" size="xs">Escrow Secured</Badge>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            Client Control Center
          </h1>
          <p className="text-xs sm:text-sm text-slate-300 max-w-2xl leading-relaxed">
            Manage zero-trust freelance contracts with automated Sentence-BERT talent matching, ephemeral CI verification, and deterministic escrow payouts.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 z-10">
          <button
            onClick={() => setActiveTab('NEW_CONTRACT')}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-brand-600 to-indigo-600 hover:from-brand-500 hover:to-indigo-500 text-white text-xs font-bold shadow-lg shadow-brand-500/30 transition-all"
          >
            <FilePlus2 className="w-4 h-4" />
            <span>Create New Contract</span>
          </button>
        </div>
      </div>

      {/* Top Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Active Contracts"
          value={contracts.length}
          subtitle="Cryptographically Locked"
          icon={Layers}
          color="brand"
          onClick={() => setActiveTab('WORKSPACE')}
        />
        <MetricCard
          title="Escrow Vault Balance"
          value={`$${contracts.reduce((acc, c) => acc + (c.budget || 0), 0)}`}
          subtitle="Held in Stripe Escrow"
          icon={Coins}
          color="emerald"
          onClick={() => setActiveTab('SETTLEMENT')}
        />
        <MetricCard
          title="Deterministic Trust Score"
          value={`${trustScoreData.score}/100`}
          subtitle={trustScoreData.isApproved ? 'Oracle Approved (≥ 85)' : 'Under Audit'}
          icon={ShieldCheck}
          color={trustScoreData.score >= 85 ? 'emerald' : 'amber'}
          onClick={() => setActiveTab('SETTLEMENT')}
        />
        <MetricCard
          title="Scope Creep Protection"
          value="100%"
          subtitle="RAG pgvector Monitored"
          icon={MessageSquareCode}
          color="purple"
          onClick={() => setActiveTab('SCOPE_CHAT')}
        />
      </div>

      {/* Active Contract Spotlight & Quick Workflow Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Active Contract Overview (2 Cols) */}
        <div className="lg:col-span-2 glass-panel rounded-2xl p-6 border border-slate-800 space-y-5">
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div>
              <span className="text-xs font-mono text-indigo-400 font-bold">{activeContract?.id}</span>
              <h3 className="text-base font-bold text-white mt-0.5">{activeContract?.title}</h3>
            </div>
            <StatusBadge status={activeContract?.status} />
          </div>

          {/* Assigned Freelancer & Escrow Pill */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center gap-3">
              <img
                src={activeContract?.freelancer.avatar}
                alt={activeContract?.freelancer.name}
                className="w-10 h-10 rounded-full border border-indigo-500/40 object-cover"
              />
              <div>
                <div className="text-[11px] text-slate-400">Assigned Freelancer</div>
                <div className="font-bold text-white">{activeContract?.freelancer.name}</div>
                <div className="text-[10px] text-indigo-300 font-mono">{activeContract?.freelancer.handle}</div>
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center justify-between">
              <div>
                <div className="text-[11px] text-slate-400">Escrow Value</div>
                <div className="text-lg font-bold font-mono text-emerald-400">${activeContract?.budget}.00 USD</div>
                <div className="text-[10px] text-slate-500 font-mono">Stripe Held</div>
              </div>
              <div className="text-right">
                <span className="px-2 py-1 rounded bg-emerald-500/10 text-emerald-400 text-[10px] font-bold border border-emerald-500/30">
                  FUNDED
                </span>
              </div>
            </div>
          </div>

          {/* Requirements Preview */}
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Locked Requirements ({activeContract?.requirements?.length || 0})
            </div>
            <div className="space-y-2">
              {activeContract?.requirements?.slice(0, 3).map((req, idx) => (
                <div key={idx} className="p-3 rounded-lg bg-slate-900/50 border border-slate-800 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 truncate">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                    <span className="text-slate-300 truncate">{req.title}</span>
                  </div>
                  <span className="text-[10px] text-indigo-300 font-mono flex-shrink-0 ml-2">
                    {req.techStack}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-800 text-xs">
            <span className="text-slate-400 font-mono text-[11px]">
              Merkle Root: {formatHash(activeContract?.merkleRoot, 6, 6)}
            </span>
            <button
              onClick={() => setActiveTab('WORKSPACE')}
              className="flex items-center gap-1.5 text-indigo-400 hover:text-indigo-300 font-semibold"
            >
              <span>View Full Contract Workspace</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Quick Nav Action Cards (1 Col) */}
        <div className="space-y-4">
          <div
            onClick={() => setActiveTab('CI_SANDBOX')}
            className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 hover:border-cyan-500/50 transition-all cursor-pointer space-y-2"
          >
            <div className="flex items-center justify-between">
              <Cpu className="w-5 h-5 text-cyan-400" />
              <Badge variant="cyan" size="xs">Ephemeral</Badge>
            </div>
            <h4 className="text-sm font-bold text-white">CI Sandbox Telemetry</h4>
            <p className="text-xs text-slate-400">
              Inspect AST complexity, Halstead metrics, and dual-layer OWASP security findings.
            </p>
          </div>

          <div
            onClick={() => setActiveTab('SCOPE_CHAT')}
            className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 hover:border-brand-500/50 transition-all cursor-pointer space-y-2"
          >
            <div className="flex items-center justify-between">
              <MessageSquareCode className="w-5 h-5 text-indigo-400" />
              <Badge variant="primary" size="xs">pgvector</Badge>
            </div>
            <h4 className="text-sm font-bold text-white">Scope Guard Chat</h4>
            <p className="text-xs text-slate-400">
              Real-time cosine similarity pre-check prevents scope creep beyond locked deliverables.
            </p>
          </div>

          <div
            onClick={() => setActiveTab('SETTLEMENT')}
            className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 hover:border-emerald-500/50 transition-all cursor-pointer space-y-2"
          >
            <div className="flex items-center justify-between">
              <Coins className="w-5 h-5 text-emerald-400" />
              <Badge variant="success" size="xs">Oracle</Badge>
            </div>
            <h4 className="text-sm font-bold text-white">Escrow Settlement</h4>
            <p className="text-xs text-slate-400">
              Deterministic linear score evaluation gates the single-fire Stripe escrow release.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
