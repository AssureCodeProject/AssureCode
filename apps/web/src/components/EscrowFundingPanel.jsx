/**
 * EscrowFundingPanel — the missing half of the escrow flow.
 *
 * Nothing in this app could create an escrow. `POST /api/contracts/:id/escrow`
 * existed and worked, but its only callers were tools/benchmark.js and
 * tools/test_e2e_project_flow.js — so the UI could *release* funds it had no
 * way to put in, and the escrow it released had never been paid by anyone.
 *
 * The flow, and why it has three steps rather than one:
 *
 *   1. POST /escrow            → the gateway creates a Razorpay order. No money
 *                                yet; an order is just something payable.
 *   2. Razorpay Checkout       → the customer pays. Because the order was made
 *                                with payment_capture: 0, the payment settles
 *                                at `authorized`: held on their card, not taken.
 *   3. POST /escrow/verify     → the gateway checks the callback signature and
 *                                re-reads the payment from Razorpay before
 *                                believing the browser about any of it.
 *
 * Step 3 is not a formality. The browser's word that a payment succeeded is
 * worth exactly the HMAC attached to it, and the HMAC can only be checked
 * server-side — so the escrow is not funded until the gateway says so, and this
 * component reports success only after that call returns.
 */
import React, { useState } from 'react';
import { CreditCard, Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';
import { apiRequest } from '../utils/api';
import { openRazorpayCheckout } from '../utils/razorpay';
import KycVerificationModal from './ui/KycVerificationModal';
import { useAuth } from '../context/AuthContext';

/** Minor units (paise) → a readable rupee amount. */
export const formatMinor = (minor, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format((minor ?? 0) / 100);

/** Rupees typed by the user → the paise Razorpay expects. */
const rupeesToMinor = (rupees) => Math.round(Number(rupees) * 100);

export function EscrowFundingPanel({ contractId, existingEscrow, onFunded }) {
  const { user } = useAuth();
  const [amountRupees, setAmountRupees] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | creating | paying | verifying
  const [error, setError] = useState(null);
  // Funding is gated on KYC by requireKycVerified in the gateway. The modal
  // that satisfies that gate existed and was imported by nothing, so a client
  // who hit the gate had no route forward from inside the app at all — the only
  // way to become VERIFIED was tools/seed-users.py.
  const [kycOpen, setKycOpen] = useState(false);

  // An order already exists but nobody has paid it. Offer to resume rather than
  // creating a second order for the same contract.
  const pendingOrder = existingEscrow?.status === 'PENDING' ? existingEscrow : null;
  const busy = phase !== 'idle';

  const fail = (message) => {
    setError(message);
    setPhase('idle');
  };

  /**
   * The gateway's KYC refusal, turned into the action that resolves it.
   *
   * Returns true when it handled the response, so callers stop rather than also
   * rendering an error the user cannot act on.
   */
  const handledKycGate = (res) => {
    if (res.status === 403 && res.payload?.error === 'KYC_REQUIRED') {
      setPhase('idle');
      setError(null);
      setKycOpen(true);
      return true;
    }
    return false;
  };

  /**
   * Hand a completed Checkout callback to the gateway.
   *
   * Split out because both the fresh-order path and the resume path end here,
   * and the verification step is the one that actually decides whether the
   * escrow is funded.
   */
  const verify = async (callback) => {
    setPhase('verifying');
    const res = await apiRequest(
      `/api/contracts/${encodeURIComponent(contractId)}/escrow/verify`,
      { method: 'POST', body: callback },
    );

    if (!res.ok) {
      // The payment may well have gone through at Razorpay even though we could
      // not confirm it — say so rather than implying the money is safe, and name
      // the payment id so it can be traced.
      throw new Error(
        `${res.payload.error || `Verification failed (HTTP ${res.status})`}. ` +
          `If you were charged, the webhook will reconcile payment ${callback.razorpayPaymentId}.`,
      );
    }

    setPhase('idle');
    onFunded?.(res.payload);
  };

  const startCheckout = async (order) => {
    setPhase('paying');
    const callback = await openRazorpayCheckout({
      keyId: order.keyId,
      orderId: order.orderId,
      amountMinor: order.amountMinor,
      currency: order.currency ?? 'INR',
      contractId,
    });
    await verify(callback);
  };

  const handleFund = async () => {
    setError(null);

    const amountMinor = rupeesToMinor(amountRupees);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      fail('Enter an escrow amount greater than zero.');
      return;
    }

    try {
      setPhase('creating');
      const res = await apiRequest(`/api/contracts/${encodeURIComponent(contractId)}/escrow`, {
        method: 'POST',
        body: { amountMinor, currency: 'INR' },
      });

      if (!res.ok) {
        if (handledKycGate(res)) return;
        throw new Error(res.payload.error || `Could not create the escrow order (HTTP ${res.status}).`);
      }
      if (!res.payload.keyId) {
        // The gateway is running on FakeRazorpayAdapter — no key id to open
        // Checkout with. Worth saying plainly; the alternative is a modal that
        // fails with an opaque Razorpay error.
        throw new Error(
          'The gateway has no Razorpay key configured, so Checkout cannot open. ' +
            'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET and restart the gateway.',
        );
      }

      await startCheckout(res.payload);
    } catch (err) {
      if (err?.code === 'DISMISSED') {
        // Not an error. The order stays PENDING and the resume path picks it up.
        setPhase('idle');
        return;
      }
      fail(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResume = async () => {
    setError(null);
    try {
      // The oracle read gives us the order id but not the key id, which only
      // the escrow-create response carries. Re-posting is safe: the route
      // returns the existing unpaid order for this contract when the amount and
      // currency match, rather than minting a second one.
      const res = await apiRequest(`/api/contracts/${encodeURIComponent(contractId)}/escrow`, {
        method: 'POST',
        body: { amountMinor: pendingOrder.amountMinor, currency: pendingOrder.currency ?? 'INR' },
      });
      if (!res.ok) {
        if (handledKycGate(res)) return;
        throw new Error(res.payload.error || `Could not reopen the escrow order (HTTP ${res.status}).`);
      }
      await startCheckout(res.payload);
    } catch (err) {
      if (err?.code === 'DISMISSED') {
        setPhase('idle');
        return;
      }
      fail(err instanceof Error ? err.message : String(err));
    }
  };

  const phaseLabel = {
    creating: 'CREATING ORDER…',
    paying: 'AWAITING PAYMENT…',
    verifying: 'VERIFYING PAYMENT…',
  }[phase];

  return (
    <div className="bg-ink-2 border border-rule p-8 font-mono space-y-5">
      <div className="flex items-center gap-3">
        <div className="p-3 bg-ink border border-rule">
          <CreditCard className="w-6 h-6 text-prose" />
        </div>
        <div>
          <span className="text-xs text-prose-muted uppercase tracking-wider block">
            Fund Escrow · Razorpay
          </span>
          <h2 className="text-xl font-bold text-prose font-mono">
            {pendingOrder ? 'Payment pending' : 'No escrow yet'}
          </h2>
        </div>
      </div>

      <p className="text-xs text-prose-muted leading-relaxed">
        Funds are <span className="text-prose">authorised and held</span>, not collected. The
        settlement oracle captures them only if the four CI signals pass and the trust score clears
        the threshold — otherwise the hold lapses and the money returns to you.
      </p>

      {pendingOrder ? (
        <div className="space-y-3">
          <div className="text-xs text-prose-muted">
            Order <span className="text-prose">{pendingOrder.orderId}</span> for{' '}
            <span className="text-prose">
              {formatMinor(pendingOrder.amountMinor, pendingOrder.currency)}
            </span>{' '}
            is awaiting payment.
          </div>
          <button
            onClick={handleResume}
            disabled={busy}
            className="w-full sm:w-auto px-8 py-4 font-mono font-bold text-xs uppercase tracking-wider bg-signal text-ink hover:opacity-90 active:scale-[0.99] disabled:bg-ink-3 disabled:text-prose-muted disabled:border disabled:border-rule disabled:cursor-wait transition-all flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{phaseLabel}</span>
              </>
            ) : (
              <span>COMPLETE PAYMENT →</span>
            )}
          </button>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <label className="flex-1 space-y-2">
            <span className="text-[11px] uppercase tracking-wider text-prose-muted block">
              Escrow amount (INR)
            </span>
            <input
              type="number"
              min="1"
              step="0.01"
              inputMode="decimal"
              value={amountRupees}
              onChange={(e) => setAmountRupees(e.target.value)}
              disabled={busy}
              placeholder="2500.00"
              className="w-full bg-ink border border-rule px-4 py-3 font-mono text-sm text-prose placeholder:text-prose-muted focus:outline-none focus:border-signal disabled:opacity-60"
            />
          </label>
          <button
            onClick={handleFund}
            disabled={busy}
            className="px-8 py-3 font-mono font-bold text-xs uppercase tracking-wider bg-signal text-ink hover:opacity-90 active:scale-[0.99] disabled:bg-ink-3 disabled:text-prose-muted disabled:border disabled:border-rule disabled:cursor-wait transition-all flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{phaseLabel}</span>
              </>
            ) : (
              <span>FUND ESCROW →</span>
            )}
          </button>
        </div>
      )}

      {phase === 'verifying' && (
        <p className="text-xs text-prose-muted flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" />
          Confirming the payment signature with the gateway…
        </p>
      )}

      {error && (
        <p className="text-xs text-warn flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </p>
      )}

      <KycVerificationModal
        isOpen={kycOpen}
        currentUser={user}
        onClose={() => setKycOpen(false)}
        onKycComplete={() => {
          // No re-login needed: requireKycVerified reads kyc_status from the
          // database on every request precisely so a user who verifies
          // mid-session is not refused by a stale token claim.
          setKycOpen(false);
          setError('Identity verified. Funding is now unblocked — try again.');
        }}
      />
    </div>
  );
}

export default EscrowFundingPanel;
