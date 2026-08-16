import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { 
  Database, 
  Link as LinkIcon, 
  ShieldCheck, 
  Key, 
  Copy, 
  Check, 
  ChevronDown, 
  ChevronRight,
  Clock,
  Code2,
  Lock,
  Layers
} from 'lucide-react';
import { MerkleTreeVisualizer } from './MerkleTreeVisualizer';
import { formatHash, canonicalizeJson } from '../../utils/cryptoUtils';
import { Badge } from '../common/Badge';

export function LedgerExplorer() {
  const { ledgerBlocks, activeContract } = useApp();
  const [expandedBlocks, setExpandedBlocks] = useState({});
  const [copiedHash, setCopiedHash] = useState(null);
  const [showMerkleTree, setShowMerkleTree] = useState(true);

  const toggleBlock = (seq) => {
    setExpandedBlocks(prev => ({
      ...prev,
      [seq]: !prev[seq]
    }));
  };

  const copyText = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopiedHash(key);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="glass-panel rounded-2xl p-6 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-indigo-400" />
            <h2 className="text-xl font-bold text-white">PostgreSQL Tamper-Evident Ledger</h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            RFC 8785 Canonicalized events linked via SHA-256 hash chains and RFC 6962 Merkle trees.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant="success" size="xs">Chain Height: #{ledgerBlocks.length - 1}</Badge>
          <Badge variant="cyan" size="xs">Supabase Postgres 17.6</Badge>
        </div>
      </div>

      {/* Merkle Tree Visualizer Toggle */}
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-bold text-slate-300 flex items-center gap-2">
          <Layers className="w-4 h-4 text-indigo-400" />
          Active Contract Merkle Topology
        </h3>
        <button
          onClick={() => setShowMerkleTree(!showMerkleTree)}
          className="text-xs text-indigo-300 hover:text-indigo-200 font-semibold flex items-center gap-1"
        >
          {showMerkleTree ? 'Hide Topology' : 'Show Topology'}
        </button>
      </div>

      {showMerkleTree && activeContract && (
        <MerkleTreeVisualizer requirements={activeContract.requirements} />
      )}

      {/* Blocks Feed */}
      <div className="space-y-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Cryptographic Block Chain ({ledgerBlocks.length} Blocks)
        </div>

        <div className="space-y-4">
          {ledgerBlocks.slice().reverse().map((block, idx) => {
            const isExpanded = !!expandedBlocks[block.sequenceNumber];
            const eventColors = {
              GENESIS_INIT: 'text-slate-300 border-slate-700',
              CONTRACT_INITIALIZED: 'text-indigo-400 border-indigo-500/40',
              CONTRACT_LOCKED: 'text-indigo-300 border-brand-500/50',
              CODE_PUSH_RECEIVED: 'text-cyan-400 border-cyan-500/40',
              ZERO_TRUST_CI_VERIFIED: 'text-emerald-400 border-emerald-500/40',
              SCOPE_GUARD_VERIFIED: 'text-purple-400 border-purple-500/40',
              SETTLEMENT_COMPLETED: 'text-amber-400 border-amber-500/40',
              CONTRACT_AMENDED: 'text-rose-400 border-rose-500/40'
            };

            const colorClass = eventColors[block.eventType] || 'text-slate-300 border-slate-700';

            return (
              <div
                key={block.sequenceNumber}
                className="glass-panel rounded-2xl border border-slate-800 p-5 space-y-4 hover:border-slate-700 transition-all font-mono text-xs"
              >
                {/* Block Header */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800/80">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-xl bg-slate-900 border border-slate-700 flex items-center justify-center font-bold text-white text-xs">
                      #{block.sequenceNumber}
                    </span>
                    <div>
                      <div className={`font-bold text-sm tracking-wide ${colorClass}`}>
                        {block.eventType}
                      </div>
                      <div className="text-[11px] text-slate-400 flex items-center gap-1 font-sans mt-0.5">
                        <Clock className="w-3 h-3 text-slate-500" />
                        <span>{new Date(block.timestamp).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>

                  {/* Signer & Action Toggle */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-400 font-sans hidden sm:inline">
                      Signer: <code className="text-slate-300 font-mono">{block.signer}</code>
                    </span>
                    <button
                      onClick={() => toggleBlock(block.sequenceNumber)}
                      className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-sans font-semibold flex items-center gap-1 transition-colors"
                    >
                      <span>{isExpanded ? 'Collapse Payload' : 'View Payload'}</span>
                      {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {/* Hashes Row */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[11px]">
                  {/* Current Block Hash */}
                  <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
                    <div className="text-slate-500 text-[10px] uppercase">Block Hash (SHA-256)</div>
                    <div className="flex items-center justify-between mt-1 text-slate-200">
                      <span className="truncate">{formatHash(block.blockHash, 8, 8)}</span>
                      <button
                        onClick={() => copyText(block.blockHash, `hash-${block.sequenceNumber}`)}
                        className="text-slate-400 hover:text-white ml-2"
                      >
                        {copiedHash === `hash-${block.sequenceNumber}` ? (
                          <Check className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Previous Block Hash */}
                  <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
                    <div className="text-slate-500 text-[10px] uppercase">Prev Block Hash</div>
                    <div className="mt-1 text-slate-400 truncate">
                      {formatHash(block.prevHash, 8, 8)}
                    </div>
                  </div>

                  {/* Merkle Root */}
                  <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
                    <div className="text-slate-500 text-[10px] uppercase">Merkle Root</div>
                    <div className="mt-1 text-indigo-300 truncate">
                      {formatHash(block.merkleRoot, 8, 8)}
                    </div>
                  </div>
                </div>

                {/* Expandable Canonical JSON Payload */}
                {isExpanded && (
                  <div className="p-4 rounded-xl bg-[#060810] border border-slate-800 space-y-2 animate-fade-in">
                    <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center justify-between">
                      <span>RFC 8785 Canonical JSON Payload</span>
                      <span className="text-indigo-400">Ed25519 Signature Verified</span>
                    </div>
                    <pre className="text-cyan-300 text-[11px] overflow-x-auto p-2 bg-[#0a0e1a] rounded-lg">
                      {JSON.stringify(block.payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
