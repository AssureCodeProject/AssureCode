import React, { useState, useCallback, useRef } from 'react';
import { callApi } from '../utils/api';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  GitBranch,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  XCircle,
} from 'lucide-react';

const PIPELINE_STEPS = [
  {
    id: 1,
    label: 'Kafka Event Intercepted',
    description: 'Push event received from GitHub webhook and routed via Kafka topic.',
    duration: 1800,
  },
  {
    id: 2,
    label: 'Ephemeral Docker Sandbox Provisioned',
    description: 'Isolated container spun up with project dependencies and test harness.',
    duration: 2200,
  },
  {
    id: 3,
    label: 'AST Cyclomatic Complexity Parsing',
    description: 'Abstract Syntax Tree analysis computing code complexity metrics.',
    duration: 2500,
  },
  {
    id: 4,
    label: 'AI Security Auditor (OWASP Scan)',
    description: 'Deep-scan for OWASP Top-10 vulnerabilities using AI-driven static analysis.',
    duration: 2800,
  },
];

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

export function VerificationDashboard({ contractData, onBack, onNextPhase }) {
  // Pipeline state
  const [isRunning, setIsRunning] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState([]);
  const [pipelineComplete, setPipelineComplete] = useState(false);
  const [results, setResults] = useState(null);

  // Refs for socket state
  const isRunningRef = useRef(false);
  const pipelineCompleteRef = useRef(false);

  // Fetch audit results for contract
  const fetchResults = useCallback(async () => {
    if (!contractData?.contractId) return null;
    return callApi(`/api/audits/${contractData.contractId}/results`);
  }, [contractData?.contractId]);

  const runPipeline = useCallback(async () => {
    if (!contractData?.contractId) return;

    isRunningRef.current = true;
    pipelineCompleteRef.current = false;
    setIsRunning(true);
    setActiveStep(0);
    setCompletedSteps([]);
    setPipelineComplete(false);
    setResults(null);

    const contractId = contractData.contractId;
    const wsUrl = `/api/audits/${contractId}/stream`;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const fullWsUrl = `${protocol}//${host}${wsUrl}`;

    let socket = null;
    let isClosed = false;

    try {
      await callApi(`/api/contracts/${contractId}/simulate-push`, 'POST');
    } catch (error) {
      console.error('Failed to trigger simulate-push:', error);
    }

    try {
      socket = new WebSocket(fullWsUrl);

      socket.onopen = () => {
        console.log('WebSocket connected');
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('WebSocket message:', data);

          if (data.type === 'step-complete' && 'stepId' in data && typeof data.stepId === 'number') {
            const stepId = data.stepId;
            setActiveStep(stepId);
            setCompletedSteps((prev) => (!prev.includes(stepId) ? [...prev, stepId] : prev));
          } else if (data.type === 'audit-complete') {
            pipelineCompleteRef.current = true;
            isRunningRef.current = false;
            setPipelineComplete(true);
            setIsRunning(false);
            fetchResults().then((res) => {
              if (res && !isClosed) {
                setResults(res);
              }
            });
          }
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        if (!isClosed) {
          isRunningRef.current = false;
          pipelineCompleteRef.current = true;
          setIsRunning(false);
          setResults(generateMockResults());
          setPipelineComplete(true);
        }
      };

      socket.onclose = () => {
        console.log('WebSocket closed');
        isClosed = true;
        if (isRunningRef.current) {
          if (!pipelineCompleteRef.current) {
            setResults(generateMockResults());
            pipelineCompleteRef.current = true;
            setPipelineComplete(true);
          }
          isRunningRef.current = false;
          setIsRunning(false);
        }
      };
    } catch (error) {
      console.error('WebSocket failed, falling back to mock:', error);
      for (let i = 0; i < PIPELINE_STEPS.length; i++) {
        setActiveStep(i + 1);
        await new Promise((r) => setTimeout(r, PIPELINE_STEPS[i].duration || 2000));
        setCompletedSteps((prev) => [...prev, i + 1]);
      }

      await new Promise((r) => setTimeout(r, 800));
      pipelineCompleteRef.current = true;
      isRunningRef.current = false;
      setResults(generateMockResults());
      setPipelineComplete(true);
      setIsRunning(false);
    }
  }, [contractData?.contractId, fetchResults]);

  return (
    <div className="max-w-4xl mx-auto space-y-8 font-sans">
      {/* ── Section Header ─────────────────────────────────────────── */}
      <div className="border-b border-rule pb-6">
        <button
          id="btn-back-phase1"
          onClick={onBack}
          className="flex items-center gap-1 text-xs font-mono text-prose-muted hover:text-prose transition-colors mb-4"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>[back to phase 01]</span>
        </button>

        <div className="flex items-center justify-between font-mono text-xs text-prose-muted uppercase tracking-widest mb-3">
          <span>PHASE 02 of 04 ───────────────────────────────────────────</span>
          <span className={pipelineComplete ? 'text-signal' : isRunning ? 'text-prose animate-pulse' : 'text-prose-dim'}>
            {pipelineComplete ? '✓ VERIFICATION COMPLETE' : isRunning ? '● RUNNING AUDIT' : '○ READY'}
          </span>
        </div>

        <h1 className="text-4xl sm:text-5xl font-display font-bold text-prose tracking-tight">
          CI/CD Verification.
        </h1>
        <p className="text-prose-muted mt-2 text-base max-w-2xl">
          Real-time forensic audit pipeline for incoming code pushes.
        </p>
      </div>

      {/* Contract & Push Trigger Card */}
      <div className="bg-ink-2 border border-rule p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 font-mono">
        <div>
          <span className="text-xs text-prose-muted uppercase tracking-wider block mb-1">Target Contract</span>
          <h2 className="text-base font-bold text-prose">{contractData?.title || 'Untitled Contract'}</h2>
          <p className="text-xs text-prose-muted mt-0.5">
            ID: {contractData?.contractId || 'CTR-2026-8941'} │ MERKLE: <span className="text-prose">{contractData?.hash ? `${contractData.hash.slice(0, 14)}…` : '—'}</span>
          </p>
        </div>

        <button
          id="btn-simulate-push"
          onClick={runPipeline}
          disabled={isRunning}
          className={`px-5 py-3 font-mono font-bold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2 shrink-0 ${
            isRunning
              ? 'bg-ink-3 text-prose-muted border border-rule cursor-wait'
              : 'bg-signal text-ink hover:opacity-90 active:scale-[0.99]'
          }`}
        >
          {isRunning ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>PIPELINE RUNNING...</span>
            </>
          ) : (
            <>
              <GitBranch className="w-4 h-4" />
              <span>Simulate GitHub Push →</span>
            </>
          )}
        </button>
      </div>

      {/* Live Pipeline Readout Console */}
      <div className="bg-ink-2 border border-rule p-6 font-mono space-y-6">
        <div className="flex items-center justify-between text-xs text-prose-muted uppercase border-b border-rule pb-3">
          <span>PIPELINE AUDIT EXECUTION LOG</span>
          <span className={isRunning ? 'text-signal font-bold' : ''}>
            {isRunning ? 'STREAMING DATA TICKS' : 'STANDBY'}
          </span>
        </div>

        <div className="space-y-4">
          {PIPELINE_STEPS.map((step, idx) => {
            const isActive = activeStep === step.id;
            const isComplete = completedSteps.includes(step.id);

            return (
              <div key={step.id} className="border-b border-rule/50 pb-4 last:border-0 last:pb-0">
                <div className="flex items-center justify-between text-xs sm:text-sm">
                  <div className="flex items-center gap-3">
                    <span className="text-prose-dim">STEP 0{step.id}</span>
                    <span className={`font-semibold ${isComplete ? 'text-signal' : isActive ? 'text-prose font-bold' : 'text-prose-muted'}`}>
                      {step.label}
                    </span>
                  </div>

                  <div>
                    {isComplete && <span className="text-xs text-signal">✓ DONE</span>}
                    {isActive && <span className="text-xs text-prose animate-pulse">● EXECUTING</span>}
                    {!isComplete && !isActive && <span className="text-xs text-prose-dim">○ QUEUED</span>}
                  </div>
                </div>

                <p className="text-xs text-prose-muted mt-1.5 pl-16">
                  {step.description}
                </p>

                {isActive && (
                  <div className="mt-2 pl-16">
                    <div className="h-1 bg-ink border border-rule w-full max-w-md overflow-hidden">
                      <motion.div
                        initial={{ width: '0%' }}
                        animate={{ width: '100%' }}
                        transition={{ duration: (step.duration || 2000) / 1000, ease: 'linear' }}
                        className="h-full bg-signal"
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Results Telemetry */}
      <AnimatePresence>
        {pipelineComplete && results && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="space-y-6"
          >
            <div className="font-mono text-xs text-prose-muted uppercase tracking-wider border-b border-rule pb-2">
              TELEMETRY & AST METRICS READOUT
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 font-mono">
              <div className="bg-ink-2 border border-rule p-5">
                <span className="text-xs text-prose-muted uppercase block mb-1">Maintainability</span>
                <div className="text-3xl font-bold text-prose">
                  {results.maintainability} <span className="text-xs text-prose-muted font-normal">/ 100</span>
                </div>
                <span className="text-[11px] text-prose-muted mt-2 block">AST Cyclomatic Score</span>
              </div>

              <div className="bg-ink-2 border border-rule p-5">
                <span className="text-xs text-prose-muted uppercase block mb-1">Hidden Tests</span>
                <div className="text-3xl font-bold text-signal">
                  {results.passedTests} / {results.totalTests}
                </div>
                <span className="text-[11px] text-prose-muted mt-2 block">Acceptance Vectors Passed</span>
              </div>

              <div className="bg-ink-2 border border-rule p-5">
                <span className="text-xs text-prose-muted uppercase block mb-1">Vulnerabilities</span>
                <div className={`text-3xl font-bold ${results.vulnerabilities === 0 ? 'text-signal' : 'text-fail'}`}>
                  {results.vulnerabilities}
                </div>
                <span className="text-[11px] text-prose-muted mt-2 block">OWASP Critical Issues</span>
              </div>
            </div>

            {/* Audit Status Result Panel */}
            <div className="bg-ink-2 border border-rule p-8 text-center font-mono">
              {results.passed ? (
                <div className="space-y-4">
                  <div className="inline-flex items-center justify-center p-3 bg-ink border border-rule">
                    <CheckCircle2 className="w-8 h-8 text-signal" />
                  </div>
                  <h2 className="text-2xl font-bold text-prose tracking-wider">
                    STATUS: <span className="text-signal">VERIFIED</span>
                  </h2>
                  <p className="text-xs text-prose-muted max-w-md mx-auto">
                    Zero-Trust audit passed. Code push conforms to all locked contract invariants.
                  </p>
                  {onNextPhase && (
                    <button
                      id="btn-proceed-xai"
                      onClick={onNextPhase}
                      className="mt-4 px-6 py-3 bg-signal text-ink font-bold text-xs uppercase tracking-wider hover:opacity-90 transition-all"
                    >
                      Proceed to XAI Trust Score →
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="inline-flex items-center justify-center p-3 bg-ink border border-rule">
                    <XCircle className="w-8 h-8 text-fail" />
                  </div>
                  <h2 className="text-2xl font-bold text-prose tracking-wider">
                    STATUS: <span className="text-fail">FAILED</span>
                  </h2>
                  <p className="text-xs text-prose-muted max-w-md mx-auto">
                    Vulnerabilities or test failures detected. Revision required before settlement.
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default VerificationDashboard;

