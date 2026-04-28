import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText,
  DollarSign,
  Calendar,
  Lock,
  CheckCircle2,
  ArrowRight,
  Loader2,
  Hash,
  ShieldCheck,
  Fingerprint,
  Sparkles,
  Hexagon,
  Zap,
} from 'lucide-react';

/**
 * LOADING_STEPS — Technical loading sequence shown during contract initialization.
 * Each step simulates a backend operation with a minimum display duration.
 */
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
    detail: 'GPT-4 synthesizing edge-case test vectors',
    duration: 2600,
  },
  {
    id: 3,
    text: 'Locking Contract to PostgreSQL Merkle Hash Chain...',
    detail: 'Writing immutable record to distributed ledger',
    duration: 2000,
  },
];

/**
 * generateMockHash — Produces a realistic-looking SHA-256 hex string.
 * In production, this would come from the backend.
 */
function generateMockHash() {
  const chars = '0123456789abcdef';
  let hash = '';
  for (let i = 0; i < 64; i++) {
    hash += chars[Math.floor(Math.random() * 16)];
  }
  return hash;
}

/**
 * ContractInitialization (Phase 1)
 *
 * Renders a "Create Project" form. On submission it plays a technical loading
 * animation, then transitions to a success card showing the immutable contract hash.
 *
 * Props:
 *   onContractLocked(data)  — called when the contract is locked
 *   contractData             — existing contract data (if returning to this page)
 *   onProceedToPhase2()     — navigates to Phase 2
 */
function ContractInitialization({ onContractLocked, contractData, onProceedToPhase2 }) {
  // ── Form state ──────────────────────────────────────────
  const [formData, setFormData] = useState({
    title: '',
    requirements: '',
    budget: '',
    deadline: '',
  });

  // ── Process state ───────────────────────────────────────
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState([]);
  const [isLocked, setIsLocked] = useState(!!contractData);
  const [lockedData, setLockedData] = useState(contractData || null);

  /**
   * Handle form field changes.
   */
  const handleChange = useCallback((e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  }, []);

  /**
   * Validate that all required fields are filled.
   */
  const isFormValid =
    formData.title.trim() &&
    formData.requirements.trim() &&
    formData.budget &&
    formData.deadline;

  /**
   * handleSubmit — Initiates the contract locking sequence.
   *
   * In production, each step would be a real API call:
   *   POST /api/contracts/initialize
   *   POST /api/contracts/generate-tests
   *   POST /api/contracts/lock
   */
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isFormValid || isProcessing) return;

    setIsProcessing(true);
    setCurrentStep(0);
    setCompletedSteps([]);

    // Walk through each loading step sequentially
    for (let i = 0; i < LOADING_STEPS.length; i++) {
      setCurrentStep(i + 1);
      await new Promise((resolve) =>
        setTimeout(resolve, LOADING_STEPS[i].duration)
      );
      setCompletedSteps((prev) => [...prev, i + 1]);
    }

    // Build the locked contract payload
    const hash = generateMockHash();
    const result = {
      ...formData,
      hash,
      timestamp: new Date().toISOString(),
      contractId: `AC-${Date.now().toString(36).toUpperCase()}`,
    };

    // Short pause before revealing the success state
    await new Promise((resolve) => setTimeout(resolve, 600));

    setLockedData(result);
    setIsLocked(true);
    setIsProcessing(false);
    onContractLocked(result);
  };

  // ── Render ──────────────────────────────────────────────
  return (
    <div className="max-w-3xl mx-auto">
      {/* Section Header */}
      <div className="mb-10">
        <div className="flex items-center gap-2 text-sm font-mono text-cyber-400 mb-3 tracking-wider">
          <Hexagon className="w-4 h-4" />
          PHASE 01
        </div>
        <h1 className="text-4xl font-bold text-white tracking-tight">
          Contract <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyber-400 to-neon-400">Initialization</span>
        </h1>
        <p className="text-gray-500 mt-3 text-base leading-relaxed">
          Define your project parameters. Once submitted, the contract will be
          cryptographically locked and made immutable on the Merkle hash chain.
        </p>
      </div>

      <AnimatePresence mode="wait">
        {/* ────────────────── LOCKED / SUCCESS STATE ────────────────── */}
        {isLocked && lockedData ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          >
            <div className="glass rounded-2xl overflow-hidden gradient-border shadow-glow-green">
              {/* Neon green accent bar */}
              <div className="h-1 bg-gradient-to-r from-status-success via-emerald-400 to-cyan-400" />

              <div className="p-8 relative scan-overlay">
                {/* Success icon + title */}
                <div className="flex items-start gap-4 mb-8">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1, rotate: [0, 10, -10, 0] }}
                    transition={{ duration: 0.6, delay: 0.2 }}
                    className="w-14 h-14 rounded-2xl bg-status-success/10 flex items-center justify-center flex-shrink-0 ring-glow-cyan"
                  >
                    <ShieldCheck className="w-7 h-7 text-status-success" />
                  </motion.div>
                  <div>
                    <h2 className="text-xl font-bold text-white">
                      Contract Locked & Immutable
                    </h2>
                    <p className="text-gray-500 text-sm mt-1">
                      This contract is now mathematically locked. No party can
                      alter the terms without breaking the hash chain.
                    </p>
                  </div>
                </div>

                {/* Contract details grid */}
                <div className="grid grid-cols-2 gap-3 mb-6">
                  <DetailCard label="Project" value={lockedData.title} />
                  <DetailCard label="Contract ID" value={lockedData.contractId} mono />
                  <DetailCard
                    label="Budget"
                    value={`$${Number(lockedData.budget).toLocaleString()}`}
                  />
                  <DetailCard label="Deadline" value={lockedData.deadline} />
                </div>

                {/* SHA-256 Hash display */}
                <div className="bg-void-700 rounded-xl p-5 mb-6 border border-status-success/10 relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-r from-status-success/5 to-transparent" />
                  <div className="relative">
                    <div className="flex items-center gap-2 text-gray-500 text-xs font-mono mb-2 tracking-wider">
                      <Fingerprint className="w-3.5 h-3.5 text-status-success" />
                      SHA-256 CONTRACT HASH
                    </div>
                    <p className="font-mono text-sm text-status-success break-all leading-relaxed tracking-wider text-glow-green">
                      {lockedData.hash}
                    </p>
                  </div>
                </div>

                {/* Timestamp */}
                <div className="flex items-center justify-between text-xs text-gray-600 mb-8">
                  <span className="font-mono">
                    Locked at{' '}
                    {new Date(lockedData.timestamp).toLocaleString()}
                  </span>
                  <span className="flex items-center gap-1.5 text-gray-500">
                    <Lock className="w-3 h-3" />
                    Immutable Record
                  </span>
                </div>

                {/* Proceed button */}
                <button
                  id="btn-proceed-phase2"
                  onClick={onProceedToPhase2}
                  className="w-full py-4 btn-futuristic text-white font-semibold rounded-xl
                             flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
                >
                  <span className="flex items-center gap-2">
                    Proceed to Zero-Trust Verification
                    <ArrowRight className="w-4 h-4" />
                  </span>
                </button>
              </div>
            </div>
          </motion.div>
        ) : (
          /* ────────────────── FORM / LOADING STATE ────────────────── */
          <motion.div
            key="form"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.4 }}
          >
            <form
              id="contract-form"
              onSubmit={handleSubmit}
              className="glass rounded-2xl overflow-hidden gradient-border shadow-glass"
            >
              {/* Gradient accent bar */}
              <div className="h-1 bg-gradient-to-r from-cyber-400 via-neon-500 to-cyber-400" />

              <div className="p-8 space-y-6">
                {/* Project Title */}
                <div className="group">
                  <label
                    htmlFor="input-title"
                    className="block text-sm font-semibold text-gray-300 mb-2.5 group-focus-within:text-cyber-400 transition-colors"
                  >
                    Project Title
                  </label>
                  <div className="relative">
                    <FileText className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600 group-focus-within:text-cyber-500 transition-colors" />
                    <input
                      id="input-title"
                      name="title"
                      type="text"
                      value={formData.title}
                      onChange={handleChange}
                      disabled={isProcessing}
                      placeholder="e.g. AI-Powered Portfolio Builder"
                      className="w-full pl-12 pr-4 py-3.5 bg-void-400/60 border border-white/8 rounded-xl
                                 text-white placeholder:text-gray-600 text-sm
                                 focus:ring-2 focus:ring-cyber-500/30 focus:border-cyber-500/50 transition-all duration-300
                                 disabled:opacity-40 disabled:cursor-not-allowed
                                 hover:border-white/15"
                    />
                  </div>
                </div>

                {/* Detailed Requirements */}
                <div className="group">
                  <label
                    htmlFor="input-requirements"
                    className="block text-sm font-semibold text-gray-300 mb-2.5 group-focus-within:text-cyber-400 transition-colors"
                  >
                    Detailed Requirements
                  </label>
                  <textarea
                    id="input-requirements"
                    name="requirements"
                    rows={5}
                    value={formData.requirements}
                    onChange={handleChange}
                    disabled={isProcessing}
                    placeholder="Describe the project scope, features, acceptance criteria, and any technical constraints..."
                    className="w-full px-4 py-3.5 bg-void-400/60 border border-white/8 rounded-xl
                               text-white placeholder:text-gray-600 text-sm resize-none
                               focus:ring-2 focus:ring-cyber-500/30 focus:border-cyber-500/50 transition-all duration-300
                               disabled:opacity-40 disabled:cursor-not-allowed
                               hover:border-white/15"
                  />
                </div>

                {/* Budget + Deadline row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  {/* Budget */}
                  <div className="group">
                    <label
                      htmlFor="input-budget"
                      className="block text-sm font-semibold text-gray-300 mb-2.5 group-focus-within:text-cyber-400 transition-colors"
                    >
                      Budget (USD)
                    </label>
                    <div className="relative">
                      <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600 group-focus-within:text-cyber-500 transition-colors" />
                      <input
                        id="input-budget"
                        name="budget"
                        type="number"
                        min="1"
                        value={formData.budget}
                        onChange={handleChange}
                        disabled={isProcessing}
                        placeholder="5000"
                        className="w-full pl-12 pr-4 py-3.5 bg-void-400/60 border border-white/8 rounded-xl
                                   text-white placeholder:text-gray-600 text-sm
                                   focus:ring-2 focus:ring-cyber-500/30 focus:border-cyber-500/50 transition-all duration-300
                                   disabled:opacity-40 disabled:cursor-not-allowed
                                   hover:border-white/15"
                      />
                    </div>
                  </div>

                  {/* Deadline */}
                  <div className="group">
                    <label
                      htmlFor="input-deadline"
                      className="block text-sm font-semibold text-gray-300 mb-2.5 group-focus-within:text-cyber-400 transition-colors"
                    >
                      Deadline
                    </label>
                    <div className="relative">
                      <Calendar className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600 group-focus-within:text-cyber-500 transition-colors" />
                      <input
                        id="input-deadline"
                        name="deadline"
                        type="date"
                        value={formData.deadline}
                        onChange={handleChange}
                        disabled={isProcessing}
                        className="w-full pl-12 pr-4 py-3.5 bg-void-400/60 border border-white/8 rounded-xl
                                   text-white placeholder:text-gray-600 text-sm
                                   focus:ring-2 focus:ring-cyber-500/30 focus:border-cyber-500/50 transition-all duration-300
                                   disabled:opacity-40 disabled:cursor-not-allowed
                                   hover:border-white/15 [color-scheme:dark]"
                      />
                    </div>
                  </div>
                </div>

                {/* ── Loading sequence terminal ───────────────── */}
                <AnimatePresence>
                  {isProcessing && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="bg-void-700 rounded-xl p-5 space-y-3 border border-cyber-800/30 relative overflow-hidden">
                        {/* Scan line overlay */}
                        <div className="absolute inset-0 scan-overlay pointer-events-none" />

                        <div className="flex items-center gap-2 text-xs font-mono text-cyber-500 mb-3 tracking-widest relative">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          INITIALIZING ZERO-TRUST CONTRACT
                        </div>

                        {LOADING_STEPS.map((step) => {
                          const isActive = currentStep === step.id;
                          const isComplete = completedSteps.includes(step.id);

                          return (
                            <motion.div
                              key={step.id}
                              initial={{ opacity: 0, x: -10 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ delay: (step.id - 1) * 0.15 }}
                              className="relative"
                            >
                              <div className="flex items-center gap-3">
                                {/* Step indicator */}
                                {isComplete ? (
                                  <CheckCircle2 className="w-4 h-4 text-status-success flex-shrink-0" />
                                ) : isActive ? (
                                  <Loader2 className="w-4 h-4 text-cyber-400 animate-spin flex-shrink-0" />
                                ) : (
                                  <div className="w-4 h-4 rounded-full border border-gray-700 flex-shrink-0" />
                                )}

                                {/* Step text */}
                                <div className="flex flex-col">
                                  <span
                                    className={`font-mono text-sm transition-colors duration-300 ${
                                      isComplete
                                        ? 'text-status-success text-glow-green'
                                        : isActive
                                          ? 'text-cyber-300 cursor-blink text-glow-cyan'
                                          : 'text-gray-700'
                                    }`}
                                  >
                                    {step.id}. {step.text}
                                  </span>
                                  {isActive && (
                                    <motion.span
                                      initial={{ opacity: 0 }}
                                      animate={{ opacity: 1 }}
                                      className="font-mono text-[10px] text-gray-600 mt-0.5 ml-0.5"
                                    >
                                      → {step.detail}
                                    </motion.span>
                                  )}
                                </div>
                              </div>
                            </motion.div>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Submit button */}
                <button
                  id="btn-initialize-contract"
                  type="submit"
                  disabled={!isFormValid || isProcessing}
                  className={`w-full py-4 rounded-xl font-semibold text-sm flex items-center justify-center gap-2
                             transition-all duration-300 active:scale-[0.98]
                             ${
                               isProcessing
                                 ? 'bg-void-400 text-gray-500 cursor-wait border border-white/5'
                                 : isFormValid
                                   ? 'btn-futuristic text-white'
                                   : 'bg-void-400 text-gray-600 cursor-not-allowed border border-white/5'
                             }`}
                >
                  {isProcessing ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Processing Contract...
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Lock className="w-4 h-4" />
                      Initialize Zero-Trust Contract
                    </span>
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

// ── Helper: small detail card used in the success state ──────
function DetailCard({ label, value, mono = false }) {
  return (
    <div className="bg-void-400/40 rounded-xl px-4 py-3 border border-white/5 hover:border-cyber-700/30 transition-colors">
      <p className="text-[10px] text-gray-600 font-mono tracking-wider mb-1">{label.toUpperCase()}</p>
      <p
        className={`text-sm font-semibold text-gray-200 truncate ${
          mono ? 'font-mono text-cyber-300' : ''
        }`}
      >
        {value}
      </p>
    </div>
  );
}

export default ContractInitialization;
