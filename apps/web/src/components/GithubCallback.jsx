import React, { useEffect, useRef, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

/**
 * Landing page for GET /auth/github/callback's redirect (see server.ts).
 * The gateway hands back a short-lived one-time code in the URL rather than
 * a real JWT, so this page's whole job is redeeming it via
 * completeGithubLogin() and then getting out of the way.
 */
export function GithubCallback() {
  const { completeGithubLogin } = useAuth();
  const [error, setError] = useState(null);
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const oauthError = params.get('error');

    if (oauthError) {
      setError(`GitHub sign-in failed: ${oauthError}`);
      return;
    }
    if (!code) {
      setError('Missing GitHub sign-in code.');
      return;
    }

    completeGithubLogin(code)
      .then(() => {
        window.location.replace('/');
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [completeGithubLogin]);

  return (
    <div className="min-h-screen bg-ink text-prose flex items-center justify-center font-mono text-xs px-4">
      {error ? (
        <div className="max-w-sm w-full flex flex-col items-center gap-4 text-center">
          <div className="flex items-start gap-2 text-fail bg-fail/5 border border-fail/30 px-3 py-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
          <a href="/" className="text-signal underline underline-offset-2">
            Back to sign in
          </a>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-prose-muted">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Completing GitHub sign-in...</span>
        </div>
      )}
    </div>
  );
}

export default GithubCallback;
