import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { 
  ShieldCheck, 
  User, 
  Briefcase, 
  Eye, 
  Bell, 
  Sparkles, 
  Database, 
  GitBranch, 
  CheckCircle2, 
  ChevronDown, 
  Activity,
  Layers,
  HelpCircle
} from 'lucide-react';
import { formatHash } from '../../utils/cryptoUtils';

export function Header() {
  const { 
    role, 
    setRole, 
    contracts, 
    selectedContractId, 
    switchContract, 
    activeContract, 
    notifications,
    setGuidedTourStep,
    ledgerBlocks
  } = useApp();

  const [showNotifications, setShowNotifications] = useState(false);
  const [showContractDropdown, setShowContractDropdown] = useState(false);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-800/80 bg-[#090d16]/90 backdrop-blur-xl">
      <div className="flex h-16 items-center justify-between px-4 sm:px-6">
        {/* Left: Brand & Network Status */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 via-brand-600 to-cyan-500 p-0.5 shadow-lg shadow-brand-500/20">
              <div className="w-full h-full bg-[#090d16] rounded-[10px] flex items-center justify-center">
                <ShieldCheck className="w-5 h-5 text-indigo-400" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-extrabold tracking-tight text-white">
                  Assure<span className="text-indigo-400">Code</span>
                </span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                  ZERO-TRUST v2.4
                </span>
              </div>
              <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>Postgres Hash Chain: Height #{ledgerBlocks.length - 1}</span>
              </p>
            </div>
          </div>

          {/* Active Contract Selector */}
          <div className="relative hidden md:block">
            <button
              onClick={() => setShowContractDropdown(!showContractDropdown)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-800 hover:border-slate-700 text-xs text-slate-200 transition-colors"
            >
              <GitBranch className="w-3.5 h-3.5 text-indigo-400" />
              <span className="font-semibold text-slate-300 max-w-[180px] truncate">
                {activeContract?.id}: {activeContract?.title}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>

            {showContractDropdown && (
              <div className="absolute left-0 mt-2 w-80 rounded-xl bg-[#0f1422] border border-slate-700 shadow-2xl p-2 z-50 animate-scale-up">
                <div className="text-[11px] font-semibold uppercase text-slate-400 px-3 py-1.5">
                  Select Active Contract
                </div>
                {contracts.map(contract => (
                  <button
                    key={contract.id}
                    onClick={() => {
                      switchContract(contract.id);
                      setShowContractDropdown(false);
                    }}
                    className={`w-full text-left p-2.5 rounded-lg text-xs transition-colors flex items-start justify-between ${
                      contract.id === selectedContractId
                        ? 'bg-brand-500/15 text-white border border-brand-500/30'
                        : 'text-slate-300 hover:bg-slate-800/60'
                    }`}
                  >
                    <div>
                      <div className="font-semibold text-slate-200">{contract.id}</div>
                      <div className="text-[11px] text-slate-400 truncate max-w-[200px]">{contract.title}</div>
                      <div className="text-[10px] text-indigo-400 font-mono mt-0.5">
                        Merkle: {formatHash(contract.merkleRoot, 4, 4)}
                      </div>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-300">
                      ${contract.budget}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Center: Role Switcher Tabs */}
        <div className="flex items-center p-1 rounded-xl bg-[#0f1422] border border-slate-800/90 shadow-inner">
          <button
            onClick={() => setRole('CLIENT')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              role === 'CLIENT'
                ? 'bg-brand-600 text-white shadow-md shadow-brand-600/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Briefcase className="w-3.5 h-3.5" />
            <span>Client View</span>
          </button>

          <button
            onClick={() => setRole('FREELANCER')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              role === 'FREELANCER'
                ? 'bg-brand-600 text-white shadow-md shadow-brand-600/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <User className="w-3.5 h-3.5" />
            <span>Freelancer View</span>
          </button>

          <button
            onClick={() => setRole('AUDITOR')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              role === 'AUDITOR'
                ? 'bg-cyan-600 text-white shadow-md shadow-cyan-600/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>Auditor / Ledger</span>
          </button>
        </div>

        {/* Right: Guided Tour, Notifications, Profile */}
        <div className="flex items-center gap-3">
          {/* Interactive Guided Tour trigger */}
          <button
            onClick={() => setGuidedTourStep(0)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-600/30 to-brand-600/30 border border-purple-500/40 text-purple-200 hover:text-white hover:border-purple-400 text-xs font-semibold transition-all shadow-sm"
            title="Start Interactive Architecture Walkthrough"
          >
            <Sparkles className="w-3.5 h-3.5 text-purple-300 animate-pulse" />
            <span className="hidden sm:inline">Guided Tour</span>
          </button>

          {/* Notifications Trigger */}
          <div className="relative">
            <button
              onClick={() => setShowNotifications(!showNotifications)}
              className="relative p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/80 transition-colors"
            >
              <Bell className="w-4 h-4" />
              {notifications.length > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-indigo-500 animate-ping" />
              )}
            </button>

            {showNotifications && (
              <div className="absolute right-0 mt-2 w-80 rounded-xl bg-[#0f1422] border border-slate-700 shadow-2xl p-3 z-50 animate-scale-up">
                <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                  <span className="text-xs font-semibold text-white">Event Stream Notifications</span>
                  <span className="text-[10px] text-slate-400">{notifications.length} unread</span>
                </div>
                <div className="max-h-72 overflow-y-auto space-y-2 mt-2">
                  {notifications.map(n => (
                    <div key={n.id} className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 text-xs">
                      <div className="font-semibold text-slate-200">{n.title}</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">{n.message}</div>
                      <div className="text-[9px] text-indigo-400 mt-1 font-mono">{n.timestamp}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Active User Avatar / Identity */}
          <div className="flex items-center gap-2 pl-2 border-l border-slate-800">
            <img
              src={
                role === 'CLIENT'
                  ? activeContract.client.avatar
                  : role === 'FREELANCER'
                  ? activeContract.freelancer.avatar
                  : 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150&auto=format&fit=crop&q=80'
              }
              alt="Avatar"
              className="w-8 h-8 rounded-full border border-indigo-500/40 object-cover"
            />
            <div className="hidden lg:block text-left">
              <div className="text-xs font-semibold text-slate-200">
                {role === 'CLIENT' ? activeContract.client.name : role === 'FREELANCER' ? activeContract.freelancer.name : 'Ledger Oracle Auditor'}
              </div>
              <div className="text-[10px] text-slate-400 font-mono">
                {role === 'CLIENT' ? 'Verified Client' : role === 'FREELANCER' ? activeContract.freelancer.handle : '0xORACLE_NODE_17'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
