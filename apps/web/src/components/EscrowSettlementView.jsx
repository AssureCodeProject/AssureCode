import React, { useState } from 'react';
import {
  Lock,
  Unlock,
  CheckCircle2,
  AlertTriangle,
  Zap,
} from 'lucide-react';
import MobileDrawer from './ui/MobileDrawer';
import ToastNotification from './ui/ToastNotification';
import { mockEscrowData } from '../data/mockEscrowData';

export function EscrowSettlementView({ contractData, onResetWorkflow }) {
  const [escrowState, setEscrowState] = useState(mockEscrowData);
  const [isDisputeOpen, setIsDisputeOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');
  const [isReleasing, setIsReleasing] = useState(false);
  const [fundsReleased, setFundsReleased] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);

  const vault = escrowState.vault;
  const milestones = escrowState.milestones;
  const oracleSignals = escrowState.oracleSignals;
  const merkleTree = escrowState.merkleTree;

  const handleReleaseFunds = async () => {
    if (fundsReleased || isReleasing) return;

    setIsReleasing(true);

    const amountCents = contractData?.budgetCents || 250000;
    const amountFormatted = `$${(amountCents / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

    try {
      const res = await fetch(`/api/contracts/${contractData?.contractId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          freelancerId: 'f_alex',
          amountCents,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Settlement failed: ${res.status}`);
      }

      setIsReleasing(false);
      setFundsReleased(true);

      setEscrowState((prev) => ({
        ...prev,
        vault: {
          ...prev.vault,
          status: 'SETTLED',
          statusLabel: 'Funds Successfully Released to Freelancer',
        },
        milestones: prev.milestones.map((m) => ({
          ...m,
          status: 'RELEASED',
          completedAt: new Date().toISOString(),
          txHash: '0x9e8a7f...6543',
        })),
      }));

      setToastMessage(`Success! ${amountFormatted} final milestone funds released to freelancer.`);
    } catch (err) {
      setIsReleasing(false);
      setToastMessage(`Failed to release funds: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRaiseDispute = (e) => {
    e.preventDefault();
    if (!disputeReason.trim()) return;

    setEscrowState((prev) => ({
      ...prev,
      dispute: {
        ...prev.dispute,
        isDisputed: true,
        reasons: [...prev.dispute.reasons, disputeReason],
      },
    }));

    setIsDisputeOpen(false);
    setDisputeReason('');
    setToastMessage('Dispute opened. Multi-Agent arbitration sequence triggered.');
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8 font-sans">
      {/* Toast notification */}
      {toastMessage && (
        <ToastNotification
          toast={{
            type: toastMessage.startsWith('Failed') ? 'error' : fundsReleased ? 'success' : 'info',
            title: toastMessage.startsWith('Failed') ? 'Settlement Error' : fundsReleased ? 'Funds Released' : 'Escrow Notice',
            description: toastMessage,
          }}
          onDismiss={() => setToastMessage(null)}
        />
      )}

      {/* ── Section Header ─────────────────────────────────────────── */}
      <div className="border-b border-rule pb-6">
        <div className="flex items-center justify-between font-mono text-xs text-prose-muted uppercase tracking-widest mb-3">
          <span>PHASE 04 of 04 ───────────────────────────────────────────</span>
          <span className={fundsReleased ? 'text-signal font-semibold' : 'text-warn'}>
            {fundsReleased ? '✓ SETTLED' : '● VAULT LOCKED'}
          </span>
        </div>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-4xl sm:text-5xl font-display font-bold text-prose tracking-tight">
              Escrow Settlement.
            </h1>
            <p className="text-prose-muted mt-2 text-base max-w-2xl">
              Autonomous cryptographic vault settlement backed by 5-Oracle verification signals.
            </p>
          </div>

          <button
            id="btn-dispute-toggle"
            onClick={() => setIsDisputeOpen(true)}
            className="px-4 py-3 font-mono text-xs font-semibold text-warn border border-warn/40 hover:bg-warn/10 transition-colors flex items-center gap-2 self-start md:self-auto"
          >
            <AlertTriangle className="w-4 h-4" />
            <span>[dispute drawer]</span>
          </button>
        </div>
      </div>

      {/* ── Vault Status Banner Card ─────────────────────────────────── */}
      <div className="bg-ink-2 border border-rule p-8 font-mono">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-ink border border-rule">
                {fundsReleased ? (
                  <Unlock className="w-6 h-6 text-signal" />
                ) : (
                  <Lock className="w-6 h-6 text-prose" />
                )}
              </div>
              <div>
                <span className="text-xs text-prose-muted uppercase tracking-wider block">
                  Smart Escrow Vault
                </span>
                <h2 className="text-3xl font-bold text-prose font-mono">
                  {vault.totalLockedFormatted}
                </h2>
              </div>
            </div>

            <p className="text-xs font-mono text-signal flex items-center gap-2">
              <span>●</span> {vault.statusLabel}
            </p>

            <div className="text-xs font-mono text-prose-muted">
              Vault Address: <span className="text-prose font-medium">{vault.vaultAddress}</span>
            </div>
          </div>

          {/* Action Control */}
          <div className="w-full md:w-auto flex flex-col items-center md:items-end gap-3 border-t md:border-t-0 border-rule pt-4 md:pt-0">
            <button
              id="btn-release-funds"
              onClick={handleReleaseFunds}
              disabled={fundsReleased || isReleasing}
              className={`w-full sm:w-auto px-8 py-4 font-mono font-bold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2 ${
                fundsReleased
                  ? 'bg-ink border border-signal text-signal cursor-default'
                  : isReleasing
                  ? 'bg-ink-3 text-prose-muted border border-rule cursor-wait'
                  : 'bg-signal text-ink hover:opacity-90 active:scale-[0.99]'
              }`}
            >
              {fundsReleased ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-signal" />
                  <span>FUNDS RELEASED & SETTLED</span>
                </>
              ) : isReleasing ? (
                <>
                  <Zap className="w-4 h-4 animate-spin text-prose-muted" />
                  <span>EXECUTING SMART CONTRACT...</span>
                </>
              ) : (
                <span>RELEASE FINAL FUNDS ({contractData?.budgetCents ? `$${(contractData.budgetCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '$2,500.00'}) →</span>
              )}
            </button>

            <span className="text-[11px] font-mono text-prose-muted">
              5/5 Oracle Validation Pass (Current Score: {vault.currentXaiScore}/100)
            </span>
          </div>
        </div>
      </div>

      {/* ── 5-Oracle Verification Matrix ─────────────────────── */}
      <div className="space-y-4 font-mono">
        <div className="flex items-center justify-between text-xs text-prose-muted uppercase border-b border-rule pb-2">
          <span>5-ORACLE VERIFICATION SIGNALS MATRIX</span>
          <span className="text-signal font-bold">5/5 VERIFIED</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {oracleSignals.map((sig) => (
            <div key={sig.id} className="p-4 bg-ink-2 border border-rule space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-prose">{sig.name}</span>
                <span className="text-[10px] text-signal bg-ink px-1.5 py-0.5 border border-rule">
                  {sig.status}
                </span>
              </div>
              <p className="text-sm font-bold text-signal">{sig.score}</p>
              <p className="text-xs text-prose-muted font-sans">{sig.detail}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Milestone Breakdown & Merkle Tree ────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 font-mono text-xs">
        <div className="bg-ink-2 border border-rule p-6 space-y-4">
          <div className="font-bold text-prose uppercase border-b border-rule pb-2">
            Milestone Payment Breakdown
          </div>

          <div className="space-y-3">
            {milestones.map((m) => (
              <div key={m.id} className="p-3 bg-ink border border-rule flex items-center justify-between">
                <div>
                  <span className="text-signal font-bold block">{m.id} │ {m.title}</span>
                  {m.txHash && <span className="text-[11px] text-prose-muted">Tx: {m.txHash}</span>}
                </div>
                <div className="text-right">
                  <span className="font-bold text-prose block">{m.amountFormatted}</span>
                  <span className={m.status === 'RELEASED' ? 'text-signal' : 'text-warn'}>{m.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-ink-2 border border-rule p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-rule pb-2">
            <span className="font-bold text-prose uppercase">Merkle Ledger Tree</span>
            <span className="text-prose-muted">Height #{merkleTree.totalBlocks}</span>
          </div>

          <div className="bg-ink p-3 border border-rule text-xs">
            <span className="text-prose-muted block text-[10px] uppercase mb-1">State Root Hash</span>
            <span className="text-signal break-all">{merkleTree.rootHash}</span>
          </div>

          <div className="space-y-2">
            {merkleTree.recentBlocks.map((b) => (
              <div key={b.height} className="p-3 bg-ink border border-rule">
                <div className="flex justify-between text-signal mb-1">
                  <span>Block #{b.height}</span>
                  <span>{b.status}</span>
                </div>
                <p className="text-[11px] text-prose-muted truncate">Hash: {b.blockHash}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Dispute Drawer Component ─────────────────────────────────── */}
      <MobileDrawer
        isOpen={isDisputeOpen}
        onClose={() => setIsDisputeOpen(false)}
        title="ESCROW DISPUTE DRAWER"
        subtitle="Automated Arbitration Protocol"
        position="right"
      >
        <div className="space-y-6 font-mono text-xs">
          <div className="p-3 bg-ink border border-warn text-warn">
            <div className="font-bold mb-1">[DISPUTE PROTOCOL ACTIVE]</div>
            <p className="text-prose-muted font-sans">
              Opening a dispute halts automatic settlement and triggers an oracle re-scan.
            </p>
          </div>

          <form onSubmit={handleRaiseDispute} className="space-y-4">
            <div>
              <label className="block text-prose-muted mb-2 uppercase">Reason for Dispute</label>
              <textarea
                rows={4}
                value={disputeReason}
                onChange={(e) => setDisputeReason(e.target.value)}
                placeholder="Specify non-conformance, scope breach, or code flaw..."
                className="w-full p-3 bg-ink border border-rule text-prose text-xs outline-none focus:border-warn font-mono"
              />
            </div>

            <button
              type="submit"
              disabled={!disputeReason.trim()}
              className="w-full py-3 font-bold bg-warn text-ink hover:opacity-90 disabled:opacity-40 uppercase"
            >
              Trigger Arbitration Sequence
            </button>
          </form>
        </div>
      </MobileDrawer>
    </div>
  );
}

export default EscrowSettlementView;

