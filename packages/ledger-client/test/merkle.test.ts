/**
 * Merkle tree tests.
 *
 * The values for the one- and two-leaf cases are computed here from the RFC
 * 6962 definitions rather than copied from the implementation's output, so a
 * change to the construction shows up as a failure instead of a new baseline.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildInclusionProof,
  computeRoot,
  hashLeaf,
  hashNode,
  verifyInclusionProof,
  EMPTY_ROOT,
} from '../src/merkle.js';

const leaves = (n: number) => Array.from({ length: n }, (_, i) => hashLeaf(`leaf-${i}`));

describe('hashing primitives', () => {
  it('domain-separates leaves with 0x00', () => {
    const expected = createHash('sha256')
      .update(Buffer.concat([Buffer.from([0x00]), Buffer.from('abc', 'utf8')]))
      .digest('hex');
    expect(hashLeaf('abc').toString('hex')).toBe(expected);
  });

  it('domain-separates interior nodes with 0x01', () => {
    const l = hashLeaf('a');
    const r = hashLeaf('b');
    const expected = createHash('sha256')
      .update(Buffer.concat([Buffer.from([0x01]), l, r]))
      .digest('hex');
    expect(hashNode(l, r).toString('hex')).toBe(expected);
  });

  it('makes a leaf hash and an interior hash of the same bytes differ', () => {
    // This is the second-preimage attack the prefixes prevent: without them,
    // an attacker could present an interior node as a leaf.
    const l = hashLeaf('a');
    const r = hashLeaf('b');
    const asNode = hashNode(l, r);
    const asLeaf = hashLeaf(Buffer.concat([l, r]));
    expect(asNode.equals(asLeaf)).toBe(false);
  });
});

describe('computeRoot', () => {
  it('gives the empty tree the SHA-256 of the empty string', () => {
    expect(computeRoot([]).equals(EMPTY_ROOT)).toBe(true);
  });

  it('gives a single-leaf tree that leaf as its root', () => {
    const [only] = leaves(1);
    expect(computeRoot([only]).equals(only)).toBe(true);
  });

  it('gives a two-leaf tree the hash of the pair', () => {
    const [a, b] = leaves(2);
    expect(computeRoot([a, b]).equals(hashNode(a, b))).toBe(true);
  });

  it('promotes an odd node instead of duplicating it', () => {
    const [a, b, c] = leaves(3);
    // Promotion: level 1 is [H(a,b), c], root is H(H(a,b), c).
    expect(computeRoot([a, b, c]).equals(hashNode(hashNode(a, b), c))).toBe(true);
  });

  it('is not vulnerable to CVE-2012-2459 duplicate-leaf ambiguity', () => {
    // Under the Bitcoin construction, [a, b, c] duplicates c and produces the
    // same root as [a, b, c, c]. Promotion must keep them distinct.
    const [a, b, c] = leaves(3);
    expect(computeRoot([a, b, c]).equals(computeRoot([a, b, c, c]))).toBe(false);
  });

  it('depends on leaf order', () => {
    const [a, b] = leaves(2);
    expect(computeRoot([a, b]).equals(computeRoot([b, a]))).toBe(false);
  });

  it('changes when any single leaf changes', () => {
    const base = leaves(7);
    const before = computeRoot(base).toString('hex');
    const mutated = [...base];
    mutated[4] = hashLeaf('tampered');
    expect(computeRoot(mutated).toString('hex')).not.toBe(before);
  });
});

describe('inclusion proofs', () => {
  for (const n of [1, 2, 3, 4, 5, 8, 9, 17]) {
    it(`verifies every leaf in a ${n}-leaf tree`, () => {
      const ls = leaves(n);
      const root = computeRoot(ls);
      for (let i = 0; i < n; i++) {
        const proof = buildInclusionProof(ls, i);
        expect(proof.root).toBe(root.toString('hex'));
        expect(proof.leafCount).toBe(n);
        expect(verifyInclusionProof(proof.leafHash, proof.path, proof.root)).toBe(true);
      }
    });
  }

  it('keeps proofs logarithmic', () => {
    // 1000 leaves: ceil(log2(1000)) = 10. This is the property the tree exists
    // for — a chain would need all 1000 entries.
    const proof = buildInclusionProof(leaves(1000), 500);
    expect(proof.path.length).toBeLessThanOrEqual(10);
  });

  it('rejects a proof for a different leaf', () => {
    const ls = leaves(8);
    const proof = buildInclusionProof(ls, 3);
    expect(verifyInclusionProof(hashLeaf('not-in-tree'), proof.path, proof.root)).toBe(false);
  });

  it('rejects a proof whose sibling has been altered', () => {
    const ls = leaves(8);
    const proof = buildInclusionProof(ls, 3);
    const tampered = proof.path.map((s, i) => (i === 0 ? { ...s, hash: hashLeaf('x').toString('hex') } : s));
    expect(verifyInclusionProof(proof.leafHash, tampered, proof.root)).toBe(false);
  });

  it('rejects a proof whose sibling side has been flipped', () => {
    const ls = leaves(8);
    const proof = buildInclusionProof(ls, 3);
    const flipped = proof.path.map((s, i) =>
      i === 0 ? { ...s, side: s.side === 'left' ? ('right' as const) : ('left' as const) } : s,
    );
    expect(verifyInclusionProof(proof.leafHash, flipped, proof.root)).toBe(false);
  });

  it('rejects a valid proof against the wrong root', () => {
    const proof = buildInclusionProof(leaves(8), 3);
    const otherRoot = computeRoot(leaves(9)).toString('hex');
    expect(verifyInclusionProof(proof.leafHash, proof.path, otherRoot)).toBe(false);
  });

  it('rejects malformed hash lengths rather than treating them as a match', () => {
    const proof = buildInclusionProof(leaves(4), 1);
    expect(verifyInclusionProof('abcd', proof.path, proof.root)).toBe(false);
    expect(verifyInclusionProof(proof.leafHash, [{ hash: 'ab', side: 'left' }], proof.root)).toBe(false);
  });

  it('throws for an index outside the tree instead of returning a proof', () => {
    expect(() => buildInclusionProof(leaves(4), 4)).toThrow(RangeError);
    expect(() => buildInclusionProof(leaves(4), -1)).toThrow(RangeError);
    expect(() => buildInclusionProof([], 0)).toThrow(RangeError);
  });
});
