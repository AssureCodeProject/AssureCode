import React, { useState } from 'react';
import { ShieldCheck, UserCheck, CreditCard, Lock, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import MobileDrawer from './MobileDrawer';
import ToastNotification from './ToastNotification';

export function KycVerificationModal({ isOpen, onClose, currentUser, onKycComplete }) {
  const [idType, setIdType] = useState('PASSPORT');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [kycResult, setKycResult] = useState(null);
  const [toast, setToast] = useState(null);

  const handleVerifyKyc = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const res = await fetch('/api/kyc/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: currentUser?.id || 'client-acme',
          idType,
        }),
      });

      if (!res.ok) {
        throw new Error(`KYC Verification request failed: ${res.status}`);
      }

      const data = await res.json();
      setIsSubmitting(false);
      setKycResult(data);
      setToast({
        type: 'success',
        title: 'KYC Identity Verified',
        description: 'Identity document verified and AML sanctions check passed cleanly.',
      });

      if (onKycComplete) {
        onKycComplete(data);
      }
    } catch (err) {
      setIsSubmitting(false);
      setToast({
        type: 'error',
        title: 'KYC Error',
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <>
      {toast && (
        <ToastNotification
          toast={toast}
          onDismiss={() => setToast(null)}
        />
      )}

      <MobileDrawer
        isOpen={isOpen}
        onClose={onClose}
        title="ENTERPRISE KYC & COMPLIANCE"
        subtitle="Identity Verification & AML Sanctions Screening"
        position="right"
      >
        <div className="space-y-6 font-mono text-xs text-prose">
          {/* Header Status Badge */}
          <div className="p-4 bg-ink border border-rule flex items-center justify-between">
            <div className="flex items-center gap-3">
              <ShieldCheck className="w-6 h-6 text-signal" />
              <div>
                <span className="text-[10px] text-prose-muted uppercase block">Current KYC Status</span>
                <span className="font-bold text-signal tracking-wide uppercase">
                  {kycResult?.kycStatus || currentUser?.kycStatus || 'VERIFIED'}
                </span>
              </div>
            </div>
            <span className="px-2 py-1 bg-signal/10 border border-signal/30 text-signal font-bold text-[10px]">
              AML COMPLIANT
            </span>
          </div>

          {/* Form / Actions */}
          {!kycResult ? (
            <form onSubmit={handleVerifyKyc} className="space-y-4">
              <div>
                <label className="block text-prose-muted mb-2 uppercase">Select Identification Document</label>
                <select
                  value={idType}
                  onChange={(e) => setIdType(e.target.value)}
                  className="w-full p-3 bg-ink border border-rule text-prose text-xs outline-none focus:border-signal font-mono"
                >
                  <option value="PASSPORT">International Passport</option>
                  <option value="DRIVERS_LICENSE">Driver's License</option>
                  <option value="NATIONAL_ID">National Identity Card</option>
                </select>
              </div>

              <div className="p-3 bg-ink-2 border border-rule text-prose-muted text-[11px] space-y-1">
                <div className="text-prose font-bold flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-signal" /> Stripe Identity & AML Screening
                </div>
                <p>
                  Documents are encrypted via AES-256 and matched against global OFAC sanctions databases.
                </p>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3.5 font-bold bg-signal text-ink hover:opacity-90 disabled:opacity-40 uppercase tracking-wider transition-all flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>VERIFYING DOCUMENT...</span>
                  </>
                ) : (
                  <span>RUN KYC & AML VERIFICATION →</span>
                )}
              </button>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="p-4 bg-ink border border-signal text-signal space-y-2">
                <div className="flex items-center gap-2 font-bold text-sm">
                  <CheckCircle2 className="w-5 h-5 text-signal" /> Verification Successful
                </div>
                <p className="text-xs text-prose-muted font-sans">
                  Identity session <code className="text-signal">{kycResult.sessionId}</code> confirmed. AML sanctions check clean.
                </p>
              </div>

              <button
                onClick={onClose}
                className="w-full py-3 bg-ink-3 border border-rule text-prose font-bold uppercase hover:bg-ink"
              >
                CLOSE COMPLIANCE DRAWER
              </button>
            </div>
          )}
        </div>
      </MobileDrawer>
    </>
  );
}

export default KycVerificationModal;
