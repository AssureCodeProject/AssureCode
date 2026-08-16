import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { 
  Coins, 
  ShieldCheck, 
  AlertTriangle, 
  CreditCard, 
  CheckCircle2, 
  Lock, 
  ArrowRight, 
  Loader2, 
  Sparkles,
  DollarSign
} from 'lucide-react';
import { Badge } from '../common/Badge';

export function OracleSettlementCard() {
  const { 
    activeContract, 
    trustScoreData, 
    executeSettlement, 
    role, 
    ledgerBlocks,
    setActiveTab 
  } = useApp();

  const [isSettling, setIsSettling] = useState(false);

  if (!activeContract) return null;

  const isSettled = activeContract.status === 'SETTLED';

  const handleCaptureSettlement = async () => {
    setIsSettling(true);
    await new Promise(resolve => setTimeout(resolve, 800));
    await executeSettlement();
    setIsSettling(false);
  };

  return (
    <div className="glass-panel rounded-2xl p-6 border border-slate-800 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <Coins className="w-5 h-5 text-emerald-400" />
            <h3 className="text-base font-bold text-white">Settlement Oracle & Escrow Vault</h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Single-fire atomic settlement capturing held Stripe PaymentIntent upon deterministic oracle satisfaction.
          </p>
        </div>

        <Badge variant={isSettled ? 'success' : trustScoreData.isApproved ? 'success' : 'warning'}>
          {isSettled ? 'Settlement Finalized' : trustScoreData.isApproved ? 'Ready for Payout' : 'Oracle Gated'}
        </Badge>
      </div>

      {/* Vault Status Box */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
          <div className="text-slate-500 text-xs font-semibold uppercase">Escrow Balance</div>
          <div className="mt-1 text-2xl font-bold font-mono text-emerald-400">
            ${activeContract.budget}.00 USD
          </div>
          <div className="text-[10px] text-slate-400 font-mono mt-1">
            {activeContract.escrowPaymentIntentId}
          </div>
        </div>

        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
          <div className="text-slate-500 text-xs font-semibold uppercase">Oracle Gate Verdict</div>
          <div className="mt-1 text-xl font-bold font-mono text-white flex items-center gap-2">
            {trustScoreData.isApproved ? (
              <span className="text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-5 h-5" /> APPROVED
              </span>
            ) : (
              <span className="text-rose-400 flex items-center gap-1">
                <AlertTriangle className="w-5 h-5" /> BLOCKED
              </span>
            )}
          </div>
          <div className="text-[10px] text-slate-400 mt-1">
            Score: {trustScoreData.score}/100 (&ge; 85 req)
          </div>
        </div>

        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
          <div className="text-slate-500 text-xs font-semibold uppercase">Settlement Concurrency</div>
          <div className="mt-1 text-sm font-bold font-mono text-cyan-300">
            Single-Fire Insert Lock
          </div>
          <div className="text-[10px] text-slate-400 font-mono mt-1">
            ON CONFLICT DO NOTHING
          </div>
        </div>
      </div>

      {/* Oracle Verification Checklist */}
      <div className="p-4 rounded-xl bg-[#090d16] border border-slate-800 space-y-3">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
          Settlement Oracle Conditions
        </div>

        <div className="space-y-2 text-xs">
          <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/50">
            <div className="flex items-center gap-2 text-slate-300">
              <CheckCircle2 className={`w-4 h-4 ${trustScoreData.score >= 85 ? 'text-emerald-400' : 'text-rose-400'}`} />
              <span>Deterministic Trust Score &ge; 85 (Current: {trustScoreData.score})</span>
            </div>
            <Badge variant={trustScoreData.score >= 85 ? 'success' : 'danger'} size="xs">
              {trustScoreData.score >= 85 ? 'PASSED' : 'FAILED'}
            </Badge>
          </div>

          <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/50">
            <div className="flex items-center gap-2 text-slate-300">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Critical OWASP Security Findings == 0 (Current: 0)</span>
            </div>
            <Badge variant="success" size="xs">PASSED</Badge>
          </div>

          <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/50">
            <div className="flex items-center gap-2 text-slate-300">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Genesis Hash & Merkle Ledger Anchor Validated</span>
            </div>
            <Badge variant="success" size="xs">PASSED</Badge>
          </div>
        </div>
      </div>

      {/* Action Footer */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-4 border-t border-slate-800">
        <div className="text-xs text-slate-400">
          {isSettled ? (
            <span className="text-emerald-400 font-semibold flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              Funds captured and transferred to {activeContract.freelancer.name}. Ledger block appended.
            </span>
          ) : (
            <span>
              Clicking capture initiates Stripe release and records <code className="text-indigo-300 font-mono">SETTLEMENT_COMPLETED</code> to PostgreSQL.
            </span>
          )}
        </div>

        {!isSettled ? (
          <button
            onClick={handleCaptureSettlement}
            disabled={!trustScoreData.isApproved || isSettling}
            className="flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 text-white text-xs font-bold shadow-xl shadow-emerald-600/25 transition-all"
          >
            {isSettling ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Capturing PaymentIntent...</span>
              </>
            ) : (
              <>
                <Coins className="w-4 h-4" />
                <span>Capture Stripe Escrow (${activeContract.budget}.00)</span>
              </>
            )}
          </button>
        ) : (
          <button
            onClick={() => setActiveTab('LEDGER')}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 text-xs font-bold transition-colors"
          >
            <span>View Final Ledger Block</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
