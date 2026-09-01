import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Briefcase, RotateCcw, ChevronRight, AlertTriangle, Github, CheckCircle2, Wallet, GitBranch, Copy,
  FileText, Download, XCircle,
} from 'lucide-react';

import { callApi, downloadFile } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { GlassCard } from './ui/GlassCard';
import { StatusBadge } from './ui/StatusBadge';
import { FuturisticButton } from './ui/FuturisticButton';
import { ContractDetailsDrawer } from './ContractDetailsDrawer';
import { ContactParticipantButton } from './ContactParticipantButton';

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

const REJECTION_REASONS = [
  { code: 'DEADLINE_INFEASIBLE', label: 'Deadline is not feasible' },
  { code: 'OUTSIDE_EXPERTISE', label: 'Requirements are outside my expertise' },
  { code: 'COMPENSATION_MISMATCH', label: 'Compensation does not match the scope' },
  { code: 'UNAVAILABLE', label: 'Unable to take this project currently' },
  { code: 'OTHER', label: 'Other' },
];

/**
 * AssignmentActions — the "AWAITING YOUR DECISION" card body: View Details /
 * Download PDF / Reject / Accept, plus each decision's inline confirmation
 * step. Deliberately not window.confirm()/alert() — native dialogs freeze
 * this app's browser-automation session and are worse UX than an inline
 * state anyway.
 */
function AssignmentActions({ contract, onDecided }) {
  const [mode, setMode] = useState('idle'); // idle | confirmAccept | confirmReject
  const [submitting, setSubmitting] = useState(false);
  const [reasonCode, setReasonCode] = useState('DEADLINE_INFEASIBLE');
  const [reasonText, setReasonText] = useState('');
  const [error, setError] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);

  const handleAccept = async () => {
    setSubmitting(true);
    setError('');
    try {
      await callApi(`/api/contracts/${contract.contractId}/assignment/accept`, 'POST');
      onDecided();
    } catch (err) {
      setError(err.message || 'Failed to accept contract');
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    setSubmitting(true);
    setError('');
    try {
      await callApi(`/api/contracts/${contract.contractId}/assignment/reject`, 'POST', {
        reasonCode,
        reasonText: reasonCode === 'OTHER' ? reasonText : undefined,
      });
      onDecided();
    } catch (err) {
      setError(err.message || 'Failed to reject contract');
      setSubmitting(false);
    }
  };

  const stop = (e) => e.stopPropagation();

  return (
    <div className="mt-3 pt-3 border-t border-rule" onClick={stop}>
      {mode === 'idle' && (
        <div className="flex flex-wrap items-center gap-2">
          <FuturisticButton variant="secondary" size="sm" icon={FileText} onClick={() => setDetailsOpen(true)}>
            View Contract Details
          </FuturisticButton>
          <FuturisticButton
            variant="secondary"
            size="sm"
            icon={Download}
            onClick={() =>
              downloadFile(`/api/contracts/${contract.contractId}/assignment-pdf`, `${contract.contractId}-contract-record.pdf`).catch(
                (err) => setError(err.message || 'Failed to download Contract Record'),
              )
            }
          >
            Download Contract Record
          </FuturisticButton>
          <ContactParticipantButton contractId={contract.contractId} viewerRole="freelancer" />
          <div className="flex-1 min-w-[8px]" />
          <FuturisticButton variant="danger" size="sm" icon={XCircle} onClick={() => setMode('confirmReject')}>
            Reject Contract
          </FuturisticButton>
          <FuturisticButton variant="primary" size="sm" icon={CheckCircle2} onClick={() => setMode('confirmAccept')}>
            Accept Contract
          </FuturisticButton>
        </div>
      )}

      {mode === 'confirmAccept' && (
        <div className="space-y-2">
          <p className="font-mono text-[11px] text-prose">
            Accept Contract? By accepting this assignment, you confirm that you have reviewed the contract
            requirements, scope, deliverables, amount, and deadline.
          </p>
          <div className="flex gap-2">
            <FuturisticButton variant="secondary" size="sm" disabled={submitting} onClick={() => setMode('idle')}>
              Cancel
            </FuturisticButton>
            <FuturisticButton
              variant="primary"
              size="sm"
              icon={CheckCircle2}
              loading={submitting}
              loadingText="Accepting..."
              onClick={handleAccept}
            >
              Confirm Acceptance
            </FuturisticButton>
          </div>
        </div>
      )}

      {mode === 'confirmReject' && (
        <div className="space-y-2">
          <p className="font-mono text-[11px] text-prose">Why are you declining this contract?</p>
          <div className="space-y-1">
            {REJECTION_REASONS.map((r) => (
              <label
                key={r.code}
                className="flex items-center gap-2 font-mono text-[11px] text-prose-muted cursor-pointer"
              >
                <input
                  type="radio"
                  name={`reject-reason-${contract.contractId}`}
                  checked={reasonCode === r.code}
                  onChange={() => setReasonCode(r.code)}
                />
                {r.label}
              </label>
            ))}
          </div>
          {reasonCode === 'OTHER' && (
            <textarea
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              placeholder="Please explain..."
              rows={2}
              className="w-full bg-ink border border-rule p-2 font-mono text-[11px] text-prose"
            />
          )}
          <div className="flex gap-2">
            <FuturisticButton variant="secondary" size="sm" disabled={submitting} onClick={() => setMode('idle')}>
              Cancel
            </FuturisticButton>
            <FuturisticButton
              variant="danger"
              size="sm"
              icon={XCircle}
              loading={submitting}
              loadingText="Rejecting..."
              disabled={reasonCode === 'OTHER' && !reasonText.trim()}
              onClick={handleReject}
            >
              Confirm Rejection
            </FuturisticButton>
          </div>
        </div>
      )}

      {error && <p className="mt-2 font-mono text-[11px] text-fail">{error}</p>}

      <ContractDetailsDrawer
        contractId={contract.contractId}
        isOpen={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        viewerRole="freelancer"
      />
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
          {assignments.map((contract) => {
            // A contract awaiting the freelancer's accept/reject decision, or
            // one they already declined, gets a different card body entirely
            // -- no whole-card click-through to Phase 2-4 (nothing has
            // started yet), and the accept/reject/details/PDF actions instead
            // of the repo workspace. Everything else (ACCEPTED, or
            // assignmentStatus === null for assignments made before this
            // migration) renders exactly as before.
            const isPending = contract.assignmentStatus === 'PENDING';
            const isRejected = contract.assignmentStatus === 'REJECTED';

            if (isPending || isRejected) {
              return (
                <motion.div key={contract.contractId} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
                  <GlassCard className="p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-prose font-semibold truncate">{contract.title}</span>
                          <StatusBadge variant={isPending ? 'warning' : 'danger'} size="sm">
                            {isPending ? 'AWAITING YOUR DECISION' : 'DECLINED'}
                          </StatusBadge>
                        </div>
                        <div className="font-mono text-[11px] text-prose-muted flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span>ID: {contract.contractId}</span>
                          <span>${formatBudget(contract.budgetCents)} USD</span>
                          <span>due {formatDeadline(contract.deadline)}</span>
                          {contract.clientDisplayName && <span>client: {contract.clientDisplayName}</span>}
                        </div>
                      </div>
                    </div>
                    {contract.requirementsSummary && (
                      <p className="mt-2 font-mono text-[11px] text-prose-muted">
                        {contract.requirementsSummary}
                        {contract.requirementsSummary.length >= 240 ? '…' : ''}
                      </p>
                    )}
                    {isPending && <AssignmentActions contract={contract} onDecided={loadAssignments} />}
                    {isRejected && (
                      <p className="mt-3 pt-3 border-t border-rule font-mono text-[11px] text-prose-muted">
                        You declined this contract. It is no longer active for you.
                      </p>
                    )}
                  </GlassCard>
                </motion.div>
              );
            }

            return (
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
            );
          })}
        </div>
      )}
    </div>
  );
}

export default FreelancerAssignments;
