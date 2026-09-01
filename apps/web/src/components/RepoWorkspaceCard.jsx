import { useState, useEffect } from 'react';
import { GitBranch, Copy, AlertTriangle } from 'lucide-react';

import { callApi } from '../utils/api';

/**
 * RepoWorkspaceCard — polls GET /api/contracts/:id/repo-provisioning for one
 * contract and shows the clone link once AssureCode has finished creating
 * the repo, adding the freelancer as an outside collaborator, and attaching
 * the audit webhook (settlement-worker's attemptProvisioning, triggered on
 * ASSIGNMENT_ACCEPTED). Shows an explicit "not provisioned yet" line for a
 * confirmed 404 (a contract that predates auto-provisioning, or hasn't been
 * accepted yet) rather than rendering nothing, since this now also appears
 * on the Verification screen where a silent blank reads as broken.
 */
export function RepoWorkspaceCard({ contractId }) {
  const [provisioning, setProvisioning] = useState(undefined); // undefined = loading, null = confirmed no record
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

  if (provisioning === undefined) return null;

  if (provisioning === null) {
    return (
      <div className="mt-3 pt-3 border-t border-rule flex items-center gap-2 font-mono text-[11px] text-prose-muted">
        <GitBranch className="w-3.5 h-3.5 shrink-0" />
        <span>No repository provisioned yet for this contract.</span>
      </div>
    );
  }

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

export default RepoWorkspaceCard;
