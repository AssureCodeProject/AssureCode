import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { LogIn, Loader2, AlertCircle, Github, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

/** Surfaced from GithubCallback's redirect back here on failure (?error=...). */
function githubErrorMessage(code) {
  if (code === 'github_no_email') return 'Your GitHub account has no email address AssureCode can use.';
  if (code === 'github_oauth_failed') return 'GitHub sign-in failed. Please try again.';
  return null;
}

function submitButtonClasses(isSubmitting, canSubmit) {
  const base =
    'w-full py-3.5 font-mono font-bold text-sm tracking-wider uppercase transition-all flex items-center justify-center gap-2';
  if (isSubmitting) return `${base} bg-ink-3 text-prose-muted border border-rule cursor-wait`;
  if (canSubmit) return `${base} bg-signal text-ink hover:opacity-90 active:scale-[0.99]`;
  return `${base} bg-ink-3 text-prose-dim border border-rule cursor-not-allowed`;
}

export function LoginScreen() {
  const { login, completeMfaChallenge } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Set once POST /auth/login answers {mfaRequired: true, challenge} instead
  // of a session — the form below swaps to a code prompt while this is set,
  // and nothing is signed in yet until completeMfaChallenge succeeds.
  const [mfaChallenge, setMfaChallenge] = useState(null);
  const [mfaCode, setMfaCode] = useState('');

  const canSubmit = Boolean(email.trim() && password);
  const canSubmitMfa = mfaCode.trim().length > 0;

  const githubError = githubErrorMessage(new URLSearchParams(window.location.search).get('error'));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await login(email.trim(), password);
      if (result.mfaRequired) {
        setMfaChallenge(result.challenge);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleMfaSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmitMfa || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await completeMfaChallenge(mfaChallenge, mfaCode.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBackToLogin = () => {
    setMfaChallenge(null);
    setMfaCode('');
    setError(null);
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

        {mfaChallenge ? (
          <form onSubmit={handleMfaSubmit} className="bg-ink-2 border border-rule p-6 sm:p-8 space-y-6">
            <div className="flex items-center gap-2 text-prose-muted">
              <ShieldCheck className="w-4 h-4 text-signal shrink-0" />
              <p className="text-xs font-mono">
                Enter the 6-digit code from your authenticator app.
              </p>
            </div>

            <div>
              <label htmlFor="login-mfa-code" className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
                Authentication Code
              </label>
              <input
                id="login-mfa-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                disabled={isSubmitting}
                placeholder="123456"
                maxLength={6}
                autoFocus
                className="w-full bg-ink px-4 py-3 border-b border-rule text-prose placeholder:text-prose-dim text-sm
                           tracking-[0.3em] text-center focus:border-signal outline-none transition-colors disabled:opacity-40"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 text-xs font-mono text-fail bg-fail/5 border border-fail/30 px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              id="btn-mfa-submit"
              type="submit"
              disabled={!canSubmitMfa || isSubmitting}
              className={submitButtonClasses(isSubmitting, canSubmitMfa)}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Verifying...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  <span>Verify Code</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleBackToLogin}
              disabled={isSubmitting}
              className="w-full text-center font-mono text-[11px] text-prose-dim hover:text-prose-muted transition-colors disabled:opacity-40"
            >
              ← Back to sign in
            </button>
          </form>
        ) : (
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

            {(error || githubError) && (
              <div className="flex items-start gap-2 text-xs font-mono text-fail bg-fail/5 border border-fail/30 px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{error || githubError}</span>
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

            <div className="flex items-center gap-3 text-[10px] font-mono text-prose-dim uppercase tracking-widest">
              <div className="h-px flex-1 bg-rule" />
              <span>or</span>
              <div className="h-px flex-1 bg-rule" />
            </div>

            <a
              id="btn-login-github"
              href="/auth/github"
              className="w-full py-3.5 font-mono font-bold text-sm tracking-wider uppercase transition-all
                         flex items-center justify-center gap-2 border border-rule text-prose hover:border-rule-hi hover:bg-ink-3/40"
            >
              <Github className="w-4 h-4" />
              <span>Continue with GitHub</span>
            </a>
          </form>
        )}

        {!mfaChallenge && (
          <p className="text-center font-mono text-[11px] text-prose-dim mt-4">
            Demo accounts sign in above — seeded via tools/seed-users.py. Freelancers can also
            continue with GitHub, no self-signup needed either way.
          </p>
        )}
      </motion.div>
    </div>
  );
}

export default LoginScreen;
