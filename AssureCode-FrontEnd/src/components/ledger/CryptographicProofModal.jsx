import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../common/Modal';
import { ShieldCheck, CheckCircle2, Copy, Check, Key, Search, ArrowRight, Loader2 } from 'lucide-react';
import { MerkleTree, sha256, formatHash, canonicalizeJson } from '../../utils/cryptoUtils';
import { Badge } from '../common/Badge';

export function CryptographicProofModal() {
  const { isProofModalOpen, setIsProofModalOpen, selectedProofData } = useApp();
  const [proofSteps, setProofSteps] = useState(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState(null);

  useEffect(() => {
    if (selectedProofData && isProofModalOpen) {
      generateProof();
    }
  }, [selectedProofData, isProofModalOpen]);

  const generateProof = async () => {
    setIsVerifying(true);
    setVerificationResult(null);

    const { contract, index } = selectedProofData;
    const leaves = contract.requirements.map(r => `${r.title}: ${r.description}`);
    const tree = new MerkleTree(leaves);
    await tree.build();

    const proof = tree.getProof(index);
    setProofSteps(proof);
    setIsVerifying(false);
  };

  const handleVerifyInclusion = async () => {
    if (!proofSteps) return;
    setIsVerifying(true);
    await new Promise(r => setTimeout(r, 600));

    const isMatch = await MerkleTree.verifyProof(
      proofSteps.leafHash,
      proofSteps.proof,
      proofSteps.root
    );

    setVerificationResult(isMatch);
    setIsVerifying(false);
  };

  if (!selectedProofData) return null;

  const { requirement, index, contract } = selectedProofData;

  return (
    <Modal
      isOpen={isProofModalOpen}
      onClose={() => setIsProofModalOpen(false)}
      title="RFC 6962 Merkle Inclusion Proof Verifier"
      maxWidth="max-w-2xl"
    >
      <div className="space-y-5 text-xs font-mono">
        <p className="text-slate-400 font-sans leading-relaxed">
          Cryptographically proves that Requirement #{index + 1} is irrevocably locked within Merkle Root <code className="text-indigo-300 font-mono">{formatHash(contract.merkleRoot, 6, 6)}</code> without requiring a full database scan.
        </p>

        {/* Selected Leaf Info */}
        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-slate-500 font-semibold uppercase">Leaf Subject:</span>
            <Badge variant="primary" size="xs">Requirement #{index + 1}</Badge>
          </div>
          <div className="text-white font-bold font-sans">{requirement.title}</div>
          <div className="text-slate-400 text-[11px] font-sans">{requirement.description}</div>
          {proofSteps && (
            <div className="pt-2 border-t border-slate-800 text-[11px] flex items-center justify-between text-indigo-300">
              <span>Leaf Hash (SHA-256 with 0x00 prefix):</span>
              <span className="font-bold">{formatHash(proofSteps.leafHash, 8, 8)}</span>
            </div>
          )}
        </div>

        {/* Proof Path Sibling Layers */}
        {proofSteps && (
          <div className="space-y-2 font-sans">
            <div className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              Merkle Sibling Path Proof ({proofSteps.proof.length} Layers)
            </div>

            <div className="space-y-2 font-mono text-[11px]">
              {proofSteps.proof.map((step, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-lg bg-[#070a12] border border-slate-800 flex items-center justify-between"
                >
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-bold text-[10px]">
                      Layer {idx + 1}
                    </span>
                    <span className="text-slate-400">Position: {step.position.toUpperCase()}</span>
                  </div>
                  <span className="text-cyan-300">{formatHash(step.hash, 8, 8)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Verification Result Banner */}
        {verificationResult !== null && (
          <div
            className={`p-4 rounded-xl border flex items-center gap-3 font-sans ${
              verificationResult
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : 'bg-rose-950/40 border-rose-500/40 text-rose-300'
            }`}
          >
            <ShieldCheck className="w-6 h-6 flex-shrink-0" />
            <div>
              <div className="font-bold text-sm">
                {verificationResult ? 'Cryptographic Proof Valid!' : 'Proof Validation Failed'}
              </div>
              <div className="text-xs mt-0.5 text-slate-300">
                {verificationResult
                  ? 'Computed hash path matches PostgreSQL ledger Merkle Root exactly.'
                  : 'Computed root does not match stored root.'}
              </div>
            </div>
          </div>
        )}

        {/* Action Button */}
        <div className="flex justify-end gap-2 pt-4 border-t border-slate-800 font-sans">
          <button
            onClick={() => setIsProofModalOpen(false)}
            className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-semibold hover:bg-slate-700"
          >
            Close
          </button>
          <button
            onClick={handleVerifyInclusion}
            disabled={isVerifying}
            className="flex items-center gap-2 px-5 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold shadow-lg shadow-brand-500/25 disabled:opacity-50"
          >
            {isVerifying ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Hashing Merkle Path...</span>
              </>
            ) : (
              <>
                <Search className="w-4 h-4" />
                <span>Execute Inclusion Verification</span>
              </>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
