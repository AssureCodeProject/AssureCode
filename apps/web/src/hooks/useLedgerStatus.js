import { useState, useEffect } from 'react';
import { apiRequest } from '../utils/api';

/**
 * The contract's sealed Merkle root and whether it is actually signed.
 *
 * The footer used to assert "NIST ML-DSA POST-QUANTUM SIGNED" unconditionally,
 * for every contract, in every deployment. That claim was false in normal
 * operation: nothing in the running system signed anything — merkle_roots
 * signature columns were written only by tools/sign_merkle_root.py, run by hand
 * — so the badge was displayed over a table of NULLs. It also showed for
 * contracts with no root at all.
 *
 * The claim now comes from GET /api/contracts/:id/root, or is not made.
 *
 * Five states, deliberately distinct:
 *   loading      - the request is in flight
 *   ok           - a root exists; `signature.signed` says whether it is signed
 *   no-root      - the contract has no sealed root (roots are computed on
 *                  settlement, so this is the normal state before one)
 *   no-contract  - nothing selected, or the contract does not exist
 *   unknown      - the request failed
 *
 * `unknown` is the one that matters most: a failed fetch must not render as
 * either "signed" or "unsigned". Both are assertions about the ledger, and we
 * have not learned either.
 */
export function useLedgerStatus(contractId) {
  const [status, setStatus] = useState({ kind: 'loading' });

  useEffect(() => {
    if (!contractId) {
      setStatus({ kind: 'no-contract' });
      return undefined;
    }

    let cancelled = false;
    setStatus({ kind: 'loading' });

    apiRequest(`/api/contracts/${encodeURIComponent(contractId)}/root`)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setStatus({ kind: 'ok', ...res.payload });
          return;
        }
        // The gateway distinguishes these two in the body; a 404 alone would
        // not say whether the contract is missing or merely unsettled.
        if (res.status === 404 && res.payload?.reason === 'no-root') {
          setStatus({ kind: 'no-root' });
          return;
        }
        if (res.status === 404) {
          setStatus({ kind: 'no-contract' });
          return;
        }
        setStatus({ kind: 'unknown' });
      })
      .catch(() => {
        if (!cancelled) setStatus({ kind: 'unknown' });
      });

    return () => {
      cancelled = true;
    };
  }, [contractId]);

  return status;
}

export default useLedgerStatus;
