import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Mail, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { validateEmail } from '../utils/passwordPolicy';

function submitButtonClasses(isSubmitting, canSubmit) {
  const base =
    'w-full py-3.5 font-mono font-bold text-sm tracking-wider uppercase transition-all flex items-center justify-center gap-2';
  if (isSubmitting) return `${base} bg-ink-3 text-prose-muted border border-rule cursor-wait`;
  if (canSubmit) return `${base} bg-signal text-ink hover:opacity-90 active:scale-[0.99]`;
  return `${base} bg-ink-3 text-prose-dim border border-rule cursor-not-allowed`;
}

/**
 * Mirrors LoginScreen's shape/styling. The gateway always answers with the
 * same generic message regardless of whether the email is registered — this
 * screen shows exactly that message and nothing more specific, on purpose.
 */
export function ForgotPasswordScreen({ onBackToLogin }) {
  const { forgotPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [touched, setTouched] = useState(false);

  const emailError = touched ? validateEmail(email) : null;
  const canSubmit = Boolean(email.trim() && !validateEmail(email));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await forgotPassword(email.trim());
      setMessage(res.message || 'If an account exists for this email, password reset instructions have been sent.');
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
            Reset Your Password
          </p>
        </div>

        <div className="bg-ink-2 border border-rule p-6 sm:p-8 space-y-6">
          {message ? (
            <div className="flex items-start gap-2 text-xs font-mono text-signal bg-signal/5 border border-signal/30 px-3 py-2">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{message}</span>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              <p className="font-mono text-[11px] text-prose-dim">
                Enter the email address on your account and we'll send you a link to reset your password.
              </p>
              <div>
                <label htmlFor="forgot-email" className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
                  Email
                </label>
                <input
                  id="forgot-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => setTouched(true)}
                  disabled={isSubmitting}
                  placeholder="you@example.com"
                  autoComplete="username"
                  className="w-full bg-ink px-4 py-3 border-b border-rule text-prose placeholder:text-prose-dim text-sm
                             focus:border-signal outline-none transition-colors disabled:opacity-40"
                />
                {emailError && <p className="mt-1.5 font-mono text-[11px] text-fail">{emailError}</p>}
              </div>

              {error && (
                <div className="flex items-start gap-2 text-xs font-mono text-fail bg-fail/5 border border-fail/30 px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <button
                id="btn-forgot-password-submit"
                type="submit"
                disabled={!canSubmit || isSubmitting}
                className={submitButtonClasses(isSubmitting, canSubmit)}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Sending...</span>
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4" />
                    <span>Send Reset Link</span>
                  </>
                )}
              </button>
            </form>
          )}

          <button
            id="btn-back-to-login-from-forgot"
            type="button"
            onClick={onBackToLogin}
            className="w-full text-center font-mono text-[11px] text-prose-dim hover:text-prose-muted transition-colors"
          >
            ← Back to sign in
          </button>
        </div>
      </motion.div>
    </div>
  );
}

export default ForgotPasswordScreen;
