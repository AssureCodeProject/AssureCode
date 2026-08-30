import { CheckCircle2, RotateCcw } from 'lucide-react';

/**
 * Landing page for the two redirect targets POST /api/kyc/connect-onboarding
 * hands the payout provider (see server.ts): returnUrl (/connect/return) on
 * completion and refreshUrl (/connect/refresh) when a link expired before the
 * freelancer finished. Without this, both paths rendered the ordinary app
 * shell with the query string silently ignored — no confirmation the account
 * is actually usable, and no way back in from a dead link.
 */
export function ConnectReturn() {
  const isRefresh = window.location.pathname === '/connect/refresh';
  const params = new URLSearchParams(window.location.search);
  const accountId = params.get('account_id');
  const status = params.get('status');

  return (
    <div className="min-h-screen bg-ink text-prose flex items-center justify-center font-mono text-xs px-4">
      <div className="max-w-sm w-full flex flex-col items-center gap-4 text-center">
        {isRefresh ? (
          <>
            <RotateCcw className="w-6 h-6 text-warn" />
            <p className="text-prose">
              That payout onboarding link expired before you finished. Head back and start it again.
            </p>
          </>
        ) : (
          <>
            <CheckCircle2 className="w-6 h-6 text-signal" />
            <p className="text-prose">
              {status === 'completed' || status === 'verified'
                ? 'Payout account connected.'
                : 'Payout onboarding step recorded.'}
            </p>
            {accountId && <p className="text-prose-muted">Account: {accountId}</p>}
          </>
        )}
        <a href="/" className="text-signal underline underline-offset-2">
          Back to AssureCode
        </a>
      </div>
    </div>
  );
}

export default ConnectReturn;
