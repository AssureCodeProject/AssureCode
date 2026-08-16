import React from 'react';
import { useApp } from '../../context/AppContext';
import { 
  LayoutDashboard, 
  FilePlus2, 
  Layers, 
  Cpu, 
  MessageSquareCode, 
  Coins, 
  Database, 
  ShieldAlert, 
  CheckCircle,
  Lock
} from 'lucide-react';
import { StatusBadge } from './Badge';

export function Sidebar() {
  const { activeTab, setActiveTab, role, activeContract, trustScoreData } = useApp();

  const navItems = [
    {
      id: 'OVERVIEW',
      label: 'Dashboard Overview',
      icon: LayoutDashboard,
      badge: null
    },
    {
      id: 'NEW_CONTRACT',
      label: 'New Contract & AI Match',
      icon: FilePlus2,
      badge: 'NLP Match'
    },
    {
      id: 'WORKSPACE',
      label: 'Locked Contract Specs',
      icon: Layers,
      badge: activeContract ? 'Merkle' : null
    },
    {
      id: 'CI_SANDBOX',
      label: 'Zero-Trust CI Sandbox',
      icon: Cpu,
      badge: 'AST + OWASP'
    },
    {
      id: 'SCOPE_CHAT',
      label: 'Scope Guard RAG Chat',
      icon: MessageSquareCode,
      badge: 'Cosine >= 0.27'
    },
    {
      id: 'SETTLEMENT',
      label: 'Trust Score & Escrow',
      icon: Coins,
      badge: `${trustScoreData.score}/100`
    },
    {
      id: 'LEDGER',
      label: 'Postgres Ledger Explorer',
      icon: Database,
      badge: 'RFC 6962'
    }
  ];

  return (
    <aside className="w-64 flex-shrink-0 hidden md:flex flex-col justify-between border-r border-slate-800 bg-[#090d16]/95 min-h-[calc(100vh-4rem)] p-4">
      <div className="space-y-6">
        {/* Navigation Items */}
        <div className="space-y-1">
          <div className="text-[11px] font-bold tracking-wider uppercase text-slate-500 px-3 mb-2">
            Platform Modules
          </div>
          {navItems.map(item => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;

            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                  isActive
                    ? 'bg-brand-600/20 text-white border border-brand-500/40 shadow-sm shadow-brand-500/20 font-bold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-850'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon className={`w-4 h-4 ${isActive ? 'text-indigo-400' : 'text-slate-400'}`} />
                  <span>{item.label}</span>
                </div>
                {item.badge && (
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                      isActive
                        ? 'bg-brand-500/30 text-indigo-200'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Active Contract Quick Status Card */}
        {activeContract && (
          <div className="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800/80 space-y-2.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400 font-semibold uppercase">Contract State</span>
              <StatusBadge status={activeContract.status} />
            </div>

            <div>
              <div className="text-xs font-bold text-slate-200 truncate">{activeContract.title}</div>
              <div className="text-[11px] text-slate-400 mt-0.5">Budget: ${activeContract.budget} USD</div>
            </div>

            <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-[10px] font-mono">
              <span className="text-slate-400">Trust Score</span>
              <span className={`font-bold ${trustScoreData.score >= 85 ? 'text-emerald-400' : 'text-amber-400'}`}>
                {trustScoreData.score} / 100 {trustScoreData.isApproved ? '(Approved)' : '(Gated)'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Footer Security Pill */}
      <div className="pt-4 border-t border-slate-800/80">
        <div className="p-3 rounded-xl bg-gradient-to-r from-brand-950/40 to-slate-900 border border-brand-500/20 text-xs space-y-1">
          <div className="flex items-center gap-1.5 text-indigo-400 font-bold text-[11px]">
            <Lock className="w-3.5 h-3.5" />
            <span>Zero-Trust Protocol</span>
          </div>
          <p className="text-[10px] text-slate-400 leading-relaxed">
            All code commits are sandboxed without network access. Escrow releases require oracle quorum.
          </p>
        </div>
      </div>
    </aside>
  );
}
