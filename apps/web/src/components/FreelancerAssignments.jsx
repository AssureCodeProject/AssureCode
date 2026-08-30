import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Briefcase, RotateCcw, ChevronRight, AlertTriangle, Github, CheckCircle2, Wallet } from 'lucide-react';

import { callApi } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { GlassCard } from './ui/GlassCard';
import { StatusBadge } from './ui/StatusBadge';
import { FuturisticButton } from './ui/FuturisticButton';

const STATUS_VARIANT = {
  DRAFT: 'neutral',
  LOCKED: 'signal',
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
 * GithubConnectCard — surfaces whether the signed-in freelancer has a usable
 * GitHub OAuth token on file. Without one, server.ts's auto webhook
 * registration for a contract's linked repo silently skips them (see the
 * comment at the freelancer-token lookup in PATCH .../github-repo) — this is
 * the only UI path that gets that token stored for an account that signed up
 * with email/password instead of "Continue with GitHub".
 */
function GithubConnectCard() {
  const [githubConnected, setGithubConnected] = useState(null); // null = loading

  useEffect(() => {
    callApi('/auth/me')
      .then((data) => setGithubConnected(Boolean(data.githubConnected)))
      .catch(() => setGithubConnected(null));
  }, []);

  if (githubConnected === null) return null;

  if (githubConnected) {
    return (
      <GlassCard className="mb-6 p-4 flex items-center gap-2 font-mono text-xs text-prose-muted">
        <CheckCircle2 className="w-4 h-4 text-signal shrink-0" />
        <span>GitHub connected — auto webhook registration is available on repos linked to your contracts.</span>
      </GlassCard>
    );
  }

  return (
    <GlassCard className="mb-6 p-4 flex flex-wrap items-center justify-between gap-3">
      <div className="font-mono text-xs text-prose-muted max-w-md">
        <span className="text-prose font-semibold block mb-1">GitHub not connected</span>
        Connect it so a repo a client links to your contract gets its verification
        webhook registered automatically. Uses your GitHub account's primary
        email — make sure it matches this AssureCode account's email.
      </div>
      <a
        href="/auth/github"
        className="inline-flex items-center gap-2 px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-wider
                   border border-rule text-prose hover:border-rule-hi hover:bg-ink-3/40 transition-colors shrink-0"
      >
        <Github className="w-3.5 h-3.5" />
        <span>Connect GitHub</span>
      </a>
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
            <motion.button
              key={contract.contractId}
              onClick={() => onSelectContract(contract)}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full text-left"
            >
              <GlassCard className="p-4 flex items-center justify-between gap-4 hover:border-rule-hi transition-colors">
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
              </GlassCard>
            </motion.button>
          ))}
        </div>
      )}
    </div>
  );
}

export default FreelancerAssignments;
