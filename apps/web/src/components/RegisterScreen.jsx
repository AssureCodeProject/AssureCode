import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { UserPlus, Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { validateEmail, validateNewPassword, PASSWORD_HELPER_TEXT } from '../utils/passwordPolicy';

function submitButtonClasses(isSubmitting, canSubmit) {
  const base =
    'w-full py-3.5 font-mono font-bold text-sm tracking-wider uppercase transition-all flex items-center justify-center gap-2';
  if (isSubmitting) return `${base} bg-ink-3 text-prose-muted border border-rule cursor-wait`;
  if (canSubmit) return `${base} bg-signal text-ink hover:opacity-90 active:scale-[0.99]`;
  return `${base} bg-ink-3 text-prose-dim border border-rule cursor-not-allowed`;
}

function roleButtonClasses(selected) {
  const base = 'flex-1 py-3 font-mono text-xs uppercase tracking-wider border transition-colors';
  return selected
    ? `${base} border-signal text-signal bg-signal/5`
    : `${base} border-rule text-prose-muted hover:border-rule-hi hover:text-prose`;
}

function fieldError(message) {
  if (!message) return null;
  return <p className="mt-1.5 font-mono text-[11px] text-fail">{message}</p>;
}

/** Mirrors LoginScreen's shape and styling; swapped in by its "create an account" toggle. */
export function RegisterScreen({ onSwitchToLogin }) {
  const { register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState('client');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // Field-level messages only show once the user has interacted with a
  // field (or attempted submit) -- showing "Password is required" before
  // anyone has typed anything is just noise.
  const [touched, setTouched] = useState({ email: false, password: false, confirmPassword: false });

  const emailError = touched.email ? validateEmail(email) : null;
  const passwordError = touched.password ? validateNewPassword(password) : null;
  const confirmError = touched.confirmPassword
    ? (!confirmPassword ? 'Please confirm your password.' : password !== confirmPassword ? 'Passwords do not match.' : null)
    : null;

  const canSubmit = Boolean(
    email.trim() &&
      !validateEmail(email) &&
      password &&
      !validateNewPassword(password) &&
      confirmPassword &&
      password === confirmPassword,
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    setTouched({ email: true, password: true, confirmPassword: true });
    if (!canSubmit || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await register(email.trim(), password, role);
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
            Audit Ledger — Create Account
          </p>
        </div>

        <form onSubmit={handleSubmit} className="bg-ink-2 border border-rule p-6 sm:p-8 space-y-6">
          <div>
            <label className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
              I am a
            </label>
            <div className="flex gap-2">
              <button
                id="btn-role-client"
                type="button"
                onClick={() => setRole('client')}
                disabled={isSubmitting}
                className={roleButtonClasses(role === 'client')}
              >
                Client
              </button>
              <button
                id="btn-role-freelancer"
                type="button"
                onClick={() => setRole('freelancer')}
                disabled={isSubmitting}
                className={roleButtonClasses(role === 'freelancer')}
              >
                Freelancer
              </button>
            </div>
            {role === 'freelancer' && (
              <p className="mt-2 font-mono text-[11px] text-prose-dim">
                You'll need to connect GitHub before you can be assigned a contract.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="register-email" className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
              Email
            </label>
            <input
              id="register-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              disabled={isSubmitting}
              placeholder="you@example.com"
              autoComplete="username"
              className="w-full bg-ink px-4 py-3 border-b border-rule text-prose placeholder:text-prose-dim text-sm
                         focus:border-signal outline-none transition-colors disabled:opacity-40"
            />
            {fieldError(emailError)}
          </div>

          <div>
            <label htmlFor="register-password" className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
              Password
            </label>
            <input
              id="register-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
            <label htmlFor="register-confirm-password" className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
              Confirm Password
            </label>
            <input
              id="register-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, confirmPassword: true }))}
              disabled={isSubmitting}
              placeholder="Re-enter your password"
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
            id="btn-register-submit"
            type="submit"
            disabled={!canSubmit || isSubmitting}
            className={submitButtonClasses(isSubmitting, canSubmit)}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Creating account...</span>
              </>
            ) : (
              <>
                <UserPlus className="w-4 h-4" />
                <span>Create Account</span>
              </>
            )}
          </button>

          <button
            id="btn-back-to-login"
            type="button"
            onClick={onSwitchToLogin}
            disabled={isSubmitting}
            className="w-full text-center font-mono text-[11px] text-prose-dim hover:text-prose-muted transition-colors disabled:opacity-40"
          >
            ← Already have an account? Sign in
          </button>
        </form>
      </motion.div>
    </div>
  );
}

export default RegisterScreen;
