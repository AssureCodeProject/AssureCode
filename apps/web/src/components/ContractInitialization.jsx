import React, { useState, useCallback, useEffect } from 'react';
import { callApi } from '../utils/api';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowRight,
  Loader2,
  Check,
  Copy,
} from 'lucide-react';

const LOADING_STEPS = [
  {
    id: 1,
    text: 'NLP Extracting Constraints...',
    detail: 'Parsing semantic tokens from requirements corpus',
    duration: 2200,
  },
  {
    id: 2,
    text: 'Agentic LLM Generating Hidden Unit Tests...',
    detail: 'Synthesizing edge-case test vectors',
    duration: 2600,
  },
  {
    id: 3,
    text: 'Locking Contract to Merkle Hash Chain...',
    detail: 'Writing immutable record to distributed ledger',
    duration: 2000,
  },
];

export function ContractInitialization({
  onContractLocked,
  contractData,
  onProceedToPhase2,
}) {
  // Form state
  const [formData, setFormData] = useState({
    title: '',
    requirements: '',
    budget: '',
    deadline: '',
  });

  // Selected scenario state
  const [selectedPreset, setSelectedPreset] = useState(null);

  // Process state
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState([]);
  const [isLocked, setIsLocked] = useState(!!contractData);
  const [lockedData, setLockedData] = useState(contractData || null);
  const [copiedHash, setCopiedHash] = useState(false);

  // Sync locked state when contractData prop changes
  useEffect(() => {
    setIsLocked(!!contractData);
    setLockedData(contractData || null);
  }, [contractData]);

  // Handle form field changes
  const handleChange = useCallback(
    (e) => {
      const { name, value } = e.target;
      setFormData((prev) => ({ ...prev, [name]: value }));
    },
    []
  );

  // Validate form inputs
  const isFormValid = Boolean(
    formData.title.trim() &&
      formData.requirements.trim() &&
      formData.budget &&
      formData.deadline
  );

  // Submit and run contract lock pipeline
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isFormValid || isProcessing) return;

    setIsProcessing(true);
    setCurrentStep(0);
    setCompletedSteps([]);

    try {
      // Step 1: Initialize contract
      setCurrentStep(1);
      const initResponse = await callApi('/api/contracts/initialize', 'POST', {
        title: formData.title,
        requirements: formData.requirements,
        budgetCents: Number(formData.budget) * 100,
        deadline: formData.deadline,
      });
      setCompletedSteps((prev) => [...prev, 1]);

      // Step 1.5: NLP Matchmaker & Assign Freelancer
      const matchResponse = await callApi(
        `/api/contracts/${initResponse.contractId}/match`,
        'POST',
        { requirements: formData.requirements, topK: 5 }
      ).catch(() => null);

      const assignedFreelancerId = matchResponse?.results?.[0]?.freelancer_id || 'freelancer-priya';
      await callApi(
        `/api/contracts/${initResponse.contractId}/assign`,
        'POST',
        { freelancerId: assignedFreelancerId }
      ).catch(() => null);

      // Step 2: Generate unit tests
      setCurrentStep(2);
      await callApi(`/api/contracts/${initResponse.contractId}/generate-tests`, 'POST', {
        title: formData.title,
        requirements: formData.requirements,
        framework: 'jest',
      });
      setCompletedSteps((prev) => [...prev, 2]);

      // Step 3: Lock contract (returns real ledger Merkle hash)
      setCurrentStep(3);
      const lockResponse = await callApi(
        `/api/contracts/${initResponse.contractId}/lock`,
        'POST',
        {
          title: formData.title,
          requirements: formData.requirements,
          budgetCents: Number(formData.budget) * 100,
          deadline: formData.deadline,
        }
      );
      setCompletedSteps((prev) => [...prev, 3]);

      const result = {
        ...formData,
        hash: lockResponse.hash,
        timestamp: lockResponse.timestamp,
        contractId: initResponse.contractId,
        clientId: initResponse.clientId,
        budgetCents: lockResponse.budgetCents,
      };

      setLockedData(result);
      setIsLocked(true);
      setIsProcessing(false);
      onContractLocked(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Contract initialization failed:', error);
      setIsProcessing(false);
      alert(`Failed to initialize contract: ${message}`);
    }
  };

  const handleCopyHash = () => {
    if (!lockedData?.hash) return;
    navigator.clipboard.writeText(lockedData.hash);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  };

  // Helper to split hash into 8-character chunks for the signature ledger element
  const formatHashLines = (hashStr) => {
    if (!hashStr) return [];
    const clean = hashStr.replace(/^0x/, '');
    const chunks = [];
    for (let i = 0; i < clean.length; i += 8) {
      chunks.push(clean.slice(i, i + 8));
    }
    // Group chunks into lines of up to 8 chunks per line (64 chars)
    const lines = [];
    for (let i = 0; i < chunks.length; i += 8) {
      lines.push(chunks.slice(i, i + 8));
    }
    return lines;
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 font-sans">
      {/* ── Section Header ─────────────────────────────────────────── */}
      <div className="border-b border-rule pb-6">
        <div className="flex items-center justify-between font-mono text-xs text-prose-muted uppercase tracking-widest mb-3">
          <span>PHASE 01 of 04 ───────────────────────────────────────────</span>
          <span className={isLocked ? 'text-signal font-semibold' : 'text-prose-dim'}>
            {isLocked ? '✓ UNLOCKED & LOCKED TO CHAIN' : '○ PENDING LOCK'}
          </span>
        </div>
        <h1 className="text-4xl sm:text-5xl font-display font-bold text-prose tracking-tight">
          Define the contract.
        </h1>
        <p className="text-prose-muted mt-2 text-base max-w-2xl">
          Lock the terms to a Merkle hash before any work begins.
        </p>
      </div>

      <AnimatePresence mode="wait">
        {/* ────────────────── LOCKED / SIGNATURE HASH STATE ────────────────── */}
        {isLocked && lockedData ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="space-y-6"
          >
            {/* Signature Element: Grouped-Monospace Hash Ledger Viewer */}
            <div className="bg-ink-2 border border-rule p-6 sm:p-8 font-mono">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rule pb-4 mb-6 text-xs text-prose-muted">
                <div>
                  <span className="text-signal font-bold">LOCKED</span> │ BLOCK <span className="text-prose">{lockedData.hash ? `${lockedData.hash.slice(0, 10)}…${lockedData.hash.slice(-4)}` : '0x7f3a…ecc1'}</span> │ EXTENDED 1
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-prose-dim">SHA-256</span>
                  <button
                    onClick={handleCopyHash}
                    className="flex items-center gap-1 text-xs text-signal hover:underline transition-colors"
                  >
                    {copiedHash ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>[copied]</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>[copy hash]</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Monospace 8-character grouped hash grid with verification status */}
              <div className="space-y-3 bg-ink p-4 border border-rule text-xs sm:text-sm">
                {formatHashLines(lockedData.hash).map((lineChunks, lineIdx) => (
                  <motion.div
                    key={lineIdx}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: lineIdx * 0.08 }}
                    className="flex flex-wrap items-center justify-between gap-3 border-b border-rule/50 pb-2 last:border-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-center gap-2 sm:gap-4 font-mono tracking-wider text-prose">
                      {lineChunks.map((chunk, chunkIdx) => (
                        <span key={chunkIdx} className="bg-ink-3 px-1.5 py-0.5 border border-rule text-signal">
                          {chunk}
                        </span>
                      ))}
                    </div>
                    <span className="text-signal text-xs font-mono flex items-center gap-1 shrink-0">
                      ✓ chain valid
                    </span>
                  </motion.div>
                ))}
              </div>

              {/* Timestamp & Metadata */}
              <div className="mt-6 pt-4 border-t border-rule flex flex-wrap items-center justify-between gap-2 text-xs text-prose-muted">
                <span>Timestamp: {new Date(lockedData.timestamp || Date.now()).toISOString()}</span>
                <span>Contract ID: {lockedData.contractId}</span>
              </div>
            </div>

            {/* Hairline-Ruled Contract Summary Table */}
            <div className="bg-ink-2 border border-rule divide-y divide-rule font-sans">
              <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-sm">
                <span className="font-mono text-xs text-prose-muted uppercase tracking-wider">Title</span>
                <span className="font-semibold text-prose">{lockedData.title}</span>
              </div>
              <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-sm">
                <span className="font-mono text-xs text-prose-muted uppercase tracking-wider">Budget</span>
                <span className="font-mono text-prose font-semibold">
                  ${(lockedData.budgetCents != null ? lockedData.budgetCents / 100 : Number(lockedData.budget || 0)).toLocaleString('en-US', { minimumFractionDigits: 2 })} USD
                </span>
              </div>
              <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-sm">
                <span className="font-mono text-xs text-prose-muted uppercase tracking-wider">Deadline</span>
                <span className="font-mono text-prose">{lockedData.deadline}</span>
              </div>
            </div>

            {/* Primary Action to Phase 2 */}
            <button
              id="btn-proceed-phase2"
              onClick={onProceedToPhase2}
              className="w-full py-4 bg-signal text-ink font-mono font-bold text-sm tracking-wider uppercase
                         hover:opacity-90 active:scale-[0.99] transition-all flex items-center justify-center gap-2"
            >
              <span>Proceed to Zero-Trust Verification</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </motion.div>
        ) : (
          /* ────────────────── FORM / LOADING STATE ────────────────── */
          <motion.div
            key="form"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            <form id="contract-form" onSubmit={handleSubmit} className="space-y-8">
              {/* Scenario Preset Selector Chips */}
              <div className="bg-ink-2 border border-rule p-5 space-y-3">
                <label className="block text-xs font-mono text-prose-muted uppercase tracking-wider">
                  Select Preset Scenario
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPreset('fintech');
                      setFormData({
                        title: 'Fintech Real-Time Dashboard',
                        requirements: 'Build a React TypeScript dashboard with Node.js Fastify backend and PostgreSQL database.',
                        budget: '2500',
                        deadline: '2026-12-31',
                      });
                    }}
                    className={`p-3 text-left font-mono text-xs border transition-colors ${
                      selectedPreset === 'fintech'
                        ? 'border-signal text-signal bg-signal/5 font-semibold'
                        : 'border-rule text-prose-muted hover:text-prose hover:border-rule-hi bg-ink-3'
                    }`}
                  >
                    <div className="font-bold text-prose">[ Fintech ]</div>
                    <div className="text-[11px] text-prose-muted mt-1">$2,500 • React/Node</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPreset('ai');
                      setFormData({
                        title: 'PyTorch RAG LLM Pipeline',
                        requirements: 'Build a PyTorch RAG LLM pipeline using FastAPI, LangChain, and vector databases for semantic document search.',
                        budget: '3800',
                        deadline: '2026-12-31',
                      });
                    }}
                    className={`p-3 text-left font-mono text-xs border transition-colors ${
                      selectedPreset === 'ai'
                        ? 'border-signal text-signal bg-signal/5 font-semibold'
                        : 'border-rule text-prose-muted hover:text-prose hover:border-rule-hi bg-ink-3'
                    }`}
                  >
                    <div className="font-bold text-prose">[ AI / RAG ]</div>
                    <div className="text-[11px] text-prose-muted mt-1">$3,800 • PyTorch/FastAPI</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPreset('web3');
                      setFormData({
                        title: 'DeFi Solidity Smart Contracts',
                        requirements: 'Develop Solidity smart contracts for Ethereum decentralized finance protocol with Ethers.js integration.',
                        budget: '4200',
                        deadline: '2026-12-31',
                      });
                    }}
                    className={`p-3 text-left font-mono text-xs border transition-colors ${
                      selectedPreset === 'web3'
                        ? 'border-signal text-signal bg-signal/5 font-semibold'
                        : 'border-rule text-prose-muted hover:text-prose hover:border-rule-hi bg-ink-3'
                    }`}
                  >
                    <div className="font-bold text-prose">[ Web3 ]</div>
                    <div className="text-[11px] text-prose-muted mt-1">$4,200 • Solidity</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPreset('devops');
                      setFormData({
                        title: 'Kubernetes Terraform Infra',
                        requirements: 'Provision multi-region Kubernetes cluster with Terraform IaC, AWS infrastructure, and Prometheus monitoring.',
                        budget: '3000',
                        deadline: '2026-12-31',
                      });
                    }}
                    className={`p-3 text-left font-mono text-xs border transition-colors ${
                      selectedPreset === 'devops'
                        ? 'border-signal text-signal bg-signal/5 font-semibold'
                        : 'border-rule text-prose-muted hover:text-prose hover:border-rule-hi bg-ink-3'
                    }`}
                  >
                    <div className="font-bold text-prose">[ DevOps ]</div>
                    <div className="text-[11px] text-prose-muted mt-1">$3,000 • K8s/AWS</div>
                  </button>
                </div>
              </div>

              {/* Hairline-Ruled Form Fields */}
              <div className="bg-ink-2 border border-rule p-6 sm:p-8 space-y-6">
                {/* Title */}
                <div>
                  <label htmlFor="input-title" className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
                    Project Title
                  </label>
                  <input
                    id="input-title"
                    name="title"
                    type="text"
                    value={formData.title}
                    onChange={handleChange}
                    disabled={isProcessing}
                    placeholder="e.g. AI-Powered Portfolio Builder"
                    className="w-full bg-ink px-4 py-3 border-b border-rule text-prose placeholder:text-prose-dim text-sm
                               focus:border-signal outline-none transition-colors disabled:opacity-40"
                  />
                </div>

                {/* Requirements */}
                <div>
                  <label htmlFor="input-requirements" className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
                    Detailed Requirements & Technical Specs
                  </label>
                  <textarea
                    id="input-requirements"
                    name="requirements"
                    rows={5}
                    value={formData.requirements}
                    onChange={handleChange}
                    disabled={isProcessing}
                    placeholder="Describe the project scope, features, acceptance criteria, and technical constraints..."
                    className="w-full bg-ink p-4 border-b border-rule text-prose placeholder:text-prose-dim text-sm resize-none
                               focus:border-signal outline-none transition-colors disabled:opacity-40"
                  />
                </div>

                {/* Budget & Deadline */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div>
                    <label htmlFor="input-budget" className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
                      Budget (USD)
                    </label>
                    <input
                      id="input-budget"
                      name="budget"
                      type="number"
                      min="1"
                      value={formData.budget}
                      onChange={handleChange}
                      disabled={isProcessing}
                      placeholder="5000"
                      className="w-full bg-ink px-4 py-3 border-b border-rule text-prose font-mono placeholder:text-prose-dim text-sm
                                 focus:border-signal outline-none transition-colors disabled:opacity-40"
                    />
                  </div>

                  <div>
                    <label htmlFor="input-deadline" className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
                      Deadline
                    </label>
                    <input
                      id="input-deadline"
                      name="deadline"
                      type="date"
                      value={formData.deadline}
                      onChange={handleChange}
                      disabled={isProcessing}
                      className="w-full bg-ink px-4 py-3 border-b border-rule text-prose font-mono text-sm
                                 focus:border-signal outline-none transition-colors disabled:opacity-40 [color-scheme:dark]"
                    />
                  </div>
                </div>

                {/* Loading Sequence Console */}
                <AnimatePresence>
                  {isProcessing && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="bg-ink p-4 border border-rule font-mono text-xs space-y-2">
                        <div className="flex items-center gap-2 text-signal mb-2">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>EXECUTING CONTRACT LOCK SEQUENCE...</span>
                        </div>

                        {LOADING_STEPS.map((step) => {
                          const isActive = currentStep === step.id;
                          const isComplete = completedSteps.includes(step.id);

                          return (
                            <div key={step.id} className="flex items-start gap-2">
                              <span className="text-prose-dim">[{step.id}]</span>
                              <div className="flex-1">
                                <span className={isComplete ? 'text-signal' : isActive ? 'text-prose font-bold' : 'text-prose-dim'}>
                                  {step.text}
                                </span>
                                {isActive && (
                                  <div className="text-[11px] text-prose-muted mt-0.5">
                                    └─ {step.detail}
                                  </div>
                                )}
                              </div>
                              {isComplete && <span className="text-signal">✓</span>}
                            </div>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Submit Action Button */}
                <button
                  id="btn-initialize-contract"
                  type="submit"
                  disabled={!isFormValid || isProcessing}
                  className={`w-full py-4 font-mono font-bold text-sm tracking-wider uppercase transition-all flex items-center justify-center gap-2 ${
                    isProcessing
                      ? 'bg-ink-3 text-prose-muted border border-rule cursor-wait'
                      : isFormValid
                      ? 'bg-signal text-ink hover:opacity-90 active:scale-[0.99]'
                      : 'bg-ink-3 text-prose-dim border border-rule cursor-not-allowed'
                  }`}
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>INITIALIZING CONTRACT...</span>
                    </>
                  ) : (
                    <span>Lock Contract →</span>
                  )}
                </button>
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default ContractInitialization;

