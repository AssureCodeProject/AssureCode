/**
 * The two footer badges that describe the ledger's state.
 *
 * These replace two hardcoded strings — "MERKLE HASH CHAIN ACTIVE" and "NIST
 * ML-DSA POST-QUANTUM SIGNED" — that were rendered for every contract in every
 * deployment regardless of whether a root existed, whether the chain verified,
 * or whether anything had ever signed. Nothing in the running system signed
 * roots at all until the settlement worker started calling
 * POST /api/contracts/:id/root/sign, so the second badge was, for the whole
 * life of the project, an assertion over a NULL column.
 *
 * A badge here either states something the gateway confirmed, or says it does
 * not know. It never guesses.
 */

const TONE = {
  good: 'text-prose-muted',
  warn: 'text-amber-400',
  bad: 'text-red-400',
  dim: 'text-prose-muted/50',
};

function Badge({ tone, children, title }) {
  return (
    <span className={TONE[tone]} title={title}>
      {children}
    </span>
  );
}

/** Chain integrity: verified, broken, or not yet sealed. */
export function ChainBadge({ status }) {
  if (status.kind === 'loading') return <Badge tone="dim">CHAIN …</Badge>;
  if (status.kind === 'no-contract') return <Badge tone="dim">NO CONTRACT SELECTED</Badge>;
  if (status.kind === 'no-root') {
    return (
      <Badge tone="dim" title="Merkle roots are computed when a contract settles.">
        NO SEALED ROOT
      </Badge>
    );
  }
  if (status.kind === 'unknown') return <Badge tone="dim">LEDGER STATUS UNKNOWN</Badge>;

  const short = String(status.rootHash ?? '').slice(0, 8);

  if (status.chainValid === false) {
    return (
      <Badge tone="bad" title="A ledger entry's hash does not match its recorded chain.">
        CHAIN BROKEN
      </Badge>
    );
  }
  if (status.chainValid === null || status.chainValid === undefined) {
    return <Badge tone="dim">CHAIN UNVERIFIED</Badge>;
  }
  return (
    <Badge tone="good" title={`Merkle root ${status.rootHash} over ${status.leafCount} leaves`}>
      CHAIN VERIFIED · {short}
    </Badge>
  );
}

/** Post-quantum signature: present, absent, or unknown. */
export function SignatureBadge({ status }) {
  // Omitted entirely rather than guessed. Rendering "unsigned" for a request
  // that never completed would be as wrong as rendering "signed".
  if (status.kind === 'loading' || status.kind === 'unknown' || status.kind === 'no-contract') {
    return null;
  }

  if (status.kind === 'no-root') {
    return (
      <Badge tone="dim" title="There is no root to sign until the contract settles.">
        NOT YET SIGNED
      </Badge>
    );
  }

  const sig = status.signature ?? {};

  if (!sig.signed) {
    return (
      <Badge
        tone="warn"
        title={
          'The root is sealed but carries no signature. Either the signer has no ' +
          'ML_DSA_SEED_HEX configured, or signing failed — re-drive ' +
          'POST /api/contracts/:id/root/sign.'
        }
      >
        ROOT UNSIGNED
      </Badge>
    );
  }

  if (status.chainValid === false) {
    return (
      <Badge tone="bad" title="A signature over a chain that no longer verifies proves nothing.">
        SIGNATURE DOES NOT COVER A VALID CHAIN
      </Badge>
    );
  }

  const when = sig.signedAt ? new Date(sig.signedAt).toISOString().slice(0, 16).replace('T', ' ') : '';
  return (
    <Badge
      tone="good"
      title={`${sig.algorithm} · key ${sig.publicKeyFingerprint} · verify with: python tools/sign_merkle_root.py --verify <contractId>`}
    >
      {sig.algorithm ?? 'ML-DSA'} SIGNED{when ? ` · ${when}` : ''}
    </Badge>
  );
}
