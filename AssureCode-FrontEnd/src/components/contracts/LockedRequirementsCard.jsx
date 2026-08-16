import React, { useState } from 'react';
import { ShieldCheck, CheckCircle, Lock, Key, Copy, Check, FileCode, Search } from 'lucide-react';
import { formatHash, canonicalizeJson, MerkleTree } from '../../utils/cryptoUtils';
import { Badge } from '../common/Badge';

export function LockedRequirementsCard({ contract, onInspectProof }) {
  const [copiedHash, setCopiedHash] = useState(null);

  if (!contract) return null;

  const copyToClipboard = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopiedHash(key);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  return (
    <div className="glass-panel rounded-2xl p-6 border border-slate-800 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <Lock className="w-5 h-5 text-indigo-400" />
            <h3 className="text-lg font-bold text-white">Cryptographically Locked Requirements</h3>
            <Badge variant="primary" size="xs">RFC 6962</Badge>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Requirements are canonicalized via RFC 8785 and pinned into a binary Merkle tree stored on the PostgreSQL hash chain.
          </p>
        </div>

        {/* Hashes Pill Box */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono">
            <span className="text-slate-500">Merkle Root:</span>
            <span className="text-indigo-300 font-semibold">{formatHash(contract.merkleRoot, 6, 6)}</span>
            <button
              onClick={() => copyToClipboard(contract.merkleRoot, 'merkle')}
              className="text-slate-400 hover:text-white ml-1"
            >
              {copiedHash === 'merkle' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono">
            <span className="text-slate-500">Genesis Hash:</span>
            <span className="text-cyan-300 font-semibold">{formatHash(contract.genesisLedgerHash, 6, 6)}</span>
            <button
              onClick={() => copyToClipboard(contract.genesisLedgerHash, 'genesis')}
              className="text-slate-400 hover:text-white ml-1"
            >
              {copiedHash === 'genesis' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
        </div>
      </div>

      {/* Requirements List */}
      <div className="space-y-3">
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
          Locked Scope Items ({contract.requirements?.length || 0})
        </div>

        <div className="grid grid-cols-1 gap-3">
          {contract.requirements?.map((req, index) => (
            <div
              key={req.id || index}
              className="p-4 rounded-xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition-all flex flex-col sm:flex-row sm:items-start justify-between gap-4"
            >
              <div className="space-y-1.5 flex-1">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-md bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-[10px] font-bold font-mono">
                    #{index + 1}
                  </span>
                  <h4 className="text-sm font-semibold text-slate-200">{req.title}</h4>
                  <Badge variant={req.status === 'VERIFIED' ? 'success' : 'primary'} size="xs">
                    {req.status}
                  </Badge>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed pl-7">
                  {req.description}
                </p>
                <div className="pl-7 flex items-center gap-3 text-[11px] text-slate-500">
                  <span className="flex items-center gap-1 font-mono">
                    <FileCode className="w-3.5 h-3.5 text-indigo-400" />
                    {req.techStack}
                  </span>
                  <span>•</span>
                  <span>Weight: {req.weight || 1.0}x</span>
                </div>
              </div>

              {/* Action: Verify Inclusion Proof */}
              <div className="sm:self-center">
                <button
                  onClick={() => onInspectProof && onInspectProof(req, index)}
                  className="w-full sm:w-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 text-xs font-semibold transition-colors shadow-sm"
                >
                  <Search className="w-3.5 h-3.5" />
                  <span>Verify Merkle Proof</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Deliverables Box */}
      <div className="p-4 rounded-xl bg-[#090d16] border border-slate-800/80">
        <h5 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-emerald-400" />
          Contract Deliverables
        </h5>
        <ul className="space-y-1.5 text-xs text-slate-400">
          {contract.deliverables?.map((del, idx) => (
            <li key={idx} className="flex items-start gap-2">
              <span className="text-indigo-400 font-bold">•</span>
              <span>{del}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
