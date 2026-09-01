import React, { useEffect, useRef, useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

/**
 * Landing page for the link mailed by registration's verification email.
 * Same shape as GithubCallback.jsx: read the token from the URL, redeem it
 * once, show the result. Mounted by App.jsx when
 * `window.location.pathname === '/verify-email'`.
 */
export function VerifyEmailScreen() {
  const { verifyEmail } = useAuth();
  const [status, setStatus] = useState('loading'); // 'loading' | 'success' | 'error'
  const [error, setError] = useState(null);
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setStatus('error');
      setError('This verification link is missing its token.');
      return;
    }

    verifyEmail(token)
      .then(() => setStatus('success'))
      .catch((err) => {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [verifyEmail]);

  return (
    <div className="min-h-screen bg-ink text-prose flex items-center justify-center font-mono text-xs px-4">
      <div className="max-w-sm w-full flex flex-col items-center gap-4 text-center">
        {status === 'loading' && (
          <div className="flex items-center gap-2 text-prose-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Verifying your email...</span>
          </div>
        )}
        {status === 'success' && (
          <div className="flex items-start gap-2 text-signal bg-signal/5 border border-signal/30 px-3 py-2">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>Your email address has been verified.</span>
          </div>
        )}
        {status === 'error' && (
          <div className="flex items-start gap-2 text-fail bg-fail/5 border border-fail/30 px-3 py-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        <a href="/" className="text-signal underline underline-offset-2">
          Back to AssureCode
        </a>
      </div>
    </div>
  );
}

export default VerifyEmailScreen;
