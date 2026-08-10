/**
 * A real Merkle tree over the ledger's leaves.
 *
 * What was here before
 * --------------------
 * The table is called `merkle_ledger` and the specification says "Merkle Hash
 * Chain", but the structure was a linked list: each row hashed its payload
 * together with the previous row's hash. That is a hash chain (Haber &
 * Stornetta 1991), and it is a perfectly good tamper-evident structure — but it
 * is not a Merkle tree and it cannot do the one thing a Merkle tree is for.
 * Proving that entry 3 belongs to a chain of 10 000 requires all 10 000
 * entries; with a tree it takes 14 hashes.
 *
 * Objective 1 asks for a tamper-proof ledger, so the chain stays: it is what
 * makes insertion between two existing entries detectable. The tree is added on
 * top, over the chain's leaves, so the word "Merkle" describes something that
 * exists and a third party can verify one entry without being handed the whole
 * contract history.
 *
 * Construction
 * ------------
 * Domain-separated, following RFC 6962 (Certificate Transparency):
 *
 *     leaf(d)          = SHA256( 0x00 || d )
 *     interior(l, r)   = SHA256( 0x01 || l || r )
 *
 * The prefixes matter. Without them an interior node's preimage is two
 * concatenated hashes, and an attacker who can choose a leaf can supply one
 * that is itself a concatenation of two hashes — presenting an interior node as
 * a leaf and proving membership of data that was never in the tree. This is the
 * standard second-preimage attack on naive Merkle trees, and one byte prevents
 * it.
 *
 * Odd nodes are promoted to the next level rather than duplicated. Duplicating
 * the last node is the Bitcoin construction and it admits CVE-2012-2459: two
 * different leaf sequences can produce the same root. Promotion has no such
 * ambiguity.
 *
 * An empty tree has the root SHA256 of the empty string, again per RFC 6962, so
 * that "no entries" is a specific value rather than a special case the caller
 * has to remember to handle.
 */
import { createHash } from 'node:crypto';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** RFC 6962 leaf hash of arbitrary bytes. */
export function hashLeaf(data: Buffer | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return sha256(LEAF_PREFIX, buf);
}

/** RFC 6962 interior node hash. */
export function hashNode(left: Buffer, right: Buffer): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

/** The root of an empty tree: SHA-256 of the empty string. */
export const EMPTY_ROOT = createHash('sha256').update(Buffer.alloc(0)).digest();

/** One step of an inclusion proof: a sibling hash and which side it is on. */
export interface ProofStep {
  hash: string;
  side: 'left' | 'right';
}

export interface InclusionProof {
  /** Index of the proved leaf, 0-based, in the tree's leaf ordering. */
  leafIndex: number;
  leafCount: number;
  /** The leaf hash being proved, hex. */
  leafHash: string;
  root: string;
  path: ProofStep[];
}

/**
 * Build every level of the tree, bottom-up.
 *
 * Returned as levels rather than a root alone because the proof generator needs
 * the siblings, and recomputing the tree once per proof would turn a cheap
 * operation into a quadratic one.
 */
function buildLevels(leaves: Buffer[]): Buffer[][] {
  if (leaves.length === 0) return [[EMPTY_ROOT]];

  const levels: Buffer[][] = [leaves];
  let current = leaves;

  while (current.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(hashNode(current[i], current[i + 1]));
      } else {
        // Promote, do not duplicate — see the module docstring.
        next.push(current[i]);
      }
    }
    levels.push(next);
    current = next;
  }

  return levels;
}

/** The Merkle root over an ordered list of leaf hashes. */
export function computeRoot(leafHashes: Buffer[]): Buffer {
  const levels = buildLevels(leafHashes);
  return levels[levels.length - 1][0];
}

/**
 * An inclusion proof for one leaf.
 *
 * Throws on an out-of-range index rather than returning an unusable proof: a
 * caller that asks about a leaf which is not in the tree has a bug, and handing
 * back something proof-shaped invites it to be verified against the wrong root
 * and pass.
 */
export function buildInclusionProof(leafHashes: Buffer[], leafIndex: number): InclusionProof {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leafHashes.length) {
    throw new RangeError(
      `leaf index ${leafIndex} is outside the tree, which has ${leafHashes.length} leaves`,
    );
  }

  const levels = buildLevels(leafHashes);
  const path: ProofStep[] = [];
  let index = leafIndex;

  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level];
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : index + 1;

    if (siblingIndex < nodes.length) {
      path.push({
        hash: nodes[siblingIndex].toString('hex'),
        side: isRight ? 'left' : 'right',
      });
    }
    // No sibling means this node was promoted unchanged, so the proof records
    // no step for this level and the running hash carries up untouched.

    index = Math.floor(index / 2);
  }

  return {
    leafIndex,
    leafCount: leafHashes.length,
    leafHash: leafHashes[leafIndex].toString('hex'),
    root: levels[levels.length - 1][0].toString('hex'),
    path,
  };
}

/**
 * Verify an inclusion proof against a root.
 *
 * This is the function a third party runs, and it needs nothing but the leaf,
 * the path, and the root — no database, no chain, no trust in the party that
 * produced the proof.
 */
export function verifyInclusionProof(
  leafHash: Buffer | string,
  path: ProofStep[],
  root: Buffer | string,
): boolean {
  let running = typeof leafHash === 'string' ? Buffer.from(leafHash, 'hex') : leafHash;
  const rootBuf = typeof root === 'string' ? Buffer.from(root, 'hex') : root;

  if (running.length !== 32 || rootBuf.length !== 32) return false;

  for (const step of path) {
    const sibling = Buffer.from(step.hash, 'hex');
    if (sibling.length !== 32) return false;
    running =
      step.side === 'left' ? hashNode(sibling, running) : hashNode(running, sibling);
  }

  // Constant-time comparison is not required — both values are public — but
  // Buffer.equals is the correct way to compare bytes regardless.
  return running.equals(rootBuf);
}
