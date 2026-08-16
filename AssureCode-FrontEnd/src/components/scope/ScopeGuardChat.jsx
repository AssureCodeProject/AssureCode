import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { 
  MessageSquareCode, 
  Send, 
  Sparkles, 
  ShieldAlert, 
  ShieldCheck, 
  FileEdit, 
  Key, 
  AlertCircle, 
  Info,
  CheckCircle2,
  Bot
} from 'lucide-react';
import { SimilarityGauge } from './SimilarityGauge';
import { evaluateScopeMessage, SCOPE_THRESHOLD } from '../../utils/scopeGuardEngine';
import { formatHash } from '../../utils/cryptoUtils';
import { Badge } from '../common/Badge';

export function ScopeGuardChat() {
  const { activeContract, sendChatMessage, role, setIsAmendmentModalOpen } = useApp();
  const [inputText, setInputText] = useState('');
  const [liveEvaluation, setLiveEvaluation] = useState(null);
  const messagesEndRef = useRef(null);

  // Live Cosine Evaluation as the user types
  useEffect(() => {
    if (inputText.trim().length > 3 && activeContract) {
      const evalResult = evaluateScopeMessage(inputText, activeContract);
      setLiveEvaluation(evalResult);
    } else {
      setLiveEvaluation(null);
    }
  }, [inputText, activeContract]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeContract?.chatMessages]);

  const handleSend = async (e) => {
    e?.preventDefault();
    if (!inputText.trim()) return;

    await sendChatMessage(inputText);
    setInputText('');
    setLiveEvaluation(null);
  };

  const handleTemplateClick = (text) => {
    setInputText(text);
  };

  if (!activeContract) return null;

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="glass-panel rounded-2xl p-6 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <MessageSquareCode className="w-5 h-5 text-indigo-400" />
            <h2 className="text-xl font-bold text-white">Objective 3: Autonomous Scope Mediation & RAG Guard</h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Every chat interaction is anchored to Genesis Ledger Hash <code className="text-cyan-300 font-mono">{formatHash(activeContract.genesisLedgerHash, 6, 6)}</code>. Messages with cosine similarity &ge; 0.2731 are verified into the audit stream.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant="purple" size="xs">pgvector Top-5</Badge>
          <Badge variant="primary" size="xs">Threshold &ge; 0.2731</Badge>
        </div>
      </div>

      {/* Main Chat Layout: Left Chat Stream, Right RAG Scope Guard Engine */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chat Stream (2 Columns) */}
        <div className="lg:col-span-2 glass-panel rounded-2xl border border-slate-800 flex flex-col h-[600px] overflow-hidden">
          {/* Chat Header */}
          <div className="px-5 py-3 bg-[#0f1422] border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-xs font-bold text-slate-200">
                Scope Guard Channel ({activeContract.client.name} &harr; {activeContract.freelancer.name})
              </span>
            </div>
            <span className="text-[10px] text-slate-500 font-mono">
              Anchor: {formatHash(activeContract.genesisLedgerHash, 4, 4)}
            </span>
          </div>

          {/* Chat Messages */}
          <div className="flex-1 p-4 overflow-y-auto space-y-4 bg-[#080c16]">
            {activeContract.chatMessages?.length === 0 ? (
              <div className="text-center py-12 text-slate-500 text-xs">
                No chat messages recorded yet. Send an in-scope or out-of-scope query below to test real-time RAG mediation.
              </div>
            ) : (
              activeContract.chatMessages?.map((msg) => {
                const isMe = (role === 'CLIENT' && msg.sender === 'client') || (role === 'FREELANCER' && msg.sender === 'freelancer');
                const isOutOfScope = msg.scopeResult && !msg.scopeResult.allowed;

                return (
                  <div
                    key={msg.id}
                    className={`flex items-start gap-3 ${isMe ? 'flex-row-reverse' : 'flex-row'}`}
                  >
                    <img
                      src={msg.avatar}
                      alt={msg.senderName}
                      className="w-8 h-8 rounded-full border border-slate-700 object-cover flex-shrink-0"
                    />

                    <div className={`max-w-[80%] space-y-1.5 ${isMe ? 'items-end text-right' : 'items-start text-left'}`}>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400">
                        <span className="font-semibold text-slate-300">{msg.senderName}</span>
                        <span className="text-[10px] text-slate-500">
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>

                      {/* Message Bubble */}
                      <div
                        className={`p-3.5 rounded-2xl text-xs leading-relaxed ${
                          isOutOfScope
                            ? 'bg-rose-950/40 border border-rose-500/50 text-rose-200 shadow-lg shadow-rose-950/30'
                            : isMe
                            ? 'bg-brand-600/30 border border-brand-500/40 text-slate-100'
                            : 'bg-slate-900 border border-slate-800 text-slate-200'
                        }`}
                      >
                        <p>{msg.text}</p>
                      </div>

                      {/* Scope Result Pill */}
                      {msg.scopeResult && (
                        <div className={`flex items-center gap-1.5 text-[10px] font-mono ${isMe ? 'justify-end' : 'justify-start'}`}>
                          {msg.scopeResult.allowed ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              <ShieldCheck className="w-3 h-3" />
                              In-Scope: {(msg.scopeResult.bestSimilarity * 100).toFixed(1)}% match
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-500/15 text-rose-300 border border-rose-500/30">
                              <ShieldAlert className="w-3 h-3 text-rose-400" />
                              Scope Creep: {(msg.scopeResult.bestSimilarity * 100).toFixed(1)}% &lt; 27.31%
                            </span>
                          )}
                        </div>
                      )}

                      {/* Out of scope amendment banner */}
                      {isOutOfScope && (
                        <div className="p-2.5 rounded-xl bg-rose-950/30 border border-rose-500/30 text-[11px] text-left text-slate-300 flex items-center justify-between gap-2 mt-1">
                          <span>Out of scope message requires formal contract amendment.</span>
                          <button
                            onClick={() => setIsAmendmentModalOpen(true)}
                            className="px-2.5 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white font-bold text-[10px] flex items-center gap-1 flex-shrink-0"
                          >
                            <FileEdit className="w-3 h-3" />
                            Propose Amendment
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Demo Templates */}
          <div className="px-4 py-2 bg-[#0a0e1a] border-t border-slate-800/80 flex items-center gap-2 overflow-x-auto text-[11px]">
            <span className="text-slate-500 text-[10px] uppercase font-bold flex-shrink-0 flex items-center gap-1">
              <Bot className="w-3 h-3 text-indigo-400" /> Quick Tests:
            </span>
            <button
              onClick={() => handleTemplateClick('I have implemented the RFC 6962 binary Merkle tree with 0x00 and 0x01 prefixes.')}
              className="px-2.5 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 whitespace-nowrap"
            >
              ✓ In-Scope (Merkle Tree)
            </button>
            <button
              onClick={() => handleTemplateClick('Can you also build a separate React Native iOS & Android mobile app?')}
              className="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 whitespace-nowrap"
            >
              ⚠️ Out-of-Scope (Mobile App)
            </button>
            <button
              onClick={() => handleTemplateClick('Please ensure the Docker sandbox is ephemeral with network none.')}
              className="px-2.5 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 whitespace-nowrap"
            >
              ✓ In-Scope (Docker Sandbox)
            </button>
          </div>

          {/* Input Box */}
          <form onSubmit={handleSend} className="p-3 bg-[#0f1422] border-t border-slate-800 flex items-center gap-2">
            <input
              type="text"
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              placeholder={`Send message as ${role === 'CLIENT' ? 'Client' : 'Freelancer'} (RAG pre-evaluated live)...`}
              className="flex-1 px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 focus:border-brand-500 focus:outline-none text-xs text-white placeholder:text-slate-500"
            />
            <button
              type="submit"
              disabled={!inputText.trim()}
              className="p-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-40 transition-colors shadow-md shadow-brand-500/25"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>

        {/* Right: Real-Time Scope Guard Engine Inspector */}
        <div className="space-y-4">
          <div className="glass-panel rounded-2xl p-5 border border-slate-800 space-y-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              Live Scope Pre-Flight Engine
            </h3>

            {liveEvaluation ? (
              <div className="space-y-3">
                <SimilarityGauge
                  similarity={liveEvaluation.bestSimilarity}
                  threshold={liveEvaluation.threshold}
                  chunks={liveEvaluation.retrievedChunks}
                />
                <p className="text-xs text-slate-400 leading-relaxed bg-slate-900/60 p-3 rounded-xl border border-slate-800">
                  {liveEvaluation.explanation}
                </p>
              </div>
            ) : (
              <div className="p-6 rounded-xl bg-slate-900/40 border border-slate-800 text-center space-y-2">
                <Sparkles className="w-6 h-6 text-slate-500 mx-auto" />
                <div className="text-xs text-slate-300 font-semibold">Ready for Input</div>
                <p className="text-[11px] text-slate-500">
                  Type a message or select a test template to see Sentence-BERT cosine evaluation and pgvector retrieval in real-time.
                </p>
              </div>
            )}
          </div>

          {/* Scope Guard Rules Pill */}
          <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 text-xs space-y-2">
            <div className="font-semibold text-slate-300 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-indigo-400" />
              Scope Guard Verification Policy
            </div>
            <ul className="space-y-1 text-slate-400 text-[11px]">
              <li>• Cosine Similarity &ge; <strong>0.2731</strong> (27.31% match) allows message into contract audit trail.</li>
              <li>• Sub-threshold messages flag scope creep and trigger Contract Amendment modal.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
