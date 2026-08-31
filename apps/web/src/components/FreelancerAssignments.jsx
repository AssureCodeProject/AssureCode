import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Briefcase, RotateCcw, ChevronRight, AlertTriangle, Github, CheckCircle2, Wallet, GitBranch, Copy } from 'lucide-react';

import { callApi } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { GlassCard } from './ui/GlassCard';
import { StatusBadge } from './ui/StatusBadge';
import { FuturisticButton } from './ui/FuturisticButton';

const STATUS_VARIANT = {
  DRAFT: 'neutral',
  LOCKED: 'signal',
  ACTIVE: 'signal',
  IN_PROGRESS: 'signal',
  COMPLETED: 'signal',
  DISPUTED: 'danger',
};

function formatBudget(budgetCents) {
  return (Number(budgetCents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
}

function formatDeadline(deadline) {
  if (!deadline) return '—';
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return deadline;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * GithubConnectCard — surfaces the freelancer's GitHub connection state via
 * GET /api/freelancer/github-status: NOT_CONNECTED, CONNECTED, or
 * RECONNECTION_REQUIRED (the github_login on file stopped resolving — see
 * settlement-worker's attemptProvisioning, which flips token_valid=false on
 * a 404 "unknown user" adding this freelancer as a repo collaborator). A
 * linked GitHub identity is required before a contract can be provisioned a
 * repository at all (GITHUB_ACCOUNT_REQUIRED in worker.ts).
 */
/** Surfaced from the OAuth callback's redirect back here on failure (?error=...). */
function githubLinkErrorMessage(code) {
  if (code === 'github_already_linked') {
    return 'That GitHub account is already connected to a different AssureCode account.';
  }
  if (code === 'github_no_email') return 'That GitHub account has no email address AssureCode can use.';
  if (code === 'github_oauth_failed') return 'GitHub connection failed. Please try again.';
  return null;
}

function GithubConnectCard() {
  const [status, setStatus] = useState(null); // null = loading
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState(
    githubLinkErrorMessage(new URLSearchParams(window.location.search).get('error')) || '',
  );

  useEffect(() => {
    callApi('/api/freelancer/github-status')
      .then((data) => setStatus(data.status))
      .catch(() => setStatus(null));
  }, []);

  // Deliberately not a plain <a href="/auth/github">: that route is
  // unauthenticated and has no idea who was already logged in when clicked,
  // so on a browser with an existing GitHub session for a *different*
  // AssureCode account, it silently logs the caller into that other
  // account instead of linking GitHub to the one they're using. This fetches
  // an authenticated link-mode URL (bearer token attached, same as any other
  // API call) that carries the current user id through the OAuth round-trip,
  // then navigates the browser to it.
  const handleConnect = async () => {
    setIsStarting(true);
    setError('');
    try {
      const data = await callApi('/auth/github/link-url');
      window.location.href = data.url;
    } catch (err) {
      setError(err.message || 'Failed to start GitHub connection');
      setIsStarting(false);
    }
  };

  if (status === null) return null;

  if (status === 'CONNECTED') {
    return (
      <GlassCard className="mb-6 p-4 flex items-center gap-2 font-mono text-xs text-prose-muted">
        <CheckCircle2 className="w-4 h-4 text-signal shrink-0" />
        <span>GitHub connected — you're eligible for contract repository assignment.</span>
      </GlassCard>
    );
  }

  const isReconnect = status === 'RECONNECTION_REQUIRED';

  return (
    <GlassCard className="mb-6 p-4 flex flex-wrap items-center justify-between gap-3">
      <div className="font-mono text-xs text-prose-muted max-w-md">
        <span className="text-prose font-semibold block mb-1">
          {isReconnect ? 'Reconnection required' : 'GitHub not connected'}
        </span>
        {isReconnect
          ? "Your linked GitHub account could no longer be found — reconnect so you can be added to your contract's repository."
          : "Connect GitHub to prove your identity — required before you can be assigned a contract that provisions a repository."}
        {error && <span className="text-fail block mt-1">{error}</span>}
      </div>
      <FuturisticButton
        variant="secondary"
        size="sm"
        icon={Github}
        loading={isStarting}
        loadingText="Starting..."
        onClick={handleConnect}
        className="shrink-0"
      >
        {isReconnect ? 'Reconnect GitHub' : 'Connect GitHub'}
      </FuturisticButton>
    </GlassCard>
  );
}

/**
 * PayoutOnboardingCard — surfaces whether the freelancer has a payout
 * account on file (users.payout_account_id) and, if not, starts the
 * onboarding flow. Unlike GitHub, this needs a POST before there's anywhere
 * to send the browser — createPayoutAccount/createPayoutOnboardingLink only
 * exist once POST /api/kyc/connect-onboarding has run — so this is a button
 * with a click handler rather than a plain link.
 */
function PayoutOnboardingCard() {
  const { user } = useAuth();
  const [payoutAccountId, setPayoutAccountId] = useState(undefined); // undefined = loading
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    callApi('/auth/me')
      .then((data) => setPayoutAccountId(data.payoutAccountId ?? null))
      .catch(() => setPayoutAccountId(null));
  }, []);

  const handleConnect = async () => {
    setIsStarting(true);
    setError('');
    try {
      const data = await callApi('/api/kyc/connect-onboarding', 'POST', {
        userId: user.userId,
        email: user.email,
      });
      window.location.href = data.onboardingUrl;
    } catch (err) {
      setError(err.message || 'Failed to start payout onboarding');
      setIsStarting(false);
    }
  };

  if (payoutAccountId === undefined) return null;

  if (payoutAccountId) {
    return (
      <GlassCard className="mb-6 p-4 flex items-center gap-2 font-mono text-xs text-prose-muted">
        <CheckCircle2 className="w-4 h-4 text-signal shrink-0" />
        <span>Payout account connected — escrow releases can be sent to you.</span>
      </GlassCard>
    );
  }

  return (
    <GlassCard className="mb-6 p-4 flex flex-wrap items-center justify-between gap-3">
      <div className="font-mono text-xs text-prose-muted max-w-md">
        <span className="text-prose font-semibold block mb-1">Payout account not set up</span>
        Connect one so escrow releases on your contracts have somewhere to go.
        {error && <span className="text-fail block mt-1">{error}</span>}
      </div>
      <FuturisticButton
        variant="secondary"
        size="sm"
        icon={Wallet}
        loading={isStarting}
        loadingText="Starting..."
        onClick={handleConnect}
        className="shrink-0"
      >
        Set up payouts
      </FuturisticButton>
    </GlassCard>
  );
}

/**
 * RepoWorkspaceCard — polls GET /api/contracts/:id/repo-provisioning for one
 * assignment and shows the clone link once AssureCode has finished creating
 * the repo, adding this freelancer as an outside collaborator, and
 * attaching the audit webhook (settlement-worker's attemptProvisioning).
 * Renders nothing for a contract with no provisioning record at all (a 404
 * here just means this contract predates auto-provisioning or hasn't been
 * locked yet — not an error worth surfacing).
 */
function RepoWorkspaceCard({ contractId }) {
  const [provisioning, setProvisioning] = useState(undefined); // undefined = loading, null = no record
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const poll = () => {
      callApi(`/api/contracts/${contractId}/repo-provisioning`)
        .then((data) => {
          if (cancelled) return;
          setProvisioning(data);
          // Stop polling once terminal (COMPLETE or FAILED); otherwise keep
          // checking back while a provisioning attempt is still in flight.
          if (data.status !== 'COMPLETE' && data.status !== 'FAILED') {
            timer = setTimeout(poll, 5000);
          }
        })
        .catch(() => {
          if (!cancelled) setProvisioning(null);
        });
    };
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [contractId]);

  if (!provisioning) return null;

  const cloneUrl = provisioning.repoHtmlUrl ? `${provisioning.repoHtmlUrl}.git` : null;

  const handleCopy = (e) => {
    e.stopPropagation();
    if (!cloneUrl) return;
    navigator.clipboard?.writeText(`git clone ${cloneUrl}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (provisioning.status === 'FAILED') {
    return (
      <div className="mt-3 pt-3 border-t border-rule flex items-center gap-2 font-mono text-[11px] text-fail">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span>
          {provisioning.lastError === 'GITHUB_ACCOUNT_REQUIRED'
            ? 'Repository could not be provisioned: connect GitHub above first.'
            : 'Repository provisioning failed. Contact support.'}
        </span>
      </div>
    );
  }

  if (provisioning.status !== 'COMPLETE') {
    return (
      <div className="mt-3 pt-3 border-t border-rule flex items-center gap-2 font-mono text-[11px] text-prose-muted">
        <GitBranch className="w-3.5 h-3.5 shrink-0 animate-pulse" />
        <span>Provisioning your repository…</span>
      </div>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-rule">
      <div className="flex items-center gap-2 font-mono text-[11px] text-prose-muted mb-1.5">
        <GitBranch className="w-3.5 h-3.5 shrink-0 text-signal" />
        <span>Repository ready</span>
      </div>
      <div
        onClick={handleCopy}
        role="button"
        tabIndex={0}
        className="flex items-center justify-between gap-2 bg-ink px-3 py-2 border border-rule font-mono text-[11px]
                   text-prose cursor-pointer hover:border-rule-hi transition-colors"
      >
        <span className="truncate">git clone {cloneUrl}</span>
        <Copy className="w-3 h-3 shrink-0 text-prose-muted" />
      </div>
      {copied && <span className="font-mono text-[10px] text-signal mt-1 block">Copied</span>}
    </div>
  );
}

/**
 * FreelancerAssignments — Phase 1 landing for freelancer accounts.
 *
 * Lists contracts the signed-in freelancer has been assigned to
 * (GET /api/contracts/mine) and lets them load one into the shared
 * contractData state to proceed through Phases 2-4.
 */
export function FreelancerAssignments({ onSelectContract }) {
  const [assignments, setAssignments] = useState([]);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [errorMessage, setErrorMessage] = useState('');

  const loadAssignments = () => {
    setStatus('loading');
    callApi('/api/contracts/mine')
      .then((data) => {
        setAssignments(data.contracts || []);
        setStatus('ready');
      })
      .catch((err) => {
        setErrorMessage(err.message || 'Failed to load assignments');
        setStatus('error');
      });
  };

  useEffect(() => {
    loadAssignments();
  }, []);

  return (
    <div className="max-w-3xl mx-auto">
      <GithubConnectCard />
      <PayoutOnboardingCard />

      <div className="mb-6 flex items-center gap-2 font-mono text-xs text-prose-muted">
        <Briefcase className="w-4 h-4 text-signal" />
        <span>YOUR ASSIGNMENTS</span>
      </div>

      {status === 'loading' && (
        <GlassCard className="p-8 text-center font-mono text-sm text-prose-muted">
          Loading assignments...
        </GlassCard>
      )}

      {status === 'error' && (
        <GlassCard className="p-8 text-center font-mono text-sm">
          <AlertTriangle className="w-5 h-5 text-fail mx-auto mb-3" />
          <p className="text-prose mb-4">{errorMessage}</p>
          <FuturisticButton variant="secondary" size="sm" icon={RotateCcw} onClick={loadAssignments}>
            [retry]
          </FuturisticButton>
        </GlassCard>
      )}

      {status === 'ready' && assignments.length === 0 && (
        <GlassCard className="p-8 text-center font-mono text-sm text-prose-muted">
          No contracts assigned yet. A client will assign you to a contract before
          Phase 2-4 screens become available.
        </GlassCard>
      )}

      {status === 'ready' && assignments.length > 0 && (
        <div className="space-y-3">
          {assignments.map((contract) => (
            <motion.div
              key={contract.contractId}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <GlassCard className="p-4 hover:border-rule-hi transition-colors">
                <button
                  type="button"
                  onClick={() => onSelectContract(contract)}
                  className="w-full flex items-center justify-between gap-4 text-left"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-prose font-semibold truncate">{contract.title}</span>
                      <StatusBadge variant={STATUS_VARIANT[contract.status] || 'neutral'} size="sm">
                        {contract.status}
                      </StatusBadge>
                    </div>
                    <div className="font-mono text-[11px] text-prose-muted flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>ID: {contract.contractId}</span>
                      <span>${formatBudget(contract.budgetCents)} USD</span>
                      <span>due {formatDeadline(contract.deadline)}</span>
                      {contract.clientDisplayName && <span>client: {contract.clientDisplayName}</span>}
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-prose-muted shrink-0" />
                </button>
                <RepoWorkspaceCard contractId={contract.contractId} />
              </GlassCard>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

export default FreelancerAssignments;
