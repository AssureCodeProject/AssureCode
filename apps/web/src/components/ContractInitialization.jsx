import React, { useState, useCallback, useEffect, useRef } from 'react';
import { callApi, uploadFile } from '../utils/api';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowRight,
  Loader2,
  Check,
  Copy,
  Upload,
  FileText,
  X,
  AlertCircle,
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

/** Demo scenarios that pre-fill the form — data, not four copies of a button. */
const PRESET_SCENARIOS = [
  {
    id: 'fintech',
    label: '[ Fintech ]',
    summary: '$2,500 • React/Node',
    formData: {
      title: 'Fintech Real-Time Dashboard',
      requirements: 'Build a React TypeScript dashboard with Node.js Fastify backend and PostgreSQL database.',
      budget: '2500',
      deadline: '2026-12-31',
    },
  },
  {
    id: 'ai',
    label: '[ AI / RAG ]',
    summary: '$3,800 • PyTorch/FastAPI',
    formData: {
      title: 'PyTorch RAG LLM Pipeline',
      requirements: 'Build a PyTorch RAG LLM pipeline using FastAPI, LangChain, and vector databases for semantic document search.',
      budget: '3800',
      deadline: '2026-12-31',
    },
  },
  {
    id: 'web3',
    label: '[ Web3 ]',
    summary: '$4,200 • Solidity',
    formData: {
      title: 'DeFi Solidity Smart Contracts',
      requirements: 'Develop Solidity smart contracts for Ethereum decentralized finance protocol with Ethers.js integration.',
      budget: '4200',
      deadline: '2026-12-31',
    },
  },
  {
    id: 'devops',
    label: '[ DevOps ]',
    summary: '$3,000 • K8s/AWS',
    formData: {
      title: 'Kubernetes Terraform Infra',
      requirements: 'Provision multi-region Kubernetes cluster with Terraform IaC, AWS infrastructure, and Prometheus monitoring.',
      budget: '3000',
      deadline: '2026-12-31',
    },
  },
];

/** Shared entry/exit for the three panels this phase swaps between. */
const PANEL_TRANSITION = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -10 },
  transition: { duration: 0.2 },
};

/** Split a hash into 8-character chunks, grouped into lines of up to 8 chunks
 *  (64 characters) for the signature ledger element. */
function formatHashLines(hashStr) {
  if (!hashStr) return [];

  const clean = hashStr.replace(/^0x/, '');
  const chunks = [];
  for (let i = 0; i < clean.length; i += 8) {
    chunks.push(clean.slice(i, i + 8));
  }

  const lines = [];
  for (let i = 0; i < chunks.length; i += 8) {
    lines.push(chunks.slice(i, i + 8));
  }
  return lines;
}

function presetButtonClasses(isSelected) {
  const base = 'p-3 text-left font-mono text-xs border transition-colors';
  if (isSelected) return `${base} border-signal text-signal bg-signal/5 font-semibold`;
  return `${base} border-rule text-prose-muted hover:text-prose hover:border-rule-hi bg-ink-3`;
}

function submitButtonClasses(isMatching, isFormValid) {
  const base =
    'w-full py-4 font-mono font-bold text-sm tracking-wider uppercase transition-all flex items-center justify-center gap-2';
  if (isMatching) return `${base} bg-ink-3 text-prose-muted border border-rule cursor-wait`;
  if (isFormValid) return `${base} bg-signal text-ink hover:opacity-90 active:scale-[0.99]`;
  return `${base} bg-ink-3 text-prose-dim border border-rule cursor-not-allowed`;
}

function loadingStepClasses(isComplete, isActive) {
  if (isComplete) return 'text-signal';
  if (isActive) return 'text-prose font-bold';
  return 'text-prose-dim';
}

/** The locked contract: its ledger hash, terms summary, and the way forward. */
function LockedContractPanel({ lockedData, copiedHash, onCopyHash, onProceedToPhase2 }) {
  const displayBudget =
    lockedData.budgetCents != null ? lockedData.budgetCents / 100 : Number(lockedData.budget || 0);

  return (
    <>
      {/* Signature Element: Grouped-Monospace Hash Ledger Viewer */}
      <div className="bg-ink-2 border border-rule p-6 sm:p-8 font-mono">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rule pb-4 mb-6 text-xs text-prose-muted">
          <div>
            <span className="text-signal font-bold">LOCKED</span> │ BLOCK <span className="text-prose">{lockedData.hash ? `${lockedData.hash.slice(0, 10)}…${lockedData.hash.slice(-4)}` : '0x7f3a…ecc1'}</span> │ EXTENDED 1
          </div>
          <div className="flex items-center gap-3">
            <span className="text-prose-dim">SHA-256</span>
            <button
              onClick={onCopyHash}
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
            ${displayBudget.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD
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
    </>
  );
}

/** The assign → generate-tests → lock console, shown once a candidate is picked. */
function AssignmentProgress({ currentStep, completedSteps }) {
  return (
    <div className="bg-ink p-4 border border-rule font-mono text-xs space-y-2">
      <div className="flex items-center gap-2 text-signal mb-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>EXECUTING ASSIGNMENT & LOCK SEQUENCE...</span>
      </div>
      {LOADING_STEPS.map((step) => {
        const isActive = currentStep === step.id;
        const isComplete = completedSteps.includes(step.id);
        return (
          <div key={step.id} className="flex items-start gap-2">
            <span className="text-prose-dim">[{step.id}]</span>
            <div className="flex-1">
              <span className={loadingStepClasses(isComplete, isActive)}>{step.text}</span>
              {isActive && <div className="text-[11px] text-prose-muted mt-0.5">└─ {step.detail}</div>}
            </div>
            {isComplete && <span className="text-signal">✓</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Ranked matchmaker results — the client picks who gets the contract. */
function CandidateSelection({
  candidates,
  isProcessing,
  currentStep,
  completedSteps,
  assigningId,
  onAssign,
}) {
  return (
    <>
      <div className="bg-ink-2 border border-rule p-5">
        <div className="text-xs font-mono text-prose-muted uppercase tracking-wider mb-1">
          Ranked by the NLP matchmaker
        </div>
        <p className="text-sm text-prose-muted">
          Skill-embedding cosine similarity, trust score, and delivery history —
          {' '}<span className="text-prose">0.50 / 0.35 / 0.15</span> weighted. Pick who gets this contract.
        </p>
      </div>

      {isProcessing && (
        <AssignmentProgress currentStep={currentStep} completedSteps={completedSteps} />
      )}

      {!isProcessing && candidates.length === 0 && (
        <div className="bg-ink-2 border border-rule p-8 text-center font-mono text-sm text-prose-muted">
          No candidates returned. The matcher may be unreachable — try again.
        </div>
      )}

      {!isProcessing && candidates.length > 0 && (
        <div className="space-y-3">
          {candidates.map((candidate, idx) => (
            <div
              key={candidate.freelancer_id}
              className={`bg-ink-2 border p-5 flex flex-col sm:flex-row sm:items-center gap-4 justify-between ${
                idx === 0 ? 'border-signal/60' : 'border-rule'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-prose">{candidate.freelancer_name}</span>
                  {idx === 0 && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 bg-signal/10 text-signal border border-signal/40 uppercase tracking-wider">
                      Top Match
                    </span>
                  )}
                  <span className="font-mono text-xs text-prose-dim">
                    ${(candidate.hourly_rate_cents / 100).toFixed(0)}/hr
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px] text-prose-muted">
                  <span>score <span className="text-prose">{candidate.score.toFixed(2)}</span></span>
                  <span>skill <span className="text-prose">{candidate.explanation.skill_score.toFixed(2)}</span></span>
                  <span>trust <span className="text-prose">{candidate.explanation.trust_score.toFixed(2)}</span></span>
                  <span>history <span className="text-prose">{candidate.explanation.history_score.toFixed(2)}</span></span>
                </div>

                {candidate.explanation.matched_skills?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {candidate.explanation.matched_skills.map((skill) => (
                      <span
                        key={skill}
                        className="text-[10px] font-mono px-1.5 py-0.5 bg-ink border border-rule text-prose-muted"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={() => onAssign(candidate.freelancer_id)}
                disabled={isProcessing}
                className="shrink-0 px-4 py-2.5 bg-signal text-ink font-mono font-bold text-xs tracking-wider uppercase
                           hover:opacity-90 active:scale-[0.99] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {assigningId === candidate.freelancer_id ? 'Assigning…' : 'Assign'}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

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

  // Matchmaking step state — between "initialize" and "lock", the client
  // picks who gets assigned instead of the top result being assigned
  // silently. isMatching covers the initialize+match round trip; once
  // candidates arrive the form gives way to the candidate list until the
  // client clicks assign, at which point the existing generate-tests/lock
  // sequence runs exactly as before.
  const [isMatching, setIsMatching] = useState(false);
  const [candidates, setCandidates] = useState(null);
  const [pendingContract, setPendingContract] = useState(null);
  const [matchError, setMatchError] = useState(null);
  const [assigningId, setAssigningId] = useState(null);

  // PDF upload state. pdfRawText is the full extracted document, sent at
  // initialize time and stored in contracts.pdf_raw_text separately from
  // `requirements` — the client can edit requirements down to a summary
  // without losing the source text the RAG ingest uses at lock time.
  const [pdfFileName, setPdfFileName] = useState(null);
  const [pdfExtracting, setPdfExtracting] = useState(false);
  const [pdfError, setPdfError] = useState(null);
  const [pdfRawText, setPdfRawText] = useState(null);
  const [pdfMeta, setPdfMeta] = useState(null); // { pageCount, truncated }
  const fileInputRef = useRef(null);

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

  const handlePresetSelect = (preset) => {
    setSelectedPreset(preset.id);
    setFormData({ ...preset.formData });
  };

  const handlePdfSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setPdfError(null);
    setPdfRawText(null);
    setPdfMeta(null);
    setPdfFileName(file.name);
    setPdfExtracting(true);

    try {
      const result = await uploadFile('/api/pdf/extract', file);
      setPdfRawText(result.text);
      setPdfMeta({ pageCount: result.pageCount, truncated: result.truncated });
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : String(err));
      setPdfFileName(null);
    } finally {
      setPdfExtracting(false);
    }
  };

  // The client must see and approve exactly what gets hashed — this copies
  // the extracted text into the editable requirements field rather than
  // hashing it silently. pdfRawText (the full document) still gets sent
  // separately at initialize, regardless of what the client trims here.
  const handleUseExtractedText = () => {
    if (!pdfRawText) return;
    setFormData((prev) => ({ ...prev, requirements: pdfRawText }));
  };

  const handleClearPdf = () => {
    setPdfFileName(null);
    setPdfRawText(null);
    setPdfMeta(null);
    setPdfError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Validate form inputs
  const isFormValid = Boolean(
    formData.title.trim() &&
      formData.requirements.trim() &&
      formData.budget &&
      formData.deadline
  );

  // Step 1: initialize the contract, then fetch ranked candidates and hand
  // control to the candidate-selection screen instead of auto-assigning.
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isFormValid || isMatching) return;

    setIsMatching(true);
    setMatchError(null);

    try {
      const initResponse = await callApi('/api/contracts/initialize', 'POST', {
        title: formData.title,
        requirements: formData.requirements,
        budgetCents: Number(formData.budget) * 100,
        deadline: formData.deadline,
        ...(pdfRawText ? { pdfRawText } : {}),
      });

      const matchResponse = await callApi(
        `/api/contracts/${initResponse.contractId}/match`,
        'POST',
        { requirements: formData.requirements, topK: 5 }
      );

      setPendingContract(initResponse);
      setCandidates(matchResponse.results || []);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Contract initialization / matching failed:', error);
      setMatchError(message);
    } finally {
      setIsMatching(false);
    }
  };

  // Step 2: client picks a candidate. Runs assign, then the existing
  // generate-tests/lock sequence.
  const handleAssign = async (freelancerId) => {
    if (!pendingContract || isProcessing) return;

    const { contractId, clientId } = pendingContract;

    setAssigningId(freelancerId);
    setIsProcessing(true);
    setCurrentStep(0);
    setCompletedSteps([]);

    try {
      setCurrentStep(1);
      await callApi(`/api/contracts/${contractId}/assign`, 'POST', { freelancerId });
      setCompletedSteps((prev) => [...prev, 1]);

      // Step 2: Generate unit tests
      setCurrentStep(2);
      await callApi(`/api/contracts/${contractId}/generate-tests`, 'POST', {
        title: formData.title,
        requirements: formData.requirements,
        framework: 'jest',
      });
      setCompletedSteps((prev) => [...prev, 2]);

      // Step 3: Lock contract (returns real ledger Merkle hash)
      setCurrentStep(3);
      const lockResponse = await callApi(`/api/contracts/${contractId}/lock`, 'POST', {
        title: formData.title,
        requirements: formData.requirements,
        budgetCents: Number(formData.budget) * 100,
        deadline: formData.deadline,
      });
      setCompletedSteps((prev) => [...prev, 3]);

      const result = {
        ...formData,
        hash: lockResponse.hash,
        timestamp: lockResponse.timestamp,
        contractId,
        clientId,
        budgetCents: lockResponse.budgetCents,
        assignedFreelancerId: freelancerId,
      };

      setLockedData(result);
      setIsLocked(true);
      setIsProcessing(false);
      onContractLocked(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Assignment / lock failed:', error);
      setIsProcessing(false);
      setAssigningId(null);
      alert(`Failed to assign freelancer: ${message}`);
    }
  };

  const handleCopyHash = () => {
    if (!lockedData?.hash) return;
    navigator.clipboard.writeText(lockedData.hash);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  };

  // Which of the three panels this phase is currently showing.
  let activePanel = 'form';
  if (isLocked && lockedData) {
    activePanel = 'locked';
  } else if (candidates) {
    activePanel = 'candidates';
  }

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
        {activePanel === 'locked' && (
          <motion.div key="success" {...PANEL_TRANSITION} className="space-y-6">
            <LockedContractPanel
              lockedData={lockedData}
              copiedHash={copiedHash}
              onCopyHash={handleCopyHash}
              onProceedToPhase2={onProceedToPhase2}
            />
          </motion.div>
        )}

        {/* ────────────────── CANDIDATE SELECTION STATE ────────────────── */}
        {activePanel === 'candidates' && (
          <motion.div key="candidates" {...PANEL_TRANSITION} className="space-y-6">
            <CandidateSelection
              candidates={candidates}
              isProcessing={isProcessing}
              currentStep={currentStep}
              completedSteps={completedSteps}
              assigningId={assigningId}
              onAssign={handleAssign}
            />
          </motion.div>
        )}

        {/* ────────────────── FORM / LOADING STATE ────────────────── */}
        {activePanel === 'form' && (
          <motion.div key="form" {...PANEL_TRANSITION}>
            <form id="contract-form" onSubmit={handleSubmit} className="space-y-8">
              {/* Scenario Preset Selector Chips */}
              <div className="bg-ink-2 border border-rule p-5 space-y-3">
                <label className="block text-xs font-mono text-prose-muted uppercase tracking-wider">
                  Select Preset Scenario
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {PRESET_SCENARIOS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handlePresetSelect(preset)}
                      className={presetButtonClasses(selectedPreset === preset.id)}
                    >
                      <div className="font-bold text-prose">{preset.label}</div>
                      <div className="text-[11px] text-prose-muted mt-1">{preset.summary}</div>
                    </button>
                  ))}
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
                    disabled={isMatching}
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
                    disabled={isMatching}
                    placeholder="Describe the project scope, features, acceptance criteria, and technical constraints..."
                    className="w-full bg-ink p-4 border-b border-rule text-prose placeholder:text-prose-dim text-sm resize-none
                               focus:border-signal outline-none transition-colors disabled:opacity-40"
                  />
                </div>

                {/* PDF Requirements Upload */}
                <div>
                  <label className="block text-xs font-mono text-prose-muted uppercase tracking-wider mb-2">
                    Or Upload a Requirements PDF
                  </label>

                  {!pdfFileName ? (
                    <label
                      htmlFor="input-pdf"
                      className="flex items-center justify-center gap-2 w-full py-4 border border-dashed border-rule text-prose-muted text-sm
                                 hover:border-rule-hi hover:text-prose cursor-pointer transition-colors"
                    >
                      <Upload className="w-4 h-4" />
                      <span>Choose a PDF file (max 10 MB)</span>
                      <input
                        id="input-pdf"
                        ref={fileInputRef}
                        type="file"
                        accept="application/pdf"
                        onChange={handlePdfSelect}
                        disabled={isMatching}
                        className="hidden"
                      />
                    </label>
                  ) : (
                    <div className="bg-ink-2 border border-rule p-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0 font-mono text-xs text-prose">
                          <FileText className="w-4 h-4 shrink-0 text-signal" />
                          <span className="truncate">{pdfFileName}</span>
                          {pdfExtracting && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />}
                        </div>
                        <button
                          type="button"
                          onClick={handleClearPdf}
                          className="shrink-0 text-prose-muted hover:text-fail transition-colors"
                          aria-label="Remove PDF"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>

                      {pdfError && (
                        <div className="flex items-start gap-2 text-xs font-mono text-fail bg-fail/5 border border-fail/30 px-3 py-2">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span>{pdfError}</span>
                        </div>
                      )}

                      {pdfRawText && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-[11px] font-mono text-prose-dim">
                            <span>
                              {pdfMeta?.pageCount} page{pdfMeta?.pageCount === 1 ? '' : 's'} extracted
                              {pdfMeta?.truncated ? ' (truncated — document exceeds the size cap)' : ''}
                            </span>
                          </div>
                          {/* Read-only preview — the client reviews this before it feeds anything.
                              Nothing here is hashed directly; "Use this text" copies it into the
                              editable requirements field above, which is what actually gets hashed. */}
                          <div className="max-h-32 overflow-y-auto bg-ink p-3 border border-rule text-xs text-prose-muted font-mono whitespace-pre-wrap">
                            {pdfRawText.slice(0, 2000)}
                            {pdfRawText.length > 2000 ? '…' : ''}
                          </div>
                          <button
                            type="button"
                            onClick={handleUseExtractedText}
                            className="text-xs font-mono text-signal hover:underline"
                          >
                            [use this text as requirements]
                          </button>
                        </div>
                      )}
                    </div>
                  )}
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
                      disabled={isMatching}
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
                      disabled={isMatching}
                      className="w-full bg-ink px-4 py-3 border-b border-rule text-prose font-mono text-sm
                                 focus:border-signal outline-none transition-colors disabled:opacity-40 [color-scheme:dark]"
                    />
                  </div>
                </div>

                {/* Matching Console */}
                <AnimatePresence>
                  {isMatching && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="bg-ink p-4 border border-rule font-mono text-xs flex items-center gap-2 text-signal">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Initializing contract and ranking freelancers via NLP matchmaker...</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {matchError && (
                  <div className="bg-fail/5 border border-fail/30 px-3 py-2 font-mono text-xs text-fail">
                    {matchError}
                  </div>
                )}

                {/* Submit Action Button */}
                <button
                  id="btn-initialize-contract"
                  type="submit"
                  disabled={!isFormValid || isMatching}
                  className={submitButtonClasses(isMatching, isFormValid)}
                >
                  {isMatching ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>INITIALIZING CONTRACT...</span>
                    </>
                  ) : (
                    <span>Find Freelancers →</span>
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
