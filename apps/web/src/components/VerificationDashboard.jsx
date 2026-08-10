import React, { useState, useCallback, useRef } from 'react';
import { callApi, getAuthToken } from '../utils/api';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  GitBranch,
  CheckCircle2,
  Loader2,
  XCircle,
} from 'lucide-react';
import ScopeGuardPanel from './ScopeGuardPanel';

const PIPELINE_STEPS = [
  {
    id: 1,
    label: 'Webhook Verified & Event Published',
    description: 'GitHub push received, HMAC signature verified, event published to the Redis Streams bus.',
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

/**
 * The browser WebSocket API has no way to set an Authorization header, so the
 * gateway's auth guard accepts this stream's token as a query param instead
 * (see apps/api-gateway/src/middleware/auth.ts isStreamPath()).
 */
function buildStreamUrl(contractId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = `/api/audits/${contractId}/stream`;
  const token = getAuthToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${protocol}//${window.location.host}${path}${query}`;
}

function stepLabelClasses(isComplete, isActive) {
  if (isComplete) return 'font-semibold text-signal';
  if (isActive) return 'font-semibold text-prose font-bold';
  return 'font-semibold text-prose-muted';
}

function auditStatusClasses({ error, pipelineComplete, isRunning }) {
  if (error) return 'text-fail';
  if (pipelineComplete) return 'text-signal';
  if (isRunning) return 'text-prose animate-pulse';
  return 'text-prose-dim';
}

function auditStatusLabel({ error, pipelineComplete, isRunning }) {
  if (error) return '✕ VERIFICATION FAILED';
  if (pipelineComplete) return '✓ VERIFICATION COMPLETE';
  if (isRunning) return '● RUNNING AUDIT';
  return '○ READY';
}

// There is deliberately no local result generator here. An earlier version of
// this component fell back to Math.random() telemetry whenever the audit stream
// failed — maintainability 72–96, a 70% chance of full test pass, a 70% chance
// of zero vulnerabilities. A dropped WebSocket therefore rendered an invented
// passing audit that was indistinguishable from a real one. If the pipeline
// cannot be observed, this view reports that it could not be observed.

export function VerificationDashboard({ contractData, onBack, onNextPhase }) {
  // Pipeline state
  const [isRunning, setIsRunning] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState([]);
  const [pipelineComplete, setPipelineComplete] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  // Refs for socket state
  const isRunningRef = useRef(false);
  const pipelineCompleteRef = useRef(false);

  const runPipeline = useCallback(async () => {
    if (!contractData?.contractId) return;

    isRunningRef.current = true;
    pipelineCompleteRef.current = false;
    setIsRunning(true);
    setActiveStep(0);
    setCompletedSteps([]);
    setPipelineComplete(false);
    setResults(null);
    setError(null);

    // Abandon the run and surface why. Never leaves a result behind.
    const fail = (message) => {
      isRunningRef.current = false;
      pipelineCompleteRef.current = true;
      setIsRunning(false);
      setPipelineComplete(false);
      setResults(null);
      setError(message);
    };

    const contractId = contractData.contractId;
    let isClosed = false;

    try {
      await callApi(`/api/contracts/${contractId}/simulate-push`, 'POST');
    } catch (err) {
      // If the push never reached the gateway there is no audit to stream.
      // Opening a socket at this point would only produce a slower failure.
      fail(`Could not trigger the audit: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    try {
      const socket = new WebSocket(buildStreamUrl(contractId));

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'step-complete' && 'stepId' in data && typeof data.stepId === 'number') {
            const stepId = data.stepId;
            setActiveStep(stepId);
            setCompletedSteps((prev) => (!prev.includes(stepId) ? [...prev, stepId] : prev));
          } else if (data.type === 'audit-complete') {
            pipelineCompleteRef.current = true;
            isRunningRef.current = false;
            setPipelineComplete(true);
            setIsRunning(false);
            // Not gated on isClosed: the server closes the socket right after
            // audit-complete, so this fetch normally resolves after onclose.
            // Dropping it there would leave the view blank on a successful run.
            callApi(`/api/audits/${contractId}/results`)
              .then((res) => {
                if (res) {
                  setResults(res);
                } else {
                  fail('The audit completed but returned no results.');
                }
              })
              .catch((err) => {
                fail(
                  `The audit completed but its results could not be read: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              });
          }
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      socket.onerror = () => {
        if (!isClosed) {
          fail('Lost the connection to the audit stream. No results were produced.');
        }
      };

      socket.onclose = () => {
        isClosed = true;
        // A close before audit-complete means the audit did not finish. The run
        // is abandoned rather than completed with substituted telemetry.
        if (isRunningRef.current && !pipelineCompleteRef.current) {
          fail('The audit stream closed before the pipeline finished. No results were produced.');
        }
      };
    } catch (err) {
      fail(
        `Could not open the audit stream: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [contractData?.contractId]);

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
          <span className={auditStatusClasses({ error, pipelineComplete, isRunning })}>
            {auditStatusLabel({ error, pipelineComplete, isRunning })}
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
            ID: {contractData?.contractId || '—'} │ LEDGER HASH: <span className="text-prose">{contractData?.hash ? `${contractData.hash.slice(0, 14)}…` : '—'}</span>
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
          {PIPELINE_STEPS.map((step) => {
            const isActive = activeStep === step.id;
            const isComplete = completedSteps.includes(step.id);

            return (
              <div key={step.id} className="border-b border-rule/50 pb-4 last:border-0 last:pb-0">
                <div className="flex items-center justify-between text-xs sm:text-sm">
                  <div className="flex items-center gap-3">
                    <span className="text-prose-dim">STEP 0{step.id}</span>
                    <span className={stepLabelClasses(isComplete, isActive)}>
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
                        transition={{ duration: step.duration / 1000, ease: 'linear' }}
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

      {/* Scope Guard: real chat through the scope-check pipeline, plus the C1
          cumulative drift assessment over the same message sequence. Independent
          of the CI audit pipeline above — usable as soon as a contract exists. */}
      <ScopeGuardPanel contractId={contractData?.contractId} />

      {/* Failure state — shown instead of results, never alongside them */}
      {error && (
        <div className="bg-ink-2 border border-fail p-6 font-mono space-y-3">
          <div className="flex items-center gap-2 text-fail text-xs uppercase tracking-wider">
            <XCircle className="w-4 h-4" />
            <span>Audit did not complete</span>
          </div>
          <p className="text-sm text-prose">{error}</p>
          <p className="text-xs text-prose-muted">
            No telemetry is shown because none was measured. This view does not substitute
            placeholder metrics when the pipeline cannot be observed — a missing audit and a
            passing audit must not look the same. Check that the API gateway and the CI worker
            are running, then trigger the push again.
          </p>
        </div>
      )}

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

