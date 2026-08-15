/**
 * EscrowSettlementView — the real oracle verdict and the real escrow state.
 *
 * What this replaced
 * ------------------
 * Three separate fictions, all of them load-bearing for what the screen claimed:
 *
 *   1. A "5-Oracle Verification Signals Matrix" rendered from `mockEscrowData`,
 *      in which all five oracles were the string 'VERIFIED' with confidences of
 *      98.5% / 99.1% / 100%. Those five cards were identical for every contract
 *      and never consulted the oracle. The system has four signals plus the
 *      trust-score gate, not five verified oracles.
 *   2. A Merkle tree panel showing block height 14,921 and hand-written hashes.
 *      Deleted rather than reconnected: there is no Merkle tree yet, only a hash
 *      chain, and Phase 8 is where that gets built. A panel that renders a root
 *      hash for a tree that does not exist is worse than no panel.
 *   3. `POST /settle` returns 202 `pending_oracle_verification` — the request is
 *      queued for the oracle, which may then reject it. The old handler treated
 *      that 202 as success: it set `fundsReleased`, flipped every milestone to
 *      RELEASED, invented the transaction hash '0x9e8a7f...6543', and showed
 *      "Success! $2,500.00 released". A contract the oracle rejected a moment
 *      later still displayed as settled.
 *
 * Settlement is now a request whose outcome is polled from oracle state. Money
 * is reported as moved only once the escrow row actually reads RELEASED.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Lock,
  Unlock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Zap,
  RefreshCw,
} from 'lucide-react';
import MobileDrawer from './ui/MobileDrawer';
import ToastNotification from './ui/ToastNotification';
import EscrowFundingPanel, { formatMinor } from './EscrowFundingPanel';
import { apiRequest } from '../utils/api';

/** The four CI signals, in the order the oracle evaluates them. */
const SIGNAL_ROWS = [
  {
    key: 'astPassed',
    name: 'AST Complexity Oracle',
    detail: 'SEI maintainability index >= 10 from the Babel-parsed AST.',
  },
  {
    key: 'testsPassed',
    name: 'Hidden Test Oracle',
    detail: 'Every injected test passed, and at least one ran (0/0 is indeterminate).',
  },
  {
    key: 'securityPassed',
    name: 'OWASP 2025 Oracle',
    detail: 'Dual-layer scan (static + LLM) reported no findings.',
  },
  {
    key: 'scopePassed',
    name: 'RAG ScopeGuard Oracle',
    detail: 'No recorded scope check was rejected against the anchored contract.',
  },
];

/**
 * Amounts are Razorpay minor units (paise) and the currency is INR, so this
 * formats rupees — not the dollars the Stripe-era helper assumed. The value in
 * `amount_cents` never changed meaning; only the currency it denominates did.
 */
const formatAmount = (minor, currency = 'INR') => formatMinor(minor, currency);

/** Toast styling is derived from the message text, so the three outcomes of a
 *  settlement request stay in one place instead of two parallel ternaries. */
function describeToast(message) {
  if (message.startsWith('Failed')) return { type: 'error', title: 'Settlement Error' };
  if (message.startsWith('Escrow released')) return { type: 'success', title: 'Funds Released' };
  return { type: 'info', title: 'Escrow Notice' };
}

function vaultStatusLabel(status, released) {
  if (status !== 'ready') return '… READING ORACLE';
  return released ? '✓ SETTLED' : '● VAULT LOCKED';
}

function trustGateLabel(trustScore, threshold) {
  if (trustScore === null) return 'NOT SCORED';
  return trustScore >= threshold ? 'PASS' : 'FAIL';
}

function vulnGateLabel(criticalVulns) {
  if (criticalVulns === null) return 'UNKNOWN';
  return criticalVulns === 0 ? 'PASS' : 'FAIL';
}

function releaseButtonClasses({ released, isReleasing, canRelease }) {
  const base =
    'w-full sm:w-auto px-8 py-4 font-mono font-bold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2';
  if (released) return `${base} bg-ink border border-signal text-signal cursor-default`;
  if (isReleasing) return `${base} bg-ink-3 text-prose-muted border border-rule cursor-wait`;
  if (canRelease) return `${base} bg-signal text-ink hover:opacity-90 active:scale-[0.99]`;
  return `${base} bg-ink-3 text-prose-muted border border-rule cursor-not-allowed`;
}

export function EscrowSettlementView({ contractData, onResetWorkflow }) {
  const [state, setState] = useState({ status: 'idle' });
  const [isDisputeOpen, setIsDisputeOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');
  const [isReleasing, setIsReleasing] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);
  const pollRef = useRef(null);

  const contractId = contractData?.contractId;

  const load = useCallback(async () => {
    if (!contractId) {
      setState({
        status: 'error',
        message: 'No contract selected. Initialize a contract before viewing escrow state.',
      });
      return null;
    }

    // apiRequest rather than callApi: an unreadable oracle and a gateway that
    // rejected the read are reported differently, and the poll loop below
    // needs a resolved value rather than a throw on every failed attempt.
    let res;
    try {
      res = await apiRequest(`/api/contracts/${encodeURIComponent(contractId)}/oracle`);
    } catch (err) {
      setState({
        status: 'error',
        message: `The API gateway is unreachable (${err instanceof Error ? err.message : String(err)}).`,
      });
      return null;
    }

    if (!res.ok) {
      setState({ status: 'error', message: res.payload.error || `Gateway returned HTTP ${res.status}.` });
      return null;
    }

    setState({ status: 'ready', data: res.payload });
    return res.payload;
  }, [contractId]);

  useEffect(() => {
    setState({ status: 'loading' });
    void load();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const data = state.status === 'ready' ? state.data : null;
  const released = data?.escrow?.status === 'RELEASED';
  const settlementStatus = data?.settlement?.status ?? null;

  // Funded means AUTHORIZED or beyond: an order at PENDING is one nobody has
  // paid, and releasing it would capture money that was never authorised. This
  // is the same distinction the oracle enforces server-side when it selects
  // escrow rows on status = 'AUTHORIZED'.
  const escrowFunded =
    data?.escrow != null && data.escrow.status !== 'PENDING' && data.escrow.status !== 'FAILED';
  const needsFunding = data != null && (data.escrow == null || data.escrow.status === 'PENDING');

  /**
   * Request settlement, then watch oracle state until the escrow row changes or
   * the settlement row reports a terminal status. The 202 from /settle means the
   * oracle has been asked, not that it agreed.
   */
  const handleReleaseFunds = async () => {
    if (!contractId || released || isReleasing) return;

    setIsReleasing(true);

    try {
      const res = await apiRequest(`/api/contracts/${encodeURIComponent(contractId)}/settle`, {
        method: 'POST',
        // Both values come from the contract and escrow rows the gateway read,
        // not from the client. The old version posted the literal 'f_alex' and
        // a default of 250000 cents, so the UI decided who got paid how much.
        body: {
          freelancerId: data?.freelancerId ?? null,
          amountCents: data?.escrow?.amountMinor ?? null,
        },
      });

      if (!res.ok) {
        throw new Error(res.payload.error || `Settlement request rejected: HTTP ${res.status}`);
      }

      setToastMessage(
        'Settlement requested. The oracle is evaluating; funds move only if it approves.',
      );

      // Poll rather than assume. Ten attempts at 1.5s, then stop and say so —
      // an indefinite spinner would read as "still working" long after the
      // worker has gone away.
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts += 1;
        const fresh = await load();

        const done = fresh?.escrow?.status === 'RELEASED';
        const failed = fresh?.settlement?.status === 'FAILED';

        if (done || failed || attempts >= 10) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setIsReleasing(false);

          if (done) {
            setToastMessage(
              `Escrow released: payment ${fresh.escrow.paymentId} captured for ` +
                `${formatAmount(fresh.escrow.amountMinor, fresh.escrow.currency)}.`,
            );
          } else if (failed) {
            setToastMessage('Failed: the oracle approved but escrow capture did not complete.');
          } else {
            setToastMessage(
              'Failed: no settlement outcome after 15s. The oracle rejected the request or the ' +
                'settlement worker is not running — check the blockers below.',
            );
          }
        }
      }, 1500);
    } catch (err) {
      setIsReleasing(false);
      setToastMessage(`Failed to request settlement: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Only ever rendered inside the `data &&` block below, so `data` is set. */
  function renderReleaseButtonLabel() {
    if (released) {
      return (
        <>
          <CheckCircle2 className="w-4 h-4 text-signal" />
          <span>FUNDS RELEASED & SETTLED</span>
        </>
      );
    }
    if (isReleasing) {
      return (
        <>
          <Zap className="w-4 h-4 animate-spin text-prose-muted" />
          <span>AWAITING ORACLE VERDICT…</span>
        </>
      );
    }
    if (!escrowFunded) {
      return <span>ESCROW NOT FUNDED</span>;
    }
    if (!data.approved) {
      return <span>BLOCKED BY ORACLE</span>;
    }
    return (
      <span>
        RELEASE FUNDS{data.escrow ? ` (${formatAmount(data.escrow.amountMinor, data.escrow.currency)})` : ''} →
      </span>
    );
  }

  const handleRaiseDispute = (e) => {
    e.preventDefault();
    if (!disputeReason.trim()) return;
    setIsDisputeOpen(false);
    setDisputeReason('');
    // Honest about what exists: the dispute path has no backend. Claiming a
    // "multi-agent arbitration sequence" had been triggered was a UI-only
    // fiction, so it is stated as unimplemented rather than mimed.
    setToastMessage(
      'Dispute not filed: arbitration is not implemented. Nothing was sent and no state changed.',
    );
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8 font-sans">
      {toastMessage && (
        <ToastNotification
          toast={{ ...describeToast(toastMessage), description: toastMessage }}
          onDismiss={() => setToastMessage(null)}
        />
      )}

      {/* ── Section Header ─────────────────────────────────────────── */}
      <div className="border-b border-rule pb-6">
        <div className="flex items-center justify-between font-mono text-xs text-prose-muted uppercase tracking-widest mb-3">
          <span>PHASE 04 of 04 ───────────────────────────────────────────</span>
          <span className={released ? 'text-signal font-semibold' : 'text-warn'}>
            {vaultStatusLabel(state.status, released)}
          </span>
        </div>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-4xl sm:text-5xl font-display font-bold text-prose tracking-tight">
              Escrow Settlement.
            </h1>
            <p className="text-prose-muted mt-2 text-base max-w-2xl">
              Razorpay authorise-and-capture escrow, released only when the settlement oracle
              approves.
            </p>
          </div>

          <div className="flex items-center gap-2 self-start md:self-auto">
            <button
              onClick={() => void load()}
              className="px-4 py-3 border border-rule text-prose-muted hover:text-prose font-mono text-xs uppercase tracking-wider transition-colors flex items-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              <span>refresh</span>
            </button>
            <button
              id="btn-dispute-toggle"
              onClick={() => setIsDisputeOpen(true)}
              className="px-4 py-3 font-mono text-xs font-semibold text-warn border border-warn/40 hover:bg-warn/10 transition-colors flex items-center gap-2"
            >
              <AlertTriangle className="w-4 h-4" />
              <span>[dispute drawer]</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Error state ─────────────────────────────────────────────── */}
      {state.status === 'error' && (
        <div className="bg-ink-2 border border-warn p-8 font-mono space-y-3">
          <div className="flex items-center gap-3 text-warn">
            <AlertTriangle className="w-6 h-6" />
            <span className="text-lg font-bold uppercase tracking-wide">Oracle state unavailable</span>
          </div>
          <p className="text-sm text-prose font-sans leading-relaxed">{state.message}</p>
          <p className="text-xs text-prose-muted border-t border-rule pt-3 font-sans">
            No signal values are shown, because an unreadable oracle is not a failing one — it is an
            unknown one, and rendering four red crosses would assert something this screen has not
            established.
          </p>
        </div>
      )}

      {state.status === 'loading' && (
        <div className="bg-ink-2 border border-rule p-8 font-mono text-sm text-prose-muted">
          Reading oracle state…
        </div>
      )}

      {/* ── Fund Escrow ──────────────────────────────────────
          Only while there is nothing held: either no escrow row at all, or an
          order at PENDING that nobody has paid. Once the funds are authorised
          this disappears and the vault panel below takes over. */}
      {needsFunding && (
        <EscrowFundingPanel
          contractId={contractId}
          existingEscrow={data.escrow}
          onFunded={() => {
            setToastMessage('Escrow funded. Funds are authorised and held pending the oracle verdict.');
            void load();
          }}
        />
      )}

      {/* ── Vault Status ─────────────────────────────────── */}
      {data && (
        <div className="bg-ink-2 border border-rule p-8 font-mono">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-ink border border-rule">
                  {released ? (
                    <Unlock className="w-6 h-6 text-signal" />
                  ) : (
                    <Lock className="w-6 h-6 text-prose" />
                  )}
                </div>
                <div>
                  <span className="text-xs text-prose-muted uppercase tracking-wider block">
                    Razorpay Escrow (authorise &amp; capture)
                  </span>
                  <h2 className="text-3xl font-bold text-prose font-mono">
                    {data.escrow
                      ? formatAmount(data.escrow.amountMinor, data.escrow.currency)
                      : 'NO ESCROW'}
                  </h2>
                </div>
              </div>

              {data.escrow ? (
                <>
                  <p
                    className={`text-xs font-mono flex items-center gap-2 ${
                      released ? 'text-signal' : escrowFunded ? 'text-warn' : 'text-prose-muted'
                    }`}
                  >
                    <span>●</span>
                    {released
                      ? 'Funds captured and released to the freelancer'
                      : escrowFunded
                        ? 'Funds authorised and held — not yet captured'
                        : 'Order created — awaiting payment. No funds are held yet.'}
                  </p>
                  <div className="text-xs font-mono text-prose-muted">
                    Order: <span className="text-prose font-medium">{data.escrow.orderId}</span>
                  </div>
                  {/* Null until someone actually pays; that gap is the whole
                      difference between an order and a held escrow. */}
                  {data.escrow.paymentId && (
                    <div className="text-xs font-mono text-prose-muted">
                      Payment: <span className="text-prose font-medium">{data.escrow.paymentId}</span>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs font-mono text-warn">
                  No escrow has been created for this contract. There is nothing to release.
                </p>
              )}

              {settlementStatus && (
                <div className="text-xs font-mono text-prose-muted">
                  Settlement record: <span className="text-prose">{settlementStatus}</span>
                </div>
              )}
            </div>

            {/* Action Control */}
            <div className="w-full md:w-auto flex flex-col items-center md:items-end gap-3 border-t md:border-t-0 border-rule pt-4 md:pt-0">
              <button
                id="btn-release-funds"
                onClick={handleReleaseFunds}
                // `escrowFunded`, not just `data.escrow`: a PENDING order is an
                // escrow row with nothing behind it, and asking the oracle to
                // release it can only fail.
                disabled={released || isReleasing || !escrowFunded || !data.approved}
                title={
                  !escrowFunded
                    ? 'The escrow has not been funded yet — complete the payment first.'
                    : data.approved
                      ? undefined
                      : `Blocked by the oracle: ${data.blockers.join('; ')}`
                }
                className={releaseButtonClasses({
                  released,
                  isReleasing,
                  canRelease: Boolean(data.approved && escrowFunded),
                })}
              >
                {renderReleaseButtonLabel()}
              </button>

              <span className="text-[11px] font-mono text-prose-muted">
                {
                  // Count only what the oracle actually reports, and show the
                  // gate arithmetic rather than a decorative "5/5".
                  `${SIGNAL_ROWS.filter((r) => data.signals[r.key]).length}/${SIGNAL_ROWS.length} CI signals · ` +
                    `trust ${data.signals.trustScore ?? '—'}/${data.threshold}`
                }
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Blockers ───────────────────────────────────────── */}
      {data && !data.approved && (
        <div className="bg-ink-2 border border-warn p-6 font-mono text-xs space-y-2">
          <div className="flex items-center gap-2 text-warn font-bold uppercase text-sm mb-2">
            <XCircle className="w-4 h-4" />
            <span>Settlement blocked — {data.blockers.length} unmet condition(s)</span>
          </div>
          <ul className="space-y-1.5">
            {data.blockers.map((b, i) => (
              <li key={i} className="flex gap-2 text-prose font-sans">
                <span className="text-warn font-mono">✗</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Oracle Signal Matrix ─────────────────────── */}
      {data && (
        <div className="space-y-4 font-mono">
          <div className="flex items-center justify-between text-xs text-prose-muted uppercase border-b border-rule pb-2">
            <span>ORACLE SIGNALS</span>
            <span className={data.approved ? 'text-signal font-bold' : 'text-warn font-bold'}>
              {data.approved ? 'ALL CONDITIONS MET' : 'CONDITIONS NOT MET'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {SIGNAL_ROWS.map((row) => {
              const ok = data.signals[row.key];
              return (
                <div key={row.key} className="p-4 bg-ink-2 border border-rule space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-prose">{row.name}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 border border-rule bg-ink ${
                        ok ? 'text-signal' : 'text-warn'
                      }`}
                    >
                      {ok ? 'PASS' : 'FAIL'}
                    </span>
                  </div>
                  <p className="text-xs text-prose-muted font-sans">{row.detail}</p>
                </div>
              );
            })}

            {/* The trust-score gate is not a CI signal; it is the threshold the
                objective specifies, so it gets its own card with its numbers. */}
            <div className="p-4 bg-ink-2 border border-rule space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-prose">Trust Score Gate</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 border border-rule bg-ink ${
                    data.signals.trustScore !== null && data.signals.trustScore >= data.threshold
                      ? 'text-signal'
                      : 'text-warn'
                  }`}
                >
                  {trustGateLabel(data.signals.trustScore, data.threshold)}
                </span>
              </div>
              <p className="text-sm font-bold text-prose">
                {data.signals.trustScore ?? '—'} / {data.threshold}
              </p>
              <p className="text-xs text-prose-muted font-sans">
                Requires trustScore ≥ {data.threshold}. Null means XAI_SCORED was never received.
              </p>
            </div>

            <div className="p-4 bg-ink-2 border border-rule space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-prose">Critical Vulnerabilities</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 border border-rule bg-ink ${
                    data.signals.criticalVulns === 0 ? 'text-signal' : 'text-warn'
                  }`}
                >
                  {vulnGateLabel(data.signals.criticalVulns)}
                </span>
              </div>
              <p className="text-sm font-bold text-prose">{data.signals.criticalVulns ?? '—'}</p>
              <p className="text-xs text-prose-muted font-sans">
                Requires exactly zero. Unknown blocks settlement, same as non-zero.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Scope decision log summary ────────── */}
      {data && (
        <div className="bg-ink-2 border border-rule p-6 font-mono text-xs space-y-3">
          <div className="font-bold text-prose uppercase border-b border-rule pb-2">
            Recorded Scope Decisions
          </div>

          {data.scopeChecks.total === 0 ? (
            <p className="text-prose-muted font-sans">
              No scope checks recorded. The scope signal passes by default here — no request was
              made, so none was rejected — but the trust score's scope term is unmeasured rather
              than perfect. A contract that never uses the chat channel avoids the term entirely.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-ink p-3 border border-rule">
                <span className="text-[10px] text-prose-muted uppercase block">Allowed</span>
                <p className="text-sm font-bold text-signal">{data.scopeChecks.allowed}</p>
              </div>
              <div className="bg-ink p-3 border border-rule">
                <span className="text-[10px] text-prose-muted uppercase block">Rejected</span>
                <p
                  className={`text-sm font-bold ${
                    data.scopeChecks.rejected > 0 ? 'text-warn' : 'text-prose'
                  }`}
                >
                  {data.scopeChecks.rejected}
                </p>
              </div>
              <div className="bg-ink p-3 border border-rule">
                <span className="text-[10px] text-prose-muted uppercase block">Adherence</span>
                <p className="text-sm font-bold text-prose">
                  {((data.scopeChecks.allowed / data.scopeChecks.total) * 100).toFixed(1)}%
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {onResetWorkflow && (
        <button
          onClick={onResetWorkflow}
          className="font-mono text-xs text-prose-muted hover:text-prose underline underline-offset-4"
        >
          [start a new contract]
        </button>
      )}

      {/* ── Dispute Drawer ─────────────────────────────────── */}
      <MobileDrawer
        isOpen={isDisputeOpen}
        onClose={() => setIsDisputeOpen(false)}
        title="ESCROW DISPUTE DRAWER"
        subtitle="Not implemented"
        position="right"
      >
        <div className="space-y-6 font-mono text-xs">
          <div className="p-3 bg-ink border border-warn text-warn">
            <div className="font-bold mb-1">[NOT IMPLEMENTED]</div>
            <p className="text-prose-muted font-sans">
              There is no arbitration backend. Submitting this form sends nothing and halts nothing;
              it is kept so the missing capability is visible rather than implied.
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
              Submit (no-op)
            </button>
          </form>
        </div>
      </MobileDrawer>
    </div>
  );
}

export default EscrowSettlementView;
