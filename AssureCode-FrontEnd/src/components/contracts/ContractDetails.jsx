import React from 'react';
import { useApp } from '../../context/AppContext';
import { 
  GitBranch, 
  DollarSign, 
  Calendar, 
  ShieldCheck, 
  ExternalLink, 
  Cpu, 
  CheckCircle, 
  Lock, 
  FileCode,
  Sparkles,
  Layers
} from 'lucide-react';
import { LockedRequirementsCard } from './LockedRequirementsCard';
import { StatusBadge, Badge } from '../common/Badge';
import { formatHash } from '../../utils/cryptoUtils';

export function ContractDetails() {
  const { activeContract, setSelectedProofData, setIsProofModalOpen, setActiveTab } = useApp();

  if (!activeContract) {
    return (
      <div className="p-8 text-center text-slate-500">
        No active contract selected.
      </div>
    );
  }

  const handleInspectProof = (requirement, index) => {
    setSelectedProofData({
      requirement,
      index,
      contract: activeContract
    });
    setIsProofModalOpen(true);
  };

  return (
    <div className="space-y-6">
      {/* Top Banner / Summary */}
      <div className="glass-panel rounded-2xl p-6 border border-slate-800 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-6 border-b border-slate-800">
          <div className="space-y-2">
            <div className="flex items-center gap-2.5">
              <span className="px-2.5 py-1 rounded-lg bg-indigo-500/20 text-indigo-300 font-mono text-xs font-bold border border-indigo-500/30">
                {activeContract.id}
              </span>
              <StatusBadge status={activeContract.status} />
              <Badge variant="primary" size="xs">Escrow Secured</Badge>
            </div>
            <h1 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight">
              {activeContract.title}
            </h1>
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
              <div className="flex items-center gap-1">
                <GitBranch className="w-3.5 h-3.5 text-indigo-400" />
                <span className="font-mono text-slate-300">{activeContract.contractBranch}</span>
              </div>
              <span>•</span>
              <div className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-slate-400" />
                <span>Deadline: {activeContract.deadline}</span>
              </div>
              <span>•</span>
              <div className="flex items-center gap-1">
                <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
                <span className="font-mono text-emerald-300 font-bold">${activeContract.budget} {activeContract.currency}</span>
              </div>
            </div>
          </div>

          {/* Quick Action Navigation */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setActiveTab('CI_SANDBOX')}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-cyan-600/20 hover:bg-cyan-600/30 border border-cyan-500/40 text-cyan-300 text-xs font-semibold transition-colors"
            >
              <Cpu className="w-4 h-4" />
              <span>CI Sandbox Studio</span>
            </button>
            <button
              onClick={() => setActiveTab('SCOPE_CHAT')}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-brand-600/20 hover:bg-brand-600/30 border border-brand-500/40 text-indigo-300 text-xs font-semibold transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              <span>Scope Guard Chat</span>
            </button>
          </div>
        </div>

        {/* Client & Freelancer Profiles Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Client Card */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img
                src={activeContract.client.avatar}
                alt={activeContract.client.name}
                className="w-11 h-11 rounded-full border border-indigo-500/30 object-cover"
              />
              <div>
                <div className="text-xs text-slate-400">Client Organization</div>
                <div className="text-sm font-bold text-white">{activeContract.client.name}</div>
                <div className="text-[11px] text-slate-400">{activeContract.client.contact}</div>
              </div>
            </div>
            <div className="text-right text-xs">
              <div className="text-emerald-400 font-bold">{activeContract.client.rating} ★</div>
              <div className="text-[10px] text-slate-500">{activeContract.client.totalSpend} spend</div>
            </div>
          </div>

          {/* Freelancer Card */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img
                src={activeContract.freelancer.avatar}
                alt={activeContract.freelancer.name}
                className="w-11 h-11 rounded-full border border-indigo-500/30 object-cover"
              />
              <div>
                <div className="text-xs text-slate-400">Assigned Engineer</div>
                <div className="text-sm font-bold text-white flex items-center gap-1.5">
                  {activeContract.freelancer.name}
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="text-[11px] text-indigo-300 font-mono">{activeContract.freelancer.handle}</div>
              </div>
            </div>
            <div className="text-right text-xs">
              <div className="text-indigo-400 font-mono font-semibold">Verified Talent</div>
              <div className="text-[10px] text-slate-500">Sentence-BERT Top Match</div>
            </div>
          </div>
        </div>
      </div>

      {/* Locked Requirements Card & Merkle Proof Trigger */}
      <LockedRequirementsCard
        contract={activeContract}
        onInspectProof={handleInspectProof}
      />
    </div>
  );
}
