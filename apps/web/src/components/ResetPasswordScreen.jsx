import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { KeyRound, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { validateNewPassword, PASSWORD_HELPER_TEXT } from '../utils/passwordPolicy';

function submitButtonClasses(isSubmitting, canSubmit) {
  const base =
    'w-full py-3.5 font-mono font-bold text-sm tracking-wider uppercase transition-all flex items-center justify-center gap-2';
  if (isSubmitting) return `${base} bg-ink-3 text-prose-muted border border-rule cursor-wait`;
  if (canSubmit) return `${base} bg-signal text-ink hover:opacity-90 active:scale-[0.99]`;
  return `${base} bg-ink-3 text-prose-dim border border-rule cursor-not-allowed`;
}

function fieldError(message) {
  if (!message) return null;
  return <p className="mt-1.5 font-mono text-[11px] text-fail">{message}</p>;
}

/**
 * Landing page for the link mailed by /auth/forgot-password. Reads `?token=`
 * from its own URL exactly like GithubCallback.jsx reads `?code=` — the
 * app's existing pattern for a query-param-driven landing page, not a new
 * one. Mounted by App.jsx when `window.location.pathname === '/reset-password'`.
 */
export function ResetPasswordScreen() {
  const { resetPassword } = useAuth();
  const token = new URLSearchParams(window.location.search).get('token') || '';

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [touched, setTouched] = useState({ password: false, confirm: false });

  const passwordError = touched.password ? validateNewPassword(newPassword) : null;
  const confirmError = touched.confirm
    ? (!confirmPassword ? 'Please confirm your password.' : newPassword !== confirmPassword ? 'Passwords do not match.' : null)
    : null;

  const canSubmit = Boolean(
    token && newPassword && !validateNewPassword(newPassword) && confirmPassword && newPassword === confirmPassword,
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    setTouched({ password: true, confirm: true });
    if (!canSubmit || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await resetPassword(token, newPassword, confirmPassword);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-ink text-prose flex items-center justify-center font-sans px-4">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="w-full max-w-sm"
      >
        <div className="text-center mb-8">
          <span className="font-display text-2xl font-semibold tracking-tight text-prose">
            AssureCode <span className="text-signal">▮</span>
          </span>
          <p className="font-mono text-xs text-prose-muted mt-2 uppercase tracking-widest">
            Choose A New Password
          </p>
        </div>

        <div className="bg-ink-2 border border-rule p-6 sm:p-8 space-y-6">
          {!token && (
            <div className="flex items-start gap-2 text-xs font-mono text-fail bg-fail/5 border border-fail/30 px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>This reset link is missing its token. Request a new one from the sign-in page.</span>
            </div>
          )}

          {token && done && (
            <div className="flex items-start gap-2 text-xs font-mono text-signal bg-signal/5 border border-signal/30 px-3 py-2">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>Your password has been reset. You can now sign in with your new password.</span>
            </div>
          )}

          {token && !done && (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label htmlFor="reset-new-password" className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
                  New Password
                </label>
                <input
                  id="reset-new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                  disabled={isSubmitting}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  className="w-full bg-ink px-4 py-3 border-b border-rule text-prose placeholder:text-prose-dim text-sm
                             focus:border-signal outline-none transition-colors disabled:opacity-40"
                />
                {fieldError(passwordError) || (
                  <p className="mt-1.5 font-mono text-[11px] text-prose-dim">{PASSWORD_HELPER_TEXT}</p>
                )}
              </div>

              <div>
                <label htmlFor="reset-confirm-password" className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
                  Confirm New Password
                </label>
                <input
                  id="reset-confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, confirm: true }))}
                  disabled={isSubmitting}
                  placeholder="Re-enter your new password"
                  autoComplete="new-password"
                  className="w-full bg-ink px-4 py-3 border-b border-rule text-prose placeholder:text-prose-dim text-sm
                             focus:border-signal outline-none transition-colors disabled:opacity-40"
                />
                {fieldError(confirmError)}
              </div>

              {error && (
                <div className="flex items-start gap-2 text-xs font-mono text-fail bg-fail/5 border border-fail/30 px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <button
                id="btn-reset-password-submit"
                type="submit"
                disabled={!canSubmit || isSubmitting}
                className={submitButtonClasses(isSubmitting, canSubmit)}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Resetting...</span>
                  </>
                ) : (
                  <>
                    <KeyRound className="w-4 h-4" />
                    <span>Reset Password</span>
                  </>
                )}
              </button>
            </form>
          )}

          <a
            href="/"
            className="block w-full text-center font-mono text-[11px] text-prose-dim hover:text-prose-muted transition-colors"
          >
            ← Back to sign in
          </a>
        </div>
      </motion.div>
    </div>
  );
}

export default ResetPasswordScreen;
