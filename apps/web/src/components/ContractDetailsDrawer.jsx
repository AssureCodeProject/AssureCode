import React, { useState, useEffect } from 'react';
import { Download } from 'lucide-react';
import { callApi, downloadFile } from '../utils/api';
import { MobileDrawer } from './ui/MobileDrawer';
import { FuturisticButton } from './ui/FuturisticButton';
import { ContactParticipantButton } from './ContactParticipantButton';
import { formatMinor } from './EscrowFundingPanel';

function formatDeadline(deadline) {
  if (!deadline) return '—';
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return deadline;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function DetailRow({ label, value }) {
  return (
    <div className="flex justify-between gap-3 border-b border-rule pb-1.5">
      <span className="text-prose-muted shrink-0">{label}</span>
      <span className="text-prose text-right break-words">{value ?? '—'}</span>
    </div>
  );
}

const REPO_STATUS_LABEL = {
  COMPLETE: 'Ready',
  FAILED: 'Provisioning failed',
};

function repositoryStatusLabel(repository) {
  if (!repository) return 'Not yet provisioned';
  return REPO_STATUS_LABEL[repository.status] || `In progress (${repository.status})`;
}

/**
 * ContractDetailsDrawer — the one shared "Contract Details" view for both
 * roles (see ARCHITECTURE's shared-component-reuse convention this app
 * already follows). Fetched from GET /api/contracts/:id/assignment-details,
 * which is gated by contractPartyOnly (this contract's client, its assigned
 * freelancer, or admin) server-side — so this component never needs its own
 * authorization logic, only whatever the backend already decided to return.
 * Reuses MobileDrawer, the app's one drawer/modal primitive.
 *
 * viewerRole ('client' | 'freelancer') decides which Contact button
 * (ContactParticipantButton) renders in the footer.
 */
export function ContractDetailsDrawer({ contractId, isOpen, onClose, viewerRole }) {
  const [details, setDetails] = useState(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!isOpen || !contractId) return;
    setDetails(null);
    setError('');
    callApi(`/api/contracts/${contractId}/assignment-details`)
      .then(setDetails)
      .catch((err) => setError(err.message || 'Failed to load contract details'));
  }, [isOpen, contractId]);

  const handleDownload = async () => {
    setDownloading(true);
    setError('');
    try {
      await downloadFile(`/api/contracts/${contractId}/assignment-pdf`, `${contractId}-contract-record.pdf`);
    } catch (err) {
      setError(err.message || 'Failed to download Contract Record');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <MobileDrawer
      isOpen={isOpen}
      onClose={onClose}
      title="Contract Details"
      subtitle={contractId}
      position="right"
      resizable
      footer={
        <div className="space-y-2">
          <FuturisticButton
            variant="secondary"
            size="sm"
            icon={Download}
            fullWidth
            loading={downloading}
            loadingText="Preparing..."
            onClick={handleDownload}
          >
            Download Contract Record
          </FuturisticButton>
          {viewerRole && <ContactParticipantButton contractId={contractId} viewerRole={viewerRole} className="w-full" />}
        </div>
      }
    >
      {error && <div className="mb-3 font-mono text-xs text-fail">{error}</div>}
      {!details && !error && <div className="font-mono text-xs text-prose-muted">Loading...</div>}
      {details && (
        <div className="space-y-4 font-mono text-xs">
          <DetailRow label="Title" value={details.title} />
          <DetailRow label="Contract ID" value={details.contractId} />
          <DetailRow label="Client" value={details.clientDisplayName || details.clientId} />
          <DetailRow label="Freelancer" value={details.freelancerDisplayName || details.freelancerId} />
          <DetailRow label="Contract Status" value={details.status} />
          <DetailRow label="Agreed Amount" value={formatMinor(details.budgetCents)} />
          <DetailRow label="Due Date" value={formatDeadline(details.deadline)} />
          <DetailRow
            label="Contract Created"
            value={details.createdAt ? new Date(details.createdAt).toLocaleString() : null}
          />
          {details.assignment && (
            <>
              <DetailRow label="Assignment Status" value={details.assignment.status} />
              <DetailRow
                label="Assigned"
                value={details.assignment.assignedAt ? new Date(details.assignment.assignedAt).toLocaleString() : null}
              />
              {details.assignment.decidedAt && (
                <DetailRow label="Decided" value={new Date(details.assignment.decidedAt).toLocaleString()} />
              )}
              {details.assignment.status === 'REJECTED' && details.assignment.rejectionReasonText && (
                <DetailRow label="Rejection Reason" value={details.assignment.rejectionReasonText} />
              )}
            </>
          )}
          <DetailRow label="Repository Status" value={repositoryStatusLabel(details.repository)} />
          <div>
            <div className="text-prose-muted mb-1">Requirements &amp; Scope</div>
            <div className="text-prose whitespace-pre-wrap bg-ink border border-rule p-3">
              {details.requirements || 'No requirements on file.'}
            </div>
          </div>
          <div>
            <div className="text-prose-muted mb-1">Integrity Reference (Genesis Hash / H0)</div>
            <div className="text-prose break-all bg-ink border border-rule p-3">
              {details.genesisHash || 'Not yet recorded'}
            </div>
          </div>
        </div>
      )}
    </MobileDrawer>
  );
}

export default ContractDetailsDrawer;
