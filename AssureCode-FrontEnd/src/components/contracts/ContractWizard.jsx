import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { 
  FilePlus2, 
  Sparkles, 
  Lock, 
  CheckCircle, 
  Plus, 
  Trash2, 
  ArrowRight, 
  ArrowLeft, 
  DollarSign, 
  Calendar, 
  Cpu, 
  ShieldCheck, 
  CreditCard,
  Loader2,
  FileCode
} from 'lucide-react';
import { MatchmakingResults } from './MatchmakingResults';
import { Badge } from '../common/Badge';

export function ContractWizard({ onComplete }) {
  const { freelancers, createAndLockContract, setActiveTab } = useApp();

  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form State
  const [formData, setFormData] = useState({
    title: 'High-Throughput Zero-Trust Microservice with RFC 6962 Proofs',
    budget: '4200',
    deadline: '2026-08-30',
    requirements: [
      {
        title: 'Zero-Trust Ephemeral Sandbox Execution',
        description: 'Run commits in isolated Docker environment with network: none and memory capped at 512MB.',
        techStack: 'Docker / cgroups'
      },
      {
        title: 'RFC 6962 Binary Merkle Tree Construction',
        description: 'Generate binary Merkle trees with SHA-256 leaf prefix 0x00 and interior node prefix 0x01.',
        techStack: 'Postgres 17 / WebCrypto'
      },
      {
        title: 'OWASP 2025 Dual-Layer Security Verification',
        description: 'Zero critical vulnerabilities permitted in Semgrep static analysis and LLM audit.',
        techStack: 'Semgrep + Cloudflare AI'
      }
    ],
    selectedFreelancerId: freelancers[0]?.id || 'fl-101'
  });

  const addRequirement = () => {
    setFormData(prev => ({
      ...prev,
      requirements: [
        ...prev.requirements,
        {
          title: `Requirement #${prev.requirements.length + 1}`,
          description: 'Detailed requirement specification for AST verification and hidden test generation.',
          techStack: 'TypeScript / Node.js'
        }
      ]
    }));
  };

  const removeRequirement = (idx) => {
    setFormData(prev => ({
      ...prev,
      requirements: prev.requirements.filter((_, i) => i !== idx)
    }));
  };

  const updateRequirement = (idx, field, value) => {
    setFormData(prev => ({
      ...prev,
      requirements: prev.requirements.map((req, i) => i === idx ? { ...req, [field]: value } : req)
    }));
  };

  const handleSubmitAndLock = async () => {
    setIsSubmitting(true);
    await new Promise(resolve => setTimeout(resolve, 1000));

    await createAndLockContract({
      title: formData.title,
      budget: formData.budget,
      deadline: formData.deadline,
      requirements: formData.requirements,
      freelancerId: formData.selectedFreelancerId
    });

    setIsSubmitting(false);
    if (onComplete) onComplete();
    setActiveTab('WORKSPACE');
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Wizard Header */}
      <div className="glass-panel rounded-2xl p-6 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-brand-600/20 text-indigo-400 border border-brand-500/30">
              <FilePlus2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Create & Cryptographically Lock Contract</h2>
              <p className="text-xs text-slate-400">
                Objective 1: Sentence-BERT talent matching, Cloudflare AI test generation, and Merkle ledger lock.
              </p>
            </div>
          </div>
        </div>

        {/* Step Indicator */}
        <div className="flex items-center gap-2">
          {[1, 2, 3, 4].map(s => (
            <div
              key={s}
              className={`flex items-center justify-center w-8 h-8 rounded-xl font-mono text-xs font-bold transition-all ${
                step === s
                  ? 'bg-brand-600 text-white shadow-lg shadow-brand-500/30'
                  : step > s
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'bg-slate-800 text-slate-500'
              }`}
            >
              {step > s ? <CheckCircle className="w-4 h-4" /> : s}
            </div>
          ))}
        </div>
      </div>

      {/* Step 1: Project Scope & Requirements */}
      {step === 1 && (
        <div className="glass-panel rounded-2xl p-6 border border-slate-800 space-y-6 animate-fade-in">
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div>
              <h3 className="text-base font-bold text-white">Step 1: Define Project Scope & Requirements</h3>
              <p className="text-xs text-slate-400">
                Every requirement will be hashed into an RFC 6962 Merkle tree and verified by hidden CI test suites.
              </p>
            </div>
            <Badge variant="primary" size="xs">Scope Lock Ready</Badge>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                Contract Title
              </label>
              <input
                type="text"
                value={formData.title}
                onChange={e => setFormData({ ...formData, title: e.target.value })}
                className="w-full px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 focus:border-brand-500 focus:outline-none text-sm text-white font-medium"
                placeholder="e.g. High-Throughput Zero-Trust API Gateway"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1">
                  <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
                  Escrow Budget (USD)
                </label>
                <input
                  type="number"
                  value={formData.budget}
                  onChange={e => setFormData({ ...formData, budget: e.target.value })}
                  className="w-full px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 focus:border-brand-500 focus:outline-none text-sm text-white font-mono"
                  placeholder="3800"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-indigo-400" />
                  Target Delivery Deadline
                </label>
                <input
                  type="date"
                  value={formData.deadline}
                  onChange={e => setFormData({ ...formData, deadline: e.target.value })}
                  className="w-full px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 focus:border-brand-500 focus:outline-none text-sm text-white"
                />
              </div>
            </div>

            {/* Dynamic Requirements List */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Atomic Contract Requirements ({formData.requirements.length})
                </label>
                <button
                  type="button"
                  onClick={addRequirement}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 text-xs font-semibold border border-indigo-500/30 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Requirement</span>
                </button>
              </div>

              {formData.requirements.map((req, idx) => (
                <div key={idx} className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-indigo-400 font-mono">
                      Requirement #{idx + 1}
                    </span>
                    {formData.requirements.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeRequirement(idx)}
                        className="text-slate-500 hover:text-rose-400 p-1"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  <input
                    type="text"
                    value={req.title}
                    onChange={e => updateRequirement(idx, 'title', e.target.value)}
                    placeholder="Requirement headline"
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
                  />

                  <textarea
                    rows={2}
                    value={req.description}
                    onChange={e => updateRequirement(idx, 'description', e.target.value)}
                    placeholder="Technical description and verification criteria"
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-300"
                  />

                  <input
                    type="text"
                    value={req.techStack}
                    onChange={e => updateRequirement(idx, 'techStack', e.target.value)}
                    placeholder="Tech stack (e.g. Fastify, Docker, Postgres)"
                    className="w-full px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-[11px] font-mono text-indigo-300"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold shadow-lg shadow-brand-500/25 transition-all"
            >
              <span>Next: AI Matchmaking</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Sentence-BERT Talent Matchmaking */}
      {step === 2 && (
        <div className="glass-panel rounded-2xl p-6 border border-slate-800 space-y-6 animate-fade-in">
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div>
              <h3 className="text-base font-bold text-white">Step 2: Sentence-BERT Vector Talent Match</h3>
              <p className="text-xs text-slate-400">
                Freelancers ranked using high-dimensional cosine similarity against your project requirements.
              </p>
            </div>
          </div>

          <MatchmakingResults
            freelancers={freelancers}
            selectedId={formData.selectedFreelancerId}
            onSelectFreelancer={(id) => setFormData({ ...formData, selectedFreelancerId: id })}
          />

          <div className="flex items-center justify-between pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-semibold hover:bg-slate-700"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back</span>
            </button>

            <button
              type="button"
              onClick={() => setStep(3)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold shadow-lg shadow-brand-500/25"
            >
              <span>Next: Synthesize Hidden Tests</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Cloudflare Workers AI Hidden Test Bundle Preview */}
      {step === 3 && (
        <div className="glass-panel rounded-2xl p-6 border border-slate-800 space-y-6 animate-fade-in">
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div>
              <h3 className="text-base font-bold text-white">Step 3: Hidden Test Bundle Synthesis</h3>
              <p className="text-xs text-slate-400">
                Cloudflare Workers AI automatically analyzes requirements to generate read-only CI verification suites.
              </p>
            </div>
            <Badge variant="cyan" size="xs">Cloudflare AI (Llama 3.3)</Badge>
          </div>

          <div className="p-4 rounded-xl bg-[#070a12] border border-slate-800 font-mono text-xs text-slate-300 space-y-2">
            <div className="text-cyan-400 font-bold flex items-center gap-2">
              <Cpu className="w-4 h-4" />
              Synthesizing 8 Hidden Test Cases for Sandbox Execution:
            </div>
            <div className="text-slate-400 pl-6 space-y-1">
              <div>✓ test_hash_chain_tamper_detection.py (RFC 6962 validation)</div>
              <div>✓ test_merkle_inclusion_proof.ts (Binary tree root verification)</div>
              <div>✓ test_ast_cyclomatic_complexity.js (McCabe threshold check &lt; 10)</div>
              <div>✓ test_owasp_a03_sql_injection_defense.ts (Static rule assert)</div>
              <div>✓ test_scope_cosine_boundary.ts (pgvector 0.2731 threshold)</div>
              <div>✓ test_ephemeral_network_isolation.sh (network=none assertion)</div>
            </div>
            <div className="text-emerald-400 text-[11px] pt-2 border-t border-slate-800">
              * Test bundle will be injected read-only into ephemeral Docker container on push.
            </div>
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-semibold hover:bg-slate-700"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back</span>
            </button>

            <button
              type="button"
              onClick={() => setStep(4)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold shadow-lg shadow-brand-500/25"
            >
              <span>Next: Lock & Fund Escrow</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Cryptographic Lock & Stripe Escrow Deposit */}
      {step === 4 && (
        <div className="glass-panel rounded-2xl p-6 border border-slate-800 space-y-6 animate-fade-in">
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div>
              <h3 className="text-base font-bold text-white">Step 4: Lock Merkle Tree & Fund Stripe Escrow</h3>
              <p className="text-xs text-slate-400">
                Lock requirements into PostgreSQL hash chain with RFC 8785 canonicalization and create Stripe PaymentIntent.
              </p>
            </div>
            <Badge variant="success" size="xs">Deterministic Escrow</Badge>
          </div>

          {/* Contract Summary Box */}
          <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3 text-xs">
            <div className="flex justify-between py-1 border-b border-slate-800">
              <span className="text-slate-400">Contract Title</span>
              <span className="font-semibold text-white">{formData.title}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800">
              <span className="text-slate-400">Assigned Freelancer</span>
              <span className="font-semibold text-indigo-300">
                {freelancers.find(f => f.id === formData.selectedFreelancerId)?.name}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800">
              <span className="text-slate-400">Escrow Deposit</span>
              <span className="font-bold text-emerald-400 font-mono">${formData.budget}.00 USD</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-slate-400">Settlement Oracle Rule</span>
              <span className="font-mono text-cyan-300">Deterministic Trust Score &ge; 85 & 0 Critical CVEs</span>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-brand-950/30 border border-brand-500/30 text-xs flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-indigo-400 flex-shrink-0 mt-0.5" />
            <div className="text-slate-300 leading-relaxed">
              Once locked, requirements cannot be altered without a formal <strong>Contract Amendment</strong> re-anchored on the ledger. Funds remain in Stripe Escrow until the CI verification and Trust Score meet oracle criteria.
            </div>
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={() => setStep(3)}
              disabled={isSubmitting}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-semibold hover:bg-slate-700"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back</span>
            </button>

            <button
              type="button"
              disabled={isSubmitting}
              onClick={handleSubmitAndLock}
              className="flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-brand-600 to-indigo-600 hover:from-brand-500 hover:to-indigo-500 text-white text-xs font-bold shadow-xl shadow-brand-500/30 transition-all disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Locking Merkle Hash Chain...</span>
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  <span>Lock Contract & Fund Escrow (${formData.budget})</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
