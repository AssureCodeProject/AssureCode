import React, { useState, useEffect } from 'react';
import { Network, Lock, Key, Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { MerkleTree, formatHash } from '../../utils/cryptoUtils';
import { Badge } from '../common/Badge';

export function MerkleTreeVisualizer({ requirements = [] }) {
  const [treeInstance, setTreeInstance] = useState(null);
  const [copiedHash, setCopiedHash] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);

  useEffect(() => {
    async function initTree() {
      const leaves = requirements.map(r => `${r.title}: ${r.description}`);
      const tree = new MerkleTree(leaves);
      await tree.build();
      setTreeInstance(tree);
    }
    if (requirements.length > 0) {
      initTree();
    }
  }, [requirements]);

  const copyHash = (hash, id) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(id);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  if (!treeInstance || !treeInstance.layers) return null;

  return (
    <div className="glass-panel rounded-2xl p-6 border border-slate-800 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <Network className="w-5 h-5 text-indigo-400" />
            <h3 className="text-base font-bold text-white">RFC 6962 Binary Merkle Tree Topology</h3>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Deterministic binary hash tree computed over canonical requirement payloads.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant="primary" size="xs">Root: {formatHash(treeInstance.root, 4, 4)}</Badge>
          <Badge variant="cyan" size="xs">{treeInstance.layers.length} Tree Levels</Badge>
        </div>
      </div>

      {/* Visual Tree Layers */}
      <div className="space-y-6 overflow-x-auto py-4">
        {treeInstance.layers.slice().reverse().map((layer, layerIdx) => {
          const actualLevel = treeInstance.layers.length - 1 - layerIdx;
          const isRootLayer = layerIdx === 0;
          const isLeafLayer = actualLevel === 0;

          return (
            <div key={layerIdx} className="space-y-2 text-center">
              <div className="text-[11px] font-mono font-semibold uppercase text-slate-500 flex items-center justify-center gap-2">
                <span>{isRootLayer ? 'Merkle Root' : isLeafLayer ? 'Leaf Nodes (0x00 prefix)' : `Internal Layer ${actualLevel} (0x01 prefix)`}</span>
              </div>

              <div className="flex items-center justify-center flex-wrap gap-3">
                {layer.map((node) => {
                  const isSelected = selectedNode?.id === node.id;

                  return (
                    <div
                      key={node.id}
                      onClick={() => setSelectedNode(node)}
                      className={`p-3 rounded-xl border text-xs font-mono transition-all cursor-pointer ${
                        isRootLayer
                          ? 'bg-indigo-950/60 border-indigo-500 shadow-lg shadow-indigo-500/20'
                          : isLeafLayer
                          ? 'bg-slate-900/80 border-slate-800 hover:border-slate-700'
                          : 'bg-slate-900/60 border-cyan-900/60 hover:border-cyan-700'
                      } ${isSelected ? 'ring-2 ring-indigo-400' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2 text-[10px] text-slate-400 mb-1">
                        <span className="font-semibold text-slate-300">{node.label || node.id}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            copyHash(node.hash, node.id);
                          }}
                          className="hover:text-white"
                        >
                          {copiedHash === node.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                      <div className={`font-bold ${isRootLayer ? 'text-indigo-300 text-sm' : 'text-slate-300'}`}>
                        {formatHash(node.hash, 6, 6)}
                      </div>
                    </div>
                  );
                })}
              </div>

              {!isLeafLayer && (
                <div className="w-0.5 h-4 bg-slate-800 mx-auto my-1" />
              )}
            </div>
          );
        })}
      </div>

      {/* Selected Node Details Drawer */}
      {selectedNode && (
        <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2 text-xs font-mono animate-fade-in">
          <div className="flex items-center justify-between text-slate-400">
            <span className="font-semibold text-white">Node Inspector: {selectedNode.id}</span>
            <span>{selectedNode.isLeaf ? 'LEAF NODE' : 'INTERIOR NODE'}</span>
          </div>
          <div className="p-2.5 rounded-lg bg-[#070a12] border border-slate-800 text-indigo-300 break-all select-all">
            Full SHA-256: {selectedNode.hash}
          </div>
          {selectedNode.data && (
            <div className="text-slate-300 font-sans text-xs">
              <span className="text-slate-500 font-semibold">Raw Data: </span>
              {selectedNode.data}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
