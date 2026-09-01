import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { FolderKanban, RotateCcw, AlertTriangle, FileText, Download, Activity } from 'lucide-react';

import { callApi, downloadFile } from '../utils/api';
import { GlassCard } from './ui/GlassCard';
import { StatusBadge } from './ui/StatusBadge';
import { FuturisticButton } from './ui/FuturisticButton';
import { ContractDetailsDrawer } from './ContractDetailsDrawer';
import { ContactParticipantButton } from './ContactParticipantButton';
import { formatMinor } from './EscrowFundingPanel';

const STATUS_VARIANT = {
  DRAFT: 'neutral',
  LOCKED: 'signal',
  ACTIVE: 'signal',
  IN_PROGRESS: 'signal',
  COMPLETED: 'signal',
  DISPUTED: 'danger',
};

function formatDeadline(deadline) {
  if (!deadline) return '—';
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return deadline;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTimestamp(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * ContractCard — one contract row on the client's My Contracts page. Status
 * badge and body text reflect the actual assignmentStatus this contract's
 * GET /api/contracts/owned row carries; nothing here is fabricated for a
 * contract that hasn't reached that state yet (e.g. no freelancer assigned).
 */
function ContractCard({ contract, onViewDetails, onOpenVerification }) {
  const isPending = contract.assignmentStatus === 'PENDING';
  const isAccepted = contract.assignmentStatus === 'ACCEPTED';
  const isRejected = contract.assignmentStatus === 'REJECTED';

  let badgeVariant = STATUS_VARIANT[contract.status] || 'neutral';
  let badgeLabel = contract.status;
  if (isPending) {
    badgeVariant = 'warning';
    badgeLabel = 'PENDING ACCEPTANCE';
  } else if (isRejected) {
    badgeVariant = 'danger';
    badgeLabel = 'REJECTED';
  }

  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
      <GlassCard className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-prose font-semibold truncate">{contract.title}</span>
              <StatusBadge variant={badgeVariant} size="sm">
                {badgeLabel}
              </StatusBadge>
            </div>
            <div className="font-mono text-[11px] text-prose-muted flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>ID: {contract.contractId}</span>
              <span>{formatMinor(contract.budgetCents)}</span>
              <span>due {formatDeadline(contract.deadline)}</span>
              {contract.freelancerDisplayName && <span>freelancer: {contract.freelancerDisplayName}</span>}
            </div>
          </div>
        </div>

        <div className="mt-2 font-mono text-[11px] text-prose-muted">
          {!contract.freelancerId && 'No freelancer assigned yet.'}
          {contract.freelancerId && isPending && 'Awaiting freelancer response.'}
          {isAccepted && formatTimestamp(contract.decidedAt) && (
            <>
              Freelancer accepted the contract.
              <br />
              Accepted: {formatTimestamp(contract.decidedAt)}
            </>
          )}
          {isRejected && (
            <>
              Freelancer declined the contract.
              <br />
              Rejected: {formatTimestamp(contract.decidedAt)}
              {contract.rejectionReasonText && (
                <>
                  <br />
                  Reason: {contract.rejectionReasonText}
                </>
              )}
            </>
          )}
        </div>

        <div className="mt-3 pt-3 border-t border-rule flex flex-wrap items-center gap-2">
          {isAccepted && (
            <FuturisticButton
              variant="primary"
              size="sm"
              icon={Activity}
              onClick={() => onOpenVerification(contract)}
            >
              View Verification &amp; Trust Score
            </FuturisticButton>
          )}
          <FuturisticButton variant="secondary" size="sm" icon={FileText} onClick={() => onViewDetails(contract.contractId)}>
            View Contract Details
          </FuturisticButton>
          <FuturisticButton
            variant="secondary"
            size="sm"
            icon={Download}
            onClick={() =>
              downloadFile(`/api/contracts/${contract.contractId}/assignment-pdf`, `${contract.contractId}-contract-record.pdf`)
            }
          >
            Download Contract Record
          </FuturisticButton>
          {/* Contact stays available once a freelancer has been assigned and
              hasn't declined -- an unassigned contract has no one to email,
              and a rejected freelancer is no longer engaged on this contract. */}
          {contract.freelancerId && !isRejected && (
            <ContactParticipantButton contractId={contract.contractId} viewerRole="client" />
          )}
        </div>
      </GlassCard>
    </motion.div>
  );
}

/**
 * ClientContracts — "My Contracts": the client-side counterpart to
 * FreelancerAssignments. Lists contracts the signed-in client owns
 * (GET /api/contracts/owned) with the freelancer's assignment decision and
 * repository status alongside each one. Not an analytics dashboard --
 * one focused list, same visual conventions as the freelancer's Assignments
 * page.
 */
export function ClientContracts({ onSelectContract }) {
  const [contracts, setContracts] = useState([]);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [errorMessage, setErrorMessage] = useState('');
  const [detailsContractId, setDetailsContractId] = useState(null);

  const loadContracts = () => {
    setStatus('loading');
    callApi('/api/contracts/owned')
      .then((data) => {
        setContracts(data.contracts || []);
        setStatus('ready');
      })
      .catch((err) => {
        setErrorMessage(err.message || 'Unable to load your contracts.');
        setStatus('error');
      });
  };

  useEffect(() => {
    loadContracts();
  }, []);

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6 flex items-center gap-2 font-mono text-xs text-prose-muted">
        <FolderKanban className="w-4 h-4 text-signal" />
        <span>MY CONTRACTS</span>
      </div>

      {status === 'loading' && (
        <GlassCard className="p-8 text-center font-mono text-sm text-prose-muted">Loading your contracts...</GlassCard>
      )}

      {status === 'error' && (
        <GlassCard className="p-8 text-center font-mono text-sm">
          <AlertTriangle className="w-5 h-5 text-fail mx-auto mb-3" />
          <p className="text-prose mb-4">{errorMessage}</p>
          <FuturisticButton variant="secondary" size="sm" icon={RotateCcw} onClick={loadContracts}>
            [retry]
          </FuturisticButton>
        </GlassCard>
      )}

      {status === 'ready' && contracts.length === 0 && (
        <GlassCard className="p-8 text-center font-mono text-sm text-prose-muted">
          No contracts yet. Create one from Contract Initialization.
        </GlassCard>
      )}

      {status === 'ready' && contracts.length > 0 && (
        <div className="space-y-3">
          {contracts.map((contract) => (
            <ContractCard
              key={contract.contractId}
              contract={contract}
              onViewDetails={setDetailsContractId}
              onOpenVerification={onSelectContract}
            />
          ))}
        </div>
      )}

      <ContractDetailsDrawer
        contractId={detailsContractId}
        isOpen={Boolean(detailsContractId)}
        onClose={() => setDetailsContractId(null)}
        viewerRole="client"
      />
    </div>
  );
}

export default ClientContracts;
