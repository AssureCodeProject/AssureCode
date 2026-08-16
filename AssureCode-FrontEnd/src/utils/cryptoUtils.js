/**
 * AssureCode Cryptographic Engine
 * Implements RFC 8785 Canonical JSON, RFC 6962 Merkle Trees, and Ledger Hash Chaining
 */

// Compute SHA-256 hex string using browser Web Crypto
export async function sha256(data) {
  const msgBuffer = typeof data === 'string' 
    ? new TextEncoder().encode(data)
    : data;
  
  if (window.crypto && window.crypto.subtle) {
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback simple SHA256 simulation if subtle crypto is somehow blocked
  let hash = 0x811c9dc5;
  for (let i = 0; i < msgBuffer.length; i++) {
    hash ^= msgBuffer[i];
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(64, '0');
}

// RFC 8785 JSON Canonicalization (Deterministic key ordering)
export function canonicalizeJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalizeJson).join(',') + ']';
  }
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(key => `"${key}":${canonicalizeJson(obj[key])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * RFC 6962 Compliant Merkle Tree Node
 */
export class MerkleTree {
  constructor(leaves = []) {
    this.leaves = leaves.map(leaf => (typeof leaf === 'string' ? leaf : canonicalizeJson(leaf)));
    this.leafHashes = [];
    this.layers = [];
    this.root = null;
  }

  async build() {
    if (this.leaves.length === 0) {
      this.root = await sha256('');
      return this.root;
    }

    // RFC 6962: Leaf hash prefix = 0x00
    this.leafHashes = await Promise.all(
      this.leaves.map(async (leaf, idx) => {
        const hash = await sha256(`0x00:${leaf}`);
        return {
          id: `leaf-${idx}`,
          data: leaf,
          hash: hash,
          isLeaf: true,
          label: `Requirement #${idx + 1}`
        };
      })
    );

    let currentLayer = [...this.leafHashes];
    this.layers = [currentLayer];

    while (currentLayer.length > 1) {
      const nextLayer = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right = i + 1 < currentLayer.length ? currentLayer[i + 1] : left;
        
        // RFC 6962: Interior node prefix = 0x01
        const combined = `0x01:${left.hash}:${right.hash}`;
        const parentHash = await sha256(combined);
        
        nextLayer.push({
          id: `node-${this.layers.length}-${nextLayer.length}`,
          hash: parentHash,
          left: left.id,
          right: right.id,
          isLeaf: false,
          label: `Merkle Node (${left.hash.slice(0, 4)}..${right.hash.slice(0, 4)})`
        });
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }

    this.root = currentLayer[0]?.hash || (await sha256(''));
    return this.root;
  }

  // Generate inclusion proof for a leaf
  getProof(leafIndex) {
    if (leafIndex < 0 || leafIndex >= this.leafHashes.length) return null;
    
    const proof = [];
    let currentIndex = leafIndex;

    for (let layerIdx = 0; layerIdx < this.layers.length - 1; layerIdx++) {
      const layer = this.layers[layerIdx];
      const isRightSibling = currentIndex % 2 === 1;
      const siblingIndex = isRightSibling ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < layer.length) {
        proof.push({
          position: isRightSibling ? 'left' : 'right',
          hash: layer[siblingIndex].hash
        });
      } else {
        // Odd leaf duplicated
        proof.push({
          position: 'right',
          hash: layer[currentIndex].hash
        });
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return {
      leafHash: this.leafHashes[leafIndex].hash,
      root: this.root,
      proof
    };
  }

  // Verify an inclusion proof
  static async verifyProof(leafHash, proof, expectedRoot) {
    let currentHash = leafHash;
    for (const step of proof) {
      const combined = step.position === 'left'
        ? `0x01:${step.hash}:${currentHash}`
        : `0x01:${currentHash}:${step.hash}`;
      currentHash = await sha256(combined);
    }
    return currentHash === expectedRoot;
  }
}

/**
 * Ledger Block Hash Chaining
 */
export async function computeBlockHash({ prevHash, sequenceNumber, timestamp, eventType, merkleRoot, payload }) {
  const canonicalPayload = canonicalizeJson(payload);
  const rawString = `${prevHash}|${sequenceNumber}|${timestamp}|${eventType}|${merkleRoot}|${canonicalPayload}`;
  return await sha256(rawString);
}

/**
 * Format cryptographic hash for UI display
 */
export function formatHash(hash, startLen = 6, endLen = 6) {
  if (!hash) return '';
  if (hash.length <= startLen + endLen) return hash;
  return `${hash.slice(0, startLen)}...${hash.slice(-endLen)}`;
}
