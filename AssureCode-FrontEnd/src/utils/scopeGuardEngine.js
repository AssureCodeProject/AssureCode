/**
 * Scope Guard Engine
 * Autonomous RAG Scope Mediation based on pgvector Top-5 Chunks and Cosine Similarity Threshold (0.2731)
 */

export const SCOPE_THRESHOLD = 0.2731;

// Domain keywords and semantic mappings to simulate Sentence-BERT embeddings
const SEMANTIC_CLUSTERS = {
  auth: ['jwt', 'oauth', 'token', 'login', 'signup', 'rbac', 'session', 'passport', 'bcrypt', 'authentication', 'authorization', 'permission', 'role', 'api key', '2fa', 'mfa'],
  payment: ['stripe', 'escrow', 'paymentintent', 'checkout', 'webhook', 'capture', 'refund', 'ledger', 'currency', 'balance', 'payout', 'settlement', 'invoice', 'card', 'billing'],
  database: ['postgres', 'sql', 'prisma', 'orm', 'migration', 'table', 'index', 'hash', 'query', 'schema', 'foreign key', 'transaction', 'acid', 'merkle', 'pgvector'],
  ci_cd: ['docker', 'sandbox', 'ast', 'mccabe', 'halstead', 'owasp', 'vulnerability', 'test', 'jest', 'vitest', 'github', 'webhook', 'push', 'pipeline', 'cve', 'linter'],
  performance: ['cache', 'redis', 'stream', 'latency', 'concurrency', 'fastify', 'rate limit', 'ephemeral', 'benchmark', 'scale', 'load test', 'optimization'],
  out_of_scope_cues: ['mobile app', 'ios', 'android', 'swift', 'flutter', 'react native', 'vr', 'metaverse', 'blockchain token', 'crypto coin', 'seo marketing', 'figma design system', 'photoshop', 'wordpress', 're-write in rust', 'kubernetes cluster setup']
};

/**
 * Generate a 64-dimensional simulated embedding vector for text
 */
export function getSimulatedEmbedding(text) {
  const normalized = text.toLowerCase();
  const vector = new Array(64).fill(0.02);

  // Apply semantic activation
  let clusterIdx = 0;
  for (const [cluster, keywords] of Object.entries(SEMANTIC_CLUSTERS)) {
    let count = 0;
    keywords.forEach(kw => {
      if (normalized.includes(kw)) count++;
    });

    if (count > 0) {
      const start = (clusterIdx * 10) % 64;
      for (let i = 0; i < 8; i++) {
        vector[(start + i) % 64] += (count * 0.25);
      }
    }
    clusterIdx++;
  }

  // Token hash distribution
  const words = normalized.split(/\s+/);
  words.forEach((word, wIdx) => {
    let charCodeSum = 0;
    for (let i = 0; i < word.length; i++) {
      charCodeSum += word.charCodeAt(i);
    }
    const idx = (charCodeSum + wIdx * 7) % 64;
    vector[idx] += 0.12;
  });

  // Normalize to unit length (L2 norm)
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  return vector.map(val => (norm > 0 ? val / norm : 0));
}

/**
 * Cosine similarity between two unit vectors
 */
export function computeCosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
  }
  return Math.min(1.0, Math.max(-1.0, dotProduct));
}

/**
 * Split contract requirements into discrete searchable chunks
 */
export function chunkContract(contract) {
  const chunks = [];
  
  if (contract.requirements && Array.isArray(contract.requirements)) {
    contract.requirements.forEach((req, idx) => {
      chunks.push({
        id: `chunk-req-${idx + 1}`,
        type: 'REQUIREMENT',
        title: req.title || `Requirement ${idx + 1}`,
        content: `${req.title}: ${req.description} (Tech: ${req.techStack || 'standard'})`,
        weight: req.weight || 1.0,
        genesisAnchor: contract.genesisLedgerHash || '0xGENESIS_HASH_DEFAULT'
      });
    });
  }

  if (contract.deliverables && Array.isArray(contract.deliverables)) {
    contract.deliverables.forEach((del, idx) => {
      chunks.push({
        id: `chunk-del-${idx + 1}`,
        type: 'DELIVERABLE',
        title: `Deliverable: ${del}`,
        content: `Contract Deliverable #${idx + 1}: ${del}`,
        weight: 1.2,
        genesisAnchor: contract.genesisLedgerHash || '0xGENESIS_HASH_DEFAULT'
      });
    });
  }

  return chunks;
}

/**
 * Evaluate a chat message against contract chunks (RAG Scope Guard)
 */
export function evaluateScopeMessage(messageText, contract) {
  const messageEmbedding = getSimulatedEmbedding(messageText);
  const chunks = chunkContract(contract);

  // Compute similarity against all chunks
  const scoredChunks = chunks.map(chunk => {
    const chunkEmbedding = getSimulatedEmbedding(chunk.content);
    const similarity = computeCosineSimilarity(messageEmbedding, chunkEmbedding);
    return {
      ...chunk,
      similarity: Number(similarity.toFixed(4))
    };
  });

  // Sort descending and take top 5
  scoredChunks.sort((a, b) => b.similarity - a.similarity);
  const top5 = scoredChunks.slice(0, 5);
  const bestScore = top5.length > 0 ? top5[0].similarity : 0;

  // Evaluate against architectural threshold
  const isAllowed = bestScore >= SCOPE_THRESHOLD;

  let explanation = '';
  if (isAllowed) {
    explanation = `Message aligns with Anchor ${contract.genesisLedgerHash ? contract.genesisLedgerHash.slice(0, 10) : '0xLOCKED'}... Highest similarity of ${(bestScore * 100).toFixed(1)}% matches "${top5[0]?.title}". Allowed into audit stream.`;
  } else {
    explanation = `Potential Scope Creep Detected. Best cosine similarity of ${(bestScore * 100).toFixed(1)}% is below the required ${SCOPE_THRESHOLD} (27.31%) threshold against locked contract requirements. Message requires an Amendment Proposal.`;
  }

  return {
    allowed: isAllowed,
    bestSimilarity: bestScore,
    threshold: SCOPE_THRESHOLD,
    retrievedChunks: top5,
    genesisAnchor: contract.genesisLedgerHash,
    explanation,
    timestamp: new Date().toISOString()
  };
}
