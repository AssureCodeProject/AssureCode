import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { LogIn, Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

function submitButtonClasses(isSubmitting, canSubmit) {
  const base =
    'w-full py-3.5 font-mono font-bold text-sm tracking-wider uppercase transition-all flex items-center justify-center gap-2';
  if (isSubmitting) return `${base} bg-ink-3 text-prose-muted border border-rule cursor-wait`;
  if (canSubmit) return `${base} bg-signal text-ink hover:opacity-90 active:scale-[0.99]`;
  return `${base} bg-ink-3 text-prose-dim border border-rule cursor-not-allowed`;
}

export function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const canSubmit = Boolean(email.trim() && password);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
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
            Audit Ledger — Sign In
          </p>
        </div>

        <form onSubmit={handleSubmit} className="bg-ink-2 border border-rule p-6 sm:p-8 space-y-6">
          <div>
            <label htmlFor="login-email" className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
              Email
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isSubmitting}
              placeholder="client@acme.com"
              autoComplete="username"
              className="w-full bg-ink px-4 py-3 border-b border-rule text-prose placeholder:text-prose-dim text-sm
                         focus:border-signal outline-none transition-colors disabled:opacity-40"
            />
          </div>

          <div>
            <label htmlFor="login-password" className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isSubmitting}
              placeholder="••••••••"
              autoComplete="current-password"
              className="w-full bg-ink px-4 py-3 border-b border-rule text-prose placeholder:text-prose-dim text-sm
                         focus:border-signal outline-none transition-colors disabled:opacity-40"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 text-xs font-mono text-fail bg-fail/5 border border-fail/30 px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            id="btn-login-submit"
            type="submit"
            disabled={!canSubmit || isSubmitting}
            className={submitButtonClasses(isSubmitting, canSubmit)}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Signing in...</span>
              </>
            ) : (
              <>
                <LogIn className="w-4 h-4" />
                <span>Sign In</span>
              </>
            )}
          </button>
        </form>

        <p className="text-center font-mono text-[11px] text-prose-dim mt-4">
          Demo accounts only — seeded via tools/seed-users.py. No self-signup.
        </p>
      </motion.div>
    </div>
  );
}

export default LoginScreen;
