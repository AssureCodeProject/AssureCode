import React from 'react';
import { useApp } from '../../context/AppContext';
import { Modal } from '../common/Modal';
import { 
  Sparkles, 
  ArrowRight, 
  ArrowLeft, 
  ShieldCheck, 
  Cpu, 
  MessageSquareCode, 
  Coins, 
  Database, 
  CheckCircle2, 
  X,
  Play
} from 'lucide-react';
import { Badge } from '../common/Badge';

export function GuidedDemoTour() {
  const { guidedTourStep, setGuidedTourStep, setActiveTab, setRole } = useApp();

  if (guidedTourStep === null) return null;

  const tourSteps = [
    {
      stepNumber: 1,
      title: 'Welcome to AssureCode Zero-Trust Ecosystem',
      subtitle: 'Replacing Subjective Ratings with Cryptographic Guarantees',
      icon: ShieldCheck,
      color: 'text-indigo-400',
      description: 'Traditional platforms rely on opaque reviews and unverified code delivery. AssureCode guarantees delivery through tamper-evident Merkle ledgers, ephemeral sandboxes, AST code analysis, RAG scope guards, and deterministic escrow release.',
      actionLabel: 'Explore Objective 1: Contract Initialization',
      targetTab: 'OVERVIEW',
      targetRole: 'CLIENT'
    },
    {
      stepNumber: 2,
      title: 'Objective 1: Contract & Ledger Initialization',
      subtitle: 'Sentence-BERT Talent Matching & RFC 6962 Merkle Tree',
      icon: Sparkles,
      color: 'text-purple-400',
      description: 'Project requirements are embedded into vector space with Sentence-BERT to rank talent. Cloudflare Workers AI synthesizes hidden test suites, and requirements are canonicalized (RFC 8785) and pinned to the PostgreSQL ledger.',
      actionLabel: 'Explore Objective 2: Zero-Trust CI Sandbox',
      targetTab: 'NEW_CONTRACT',
      targetRole: 'CLIENT'
    },
    {
      stepNumber: 3,
      title: 'Objective 2: Zero-Trust CI Verification',
      subtitle: 'Ephemeral Docker Sandboxes, AST Metrics & OWASP 2025 Auditing',
      icon: Cpu,
      color: 'text-cyan-400',
      description: 'When a freelancer pushes code, an ephemeral Docker sandbox runs without network access. Abstract Syntax Tree parsers measure McCabe cyclomatic complexity (< 10) and SEI Maintainability (≥ 85), followed by dual-layer static + LLM security auditing.',
      actionLabel: 'Explore Objective 3: Scope Guard Chat',
      targetTab: 'CI_SANDBOX',
      targetRole: 'FREELANCER'
    },
    {
      stepNumber: 4,
      title: 'Objective 3: Autonomous Scope Mediation',
      subtitle: 'Genesis Ledger Anchoring & pgvector Cosine Threshold (0.2731)',
      icon: MessageSquareCode,
      color: 'text-indigo-400',
      description: 'Every client and freelancer chat message is anchored to the Genesis Ledger Hash. pgvector retrieves top-5 contract chunks. If cosine similarity is ≥ 0.2731, the message is verified; otherwise, it is blocked as scope creep and triggers an amendment proposal.',
      actionLabel: 'Explore Objective 4: Trust Score & Settlement',
      targetTab: 'SCOPE_CHAT',
      targetRole: 'CLIENT'
    },
    {
      stepNumber: 5,
      title: 'Objective 4: Deterministic Trust Score & Escrow Settlement',
      subtitle: 'Interpretable Linear Model & Single-Fire Settlement Race Protection',
      icon: Coins,
      color: 'text-emerald-400',
      description: 'A deterministic 0–100 Trust Score is computed from Tests (35%), AST (25%), Security (25%), and Scope (15%). When the score is ≥ 85 with 0 critical findings, the Settlement Oracle single-fire captures held Stripe escrow and finalizes the ledger.',
      actionLabel: 'View Final Ledger & Merkle Explorer',
      targetTab: 'SETTLEMENT',
      targetRole: 'CLIENT'
    },
    {
      stepNumber: 6,
      title: 'Tour Completed: Ready to Explore AssureCode!',
      subtitle: 'Switch Roles, Run Live Sandboxes, and Verify Merkle Proofs',
      icon: CheckCircle2,
      color: 'text-emerald-400',
      description: 'You are now ready to interact with all AssureCode modules. Switch between Client, Freelancer, and Auditor roles using the top navigation bar at any time.',
      actionLabel: 'Finish Tour & Explore',
      targetTab: 'LEDGER',
      targetRole: 'AUDITOR'
    }
  ];

  const currentStep = tourSteps[guidedTourStep] || tourSteps[0];
  const Icon = currentStep.icon;

  const handleNext = () => {
    if (guidedTourStep < tourSteps.length - 1) {
      const nextStep = guidedTourStep + 1;
      setGuidedTourStep(nextStep);
      setActiveTab(tourSteps[nextStep].targetTab);
      setRole(tourSteps[nextStep].targetRole);
    } else {
      setGuidedTourStep(null);
    }
  };

  const handlePrev = () => {
    if (guidedTourStep > 0) {
      const prevStep = guidedTourStep - 1;
      setGuidedTourStep(prevStep);
      setActiveTab(tourSteps[prevStep].targetTab);
      setRole(tourSteps[prevStep].targetRole);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in">
      <div className="relative w-full max-w-xl bg-[#0f1422] border border-indigo-500/40 rounded-2xl shadow-2xl overflow-hidden p-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-xl bg-indigo-500/20 border border-indigo-500/30">
              <Icon className={`w-6 h-6 ${currentStep.color}`} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-indigo-400">
                  Step {currentStep.stepNumber} of {tourSteps.length}
                </span>
                <Badge variant="primary" size="xs">AssureCode Tour</Badge>
              </div>
              <h3 className="text-lg font-bold text-white mt-0.5">{currentStep.title}</h3>
            </div>
          </div>

          <button
            onClick={() => setGuidedTourStep(null)}
            className="text-slate-400 hover:text-white p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Subtitle & Description */}
        <div className="space-y-2">
          <div className="text-xs font-semibold text-indigo-300 font-mono">
            {currentStep.subtitle}
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            {currentStep.description}
          </p>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 via-cyan-400 to-emerald-400 transition-all duration-300 rounded-full"
            style={{ width: `${((guidedTourStep + 1) / tourSteps.length) * 100}%` }}
          />
        </div>

        {/* Footer Navigation */}
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={handlePrev}
            disabled={guidedTourStep === 0}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 text-xs font-semibold transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Previous</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setGuidedTourStep(null)}
              className="px-3.5 py-2 rounded-xl text-slate-400 hover:text-slate-200 text-xs font-semibold transition-colors"
            >
              Skip Tour
            </button>
            <button
              onClick={handleNext}
              className="flex items-center gap-2 px-5 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white text-xs font-bold shadow-lg shadow-indigo-500/25 transition-all"
            >
              <span>{currentStep.actionLabel}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
