import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  Box,
  Code,
  Shield,
  ArrowLeft,
  GitBranch,
  Fingerprint,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  XCircle,
  BarChart3,
  FlaskConical,
  Bug,
  Zap,
  Clock,
  Terminal,
  Hexagon,
  Radio,
  Cpu,
} from 'lucide-react';

/**
 * PIPELINE_STEPS — The CI/CD verification stages shown in the vertical stepper.
 * Each step maps to a backend microservice in production.
 */
const PIPELINE_STEPS = [
  {
    id: 1,
    label: 'Kafka Event Intercepted',
    description: 'Push event received from GitHub webhook and routed via Kafka topic.',
    icon: Activity,
    duration: 1800,
  },
  {
    id: 2,
    label: 'Ephemeral Docker Sandbox Provisioned',
    description: 'Isolated container spun up with project dependencies and test harness.',
    icon: Box,
    duration: 2200,
  },
  {
    id: 3,
    label: 'AST Cyclomatic Complexity Parsing',
    description: 'Abstract Syntax Tree analysis computing code complexity metrics.',
    icon: Code,
    duration: 2500,
  },
  {
    id: 4,
    label: 'AI Security Auditor (OWASP Scan)',
    description: 'Deep-scan for OWASP Top-10 vulnerabilities using AI-driven static analysis.',
    icon: Shield,
    duration: 2800,
  },
];

/**
 * generateMockResults — Produces randomized but realistic telemetry results.
 *
 * In production these would come from:
 *   GET /api/audits/:id/results
 */
function generateMockResults() {
  const maintainability = Math.floor(Math.random() * 25) + 72; // 72–96
  const totalTests = 5;
  const passedTests = Math.random() > 0.3 ? totalTests : Math.floor(Math.random() * 2) + 3;
  const vulnerabilities = Math.random() > 0.7 ? Math.floor(Math.random() * 3) + 1 : 0;

  const passed = passedTests === totalTests && vulnerabilities === 0;

  return {
    maintainability,
    passedTests,
    totalTests,
    vulnerabilities,
    passed,
    scanDuration: (Math.random() * 3 + 4).toFixed(1),
  };
}

/**
 * VerificationDashboard (Phase 2)
 *
 * Renders the Freelancer CI/CD Terminal. A vertical pipeline stepper activates
 * step-by-step when the user clicks "Simulate GitHub Push". After the pipeline
 * completes, a results telemetry dashboard fades in with metric cards and a
 * final pass/fail audit badge.
 *
 * Props:
 *   contractData  — the locked contract from Phase 1
 *   onBack()      — navigate back to Phase 1
 */
function VerificationDashboard({ contractData, onBack }) {
  // ── Pipeline state ──────────────────────────────────────
  const [isRunning, setIsRunning] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState([]);
  const [pipelineComplete, setPipelineComplete] = useState(false);
  const [results, setResults] = useState(null);

  /**
   * runPipeline — Steps through the CI/CD stages one by one.
   *
   * In production this would listen to a WebSocket/SSE stream:
   *   ws://api.assurecode.dev/audits/:id/stream
   */
  const runPipeline = useCallback(async () => {
    setIsRunning(true);
    setActiveStep(0);
    setCompletedSteps([]);
    setPipelineComplete(false);
    setResults(null);

    for (let i = 0; i < PIPELINE_STEPS.length; i++) {
      setActiveStep(i + 1);
      await new Promise((r) => setTimeout(r, PIPELINE_STEPS[i].duration));
      setCompletedSteps((prev) => [...prev, i + 1]);
    }

    await new Promise((r) => setTimeout(r, 800));
    setResults(generateMockResults());
    setPipelineComplete(true);
    setIsRunning(false);
  }, []);

  // ── Render ──────────────────────────────────────────────
  return (
    <div className="max-w-4xl mx-auto">
      {/* Section Header */}
      <div className="mb-10">
        <button
          id="btn-back-phase1"
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-cyber-400 transition-colors mb-4 group"
        >
          <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-1 transition-transform" />
          Back to Contract
        </button>

        <div className="flex items-center gap-2 text-sm font-mono text-cyber-400 mb-3 tracking-wider">
          <Hexagon className="w-4 h-4" />
          PHASE 02
        </div>
        <h1 className="text-4xl font-bold text-white tracking-tight">
          Zero-Trust <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyber-400 to-neon-400">CI/CD Verification</span>
        </h1>
        <p className="text-gray-500 mt-3 text-base">
          Real-time audit pipeline for incoming code pushes.
        </p>
      </div>

      {/* ── Contract Info Header Card ──────────────────────── */}
      <div className="glass rounded-2xl p-6 mb-6 gradient-border shadow-glass relative overflow-hidden">
        {/* Subtle animated background */}
        <div className="absolute inset-0 bg-gradient-to-r from-cyber-900/20 via-transparent to-neon-900/20 opacity-50" />

        <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-8 h-8 rounded-lg bg-cyber-400/10 flex items-center justify-center">
                <Cpu className="w-4 h-4 text-cyber-400" />
              </div>
              <h2 className="text-lg font-bold text-white truncate">
                {contractData?.title || 'Untitled Project'}
              </h2>
            </div>
            <div className="flex items-center gap-2 ml-11">
              <Fingerprint className="w-3.5 h-3.5 text-gray-600 flex-shrink-0" />
              <span className="font-mono text-xs text-gray-500 truncate">
                {contractData?.hash || '—'}
              </span>
            </div>
          </div>

          <button
            id="btn-simulate-push"
            onClick={runPipeline}
            disabled={isRunning}
            className={`flex items-center gap-2 px-6 py-3.5 rounded-xl font-semibold text-sm transition-all duration-300
                       active:scale-[0.97] flex-shrink-0
                       ${
                         isRunning
                           ? 'bg-void-400 text-gray-500 cursor-wait border border-white/5'
                           : 'btn-futuristic text-white'
                       }`}
          >
            {isRunning ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Pipeline Running...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <GitBranch className="w-4 h-4" />
                Simulate GitHub Push
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ── Live Pipeline Stepper ──────────────────────────── */}
      <div className="glass rounded-2xl p-6 mb-6 shadow-glass relative overflow-hidden">
        {/* Scan line when running */}
        {isRunning && <div className="absolute inset-0 scan-overlay pointer-events-none" />}

        <div className="flex items-center gap-2 text-xs font-mono text-cyber-500 uppercase tracking-widest mb-6 relative">
          <Radio className={`w-3.5 h-3.5 ${isRunning ? 'animate-pulse text-status-success' : ''}`} />
          Live Pipeline
          {isRunning && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
              className="ml-2 text-status-success"
            >
              ● STREAMING
            </motion.span>
          )}
        </div>

        <div className="space-y-0 relative">
          {PIPELINE_STEPS.map((step, idx) => {
            const StepIcon = step.icon;
            const isActive = activeStep === step.id;
            const isComplete = completedSteps.includes(step.id);
            const isLast = idx === PIPELINE_STEPS.length - 1;

            return (
              <div key={step.id} className="flex gap-4">
                {/* Vertical line + icon column */}
                <div className="flex flex-col items-center">
                  {/* Step circle */}
                  <motion.div
                    animate={
                      isActive
                        ? { scale: [1, 1.1, 1], transition: { repeat: Infinity, duration: 1.5 } }
                        : { scale: 1 }
                    }
                    className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-500
                               ${
                                 isComplete
                                   ? 'bg-status-success/10 border border-status-success/20 shadow-glow-green'
                                   : isActive
                                     ? 'bg-cyber-400/10 border border-cyber-400/30 ring-glow-cyan shadow-glow-cyan'
                                     : 'bg-void-400/50 border border-white/5'
                               }`}
                  >
                    {isComplete ? (
                      <CheckCircle2 className="w-5 h-5 text-status-success" />
                    ) : isActive ? (
                      <StepIcon className="w-5 h-5 text-cyber-400" />
                    ) : (
                      <StepIcon className="w-5 h-5 text-gray-700" />
                    )}
                  </motion.div>

                  {/* Connector line */}
                  {!isLast && (
                    <div className="w-0.5 flex-1 my-1 min-h-[28px] relative">
                      <div className="absolute inset-0 bg-white/5 rounded-full" />
                      {isComplete && (
                        <motion.div
                          initial={{ height: 0 }}
                          animate={{ height: '100%' }}
                          transition={{ duration: 0.4, ease: 'easeOut' }}
                          className="absolute inset-x-0 top-0 bg-gradient-to-b from-status-success to-status-success/50 rounded-full shadow-glow-green"
                        />
                      )}
                      {isActive && (
                        <motion.div
                          initial={{ height: 0 }}
                          animate={{ height: '60%' }}
                          transition={{ duration: 0.3 }}
                          className="absolute inset-x-0 top-0 bg-gradient-to-b from-cyber-400 to-transparent rounded-full"
                        />
                      )}
                    </div>
                  )}
                </div>

                {/* Step content */}
                <div className={`pb-7 pt-2 flex-1 ${isLast ? 'pb-0' : ''}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3
                      className={`text-sm font-semibold transition-colors duration-300 ${
                        isComplete
                          ? 'text-status-success text-glow-green'
                          : isActive
                            ? 'text-white'
                            : 'text-gray-600'
                      }`}
                    >
                      {step.label}
                    </h3>
                    {isActive && (
                      <motion.span
                        initial={{ opacity: 0, x: -5 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="text-[10px] font-mono text-void-700 bg-cyber-400 px-2.5 py-0.5 rounded-full font-bold"
                      >
                        RUNNING
                      </motion.span>
                    )}
                    {isComplete && (
                      <motion.span
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="text-[10px] font-mono text-status-success bg-status-success/10 px-2.5 py-0.5 rounded-full border border-status-success/20"
                      >
                        ✓ DONE
                      </motion.span>
                    )}
                  </div>
                  <p
                    className={`text-xs mt-1 transition-colors duration-300 font-mono ${
                      isActive ? 'text-gray-400' : 'text-gray-700'
                    }`}
                  >
                    {step.description}
                  </p>

                  {/* Active step progress bar */}
                  {isActive && (
                    <motion.div
                      initial={{ opacity: 0, width: 0 }}
                      animate={{ opacity: 1, width: '100%' }}
                      className="mt-3 h-1 bg-void-400 rounded-full overflow-hidden max-w-xs"
                    >
                      <motion.div
                        initial={{ width: '0%' }}
                        animate={{ width: '100%' }}
                        transition={{ duration: PIPELINE_STEPS[idx].duration / 1000, ease: 'linear' }}
                        className="h-full bg-gradient-to-r from-cyber-400 via-neon-400 to-cyber-400 rounded-full shadow-glow-cyan"
                      />
                    </motion.div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Results Telemetry ──────────────────────────────── */}
      <AnimatePresence>
        {pipelineComplete && results && (
          <motion.div
            initial={{ opacity: 0, y: 40, filter: 'blur(10px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: 40 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          >
            {/* Section label */}
            <div className="flex items-center gap-2 text-xs font-mono text-neon-400 uppercase tracking-widest mb-4">
              <BarChart3 className="w-3.5 h-3.5" />
              TELEMETRY RESULTS
            </div>

            {/* Metrics grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
              <MetricCard
                id="metric-maintainability"
                icon={BarChart3}
                label="Maintainability"
                value={results.maintainability}
                suffix="/ 100"
                subtext="Based on AST analysis"
                status={results.maintainability >= 70 ? 'success' : 'warning'}
                delay={0}
              />
              <MetricCard
                id="metric-tests"
                icon={FlaskConical}
                label="Hidden Tests"
                value={`${results.passedTests}/${results.totalTests}`}
                suffix="Passed"
                subtext="Auto-generated from contract"
                status={results.passedTests === results.totalTests ? 'success' : 'danger'}
                delay={0.1}
              />
              <MetricCard
                id="metric-vulnerabilities"
                icon={Bug}
                label="Vulnerabilities"
                value={results.vulnerabilities}
                suffix="Critical"
                subtext="OWASP Top-10 scan"
                status={results.vulnerabilities === 0 ? 'success' : 'danger'}
                delay={0.2}
              />
            </div>

            {/* Scan metadata */}
            <div className="flex items-center gap-5 text-xs text-gray-600 mb-6 px-1 font-mono">
              <span className="flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-gray-600" />
                Scan completed in {results.scanDuration}s
              </span>
              <span className="flex items-center gap-1.5">
                <Shield className="w-3 h-3 text-gray-600" />
                OWASP 2025 ruleset
              </span>
              <span className="flex items-center gap-1.5">
                <Cpu className="w-3 h-3 text-gray-600" />
                GPU-accelerated analysis
              </span>
            </div>

            {/* Final audit badge */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.4, duration: 0.6 }}
            >
              {results.passed ? (
                <div
                  id="audit-result-badge"
                  className="glass rounded-2xl p-10 text-center border border-status-success/20 shadow-glow-green relative overflow-hidden"
                >
                  {/* Glowing background */}
                  <div className="absolute inset-0 bg-gradient-to-br from-status-success/5 via-transparent to-emerald-500/5" />
                  <div className="absolute inset-0 scan-overlay pointer-events-none" />

                  <div className="relative">
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', duration: 0.6, delay: 0.5 }}
                      className="w-20 h-20 mx-auto rounded-2xl bg-status-success/10 flex items-center justify-center mb-5 border border-status-success/20 shadow-glow-green"
                    >
                      <CheckCircle2 className="w-10 h-10 text-status-success" />
                    </motion.div>
                    <h2 className="text-3xl font-bold text-status-success text-glow-green mb-3">
                      Audit Passed
                    </h2>
                    <p className="text-gray-400 text-sm max-w-md mx-auto">
                      Ready for XAI Scoring · All checks passed · No vulnerabilities detected
                    </p>
                    <div className="mt-5 inline-flex items-center gap-2 text-xs font-mono text-void-700 bg-status-success px-5 py-2 rounded-full font-bold tracking-wider">
                      <Zap className="w-3 h-3" />
                      ZERO-TRUST VERIFIED
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  id="audit-result-badge"
                  className="glass rounded-2xl p-10 text-center border border-status-danger/20 shadow-glow-red relative overflow-hidden"
                >
                  {/* Glowing background */}
                  <div className="absolute inset-0 bg-gradient-to-br from-status-danger/5 via-transparent to-orange-500/5" />

                  <div className="relative">
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', duration: 0.6, delay: 0.5 }}
                      className="w-20 h-20 mx-auto rounded-2xl bg-status-danger/10 flex items-center justify-center mb-5 border border-status-danger/20 shadow-glow-red"
                    >
                      <XCircle className="w-10 h-10 text-status-danger" />
                    </motion.div>
                    <h2 className="text-3xl font-bold text-status-danger text-glow-red mb-3">
                      Audit Failed
                    </h2>
                    <p className="text-gray-400 text-sm max-w-md mx-auto">
                      Vulnerabilities Detected · {results.totalTests - results.passedTests} test(s) failed ·{' '}
                      {results.vulnerabilities} critical issue(s) found
                    </p>
                    <div className="mt-5 inline-flex items-center gap-2 text-xs font-mono text-white bg-status-danger px-5 py-2 rounded-full font-bold tracking-wider">
                      <AlertTriangle className="w-3 h-3" />
                      ACTION REQUIRED
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Helper: Metric Card component ────────────────────────────
function MetricCard({ id, icon: Icon, label, value, suffix, subtext, status, delay = 0 }) {
  const colorMap = {
    success: {
      border: 'border-status-success/15',
      iconBg: 'bg-status-success/10',
      iconColor: 'text-status-success',
      valueColor: 'text-status-success text-glow-green',
      shadow: 'hover:shadow-glow-green',
    },
    warning: {
      border: 'border-status-warning/15',
      iconBg: 'bg-status-warning/10',
      iconColor: 'text-status-warning',
      valueColor: 'text-status-warning',
      shadow: 'hover:shadow-glow-yellow',
    },
    danger: {
      border: 'border-status-danger/15',
      iconBg: 'bg-status-danger/10',
      iconColor: 'text-status-danger',
      valueColor: 'text-status-danger text-glow-red',
      shadow: 'hover:shadow-glow-red',
    },
  };

  const c = colorMap[status] || colorMap.success;

  return (
    <motion.div
      id={id}
      initial={{ opacity: 0, y: 25 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay }}
      className={`glass border ${c.border} rounded-2xl p-5 transition-all duration-300 ${c.shadow} hover:scale-[1.02] cursor-default group`}
    >
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-10 h-10 rounded-xl ${c.iconBg} flex items-center justify-center group-hover:scale-110 transition-transform`}>
          <Icon className={`w-5 h-5 ${c.iconColor}`} />
        </div>
        <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">
          {label}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`text-4xl font-bold font-mono ${c.valueColor}`}>{value}</span>
        <span className="text-sm text-gray-600 font-mono">{suffix}</span>
      </div>
      <p className="text-[10px] text-gray-600 mt-2 font-mono tracking-wide">{subtext}</p>
    </motion.div>
  );
}

export default VerificationDashboard;
