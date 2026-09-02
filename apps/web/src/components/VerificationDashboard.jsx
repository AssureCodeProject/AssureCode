import React, { useState, useCallback, useEffect, useRef } from 'react';
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
import { RepoWorkspaceCard } from './RepoWorkspaceCard';
import { AuditFindingsDetail } from './AuditFindingsDetail';

/**
 * One row per topic the audit stream reports, keyed by the step id the server
 * actually sends.
 *
 * These ids are a contract with AUDIT_STREAM_STEP_BY_TOPIC in
 * apps/api-gateway/src/server.ts, which numbers the topics 0-4. This list was
 * numbered 1-4, so every row was driven by the wrong event: step 0 addressed
 * nothing and was dropped, "Webhook Verified" lit up when the sandbox became
 * ready, "Sandbox Provisioned" lit up when the AST finished, and there was no
 * row at all for the hidden-test run. The steps still animated in sequence,
 * which is why it read as working.
 */
const PIPELINE_STEPS = [
  {
    id: 0,
    label: 'Push Received & Event Published',
    description: 'Code push accepted, HMAC signature verified, event published to the bus.',
    duration: 1200,
  },
  {
    id: 1,
    label: 'Ephemeral Sandbox Provisioned',
    description: 'Isolated runner started with the pushed code and the contract’s hidden tests.',
    duration: 2200,
  },
  {
    id: 2,
    label: 'AST Cyclomatic Complexity Parsing',
    description: 'Abstract Syntax Tree analysis computing code complexity metrics.',
    duration: 2500,
  },
  {
    id: 3,
    label: 'Hidden Test Suite Executed',
    description: 'The contract’s generated acceptance tests run against the pushed code.',
    duration: 2400,
  },
  {
    id: 4,
    label: 'AI Security Auditor (OWASP Scan)',
    description: 'Dual-layer scan for OWASP Top-10 vulnerabilities: static rules plus LLM review.',
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
  // null, not 0: 0 is now a real step id (CODE_PUSH_RECEIVED), so seeding this
  // with 0 would render that step as EXECUTING before the run had started.
  const [activeStep, setActiveStep] = useState(null);
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
    setActiveStep(null);
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
    let pushTriggered = false;

    try {
      const socket = new WebSocket(buildStreamUrl(contractId));

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'ready') {
            // The server only sends this once every consumer group behind
            // this socket has joined. Triggering the push before now (or
            // right after opening, without waiting) is a real race: this
            // pipeline can finish in ~2s, faster than the ~3s a fresh
            // consumer group takes to join, so an early push publishes
            // every step event before anything is listening for it.
            if (!pushTriggered) {
              pushTriggered = true;
              callApi(`/api/contracts/${contractId}/simulate-push`, 'POST').catch((err) => {
                fail(`Could not trigger the audit: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
          } else if (data.type === 'step-complete' && 'stepId' in data && typeof data.stepId === 'number') {
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

  // Fetch the latest completed audit on mount. `results`/`pipelineComplete`
  // above are otherwise only ever set inside runPipeline()'s own WebSocket
  // handler -- populated only for a run this page triggered and watched
  // live. A real GitHub webhook push runs with nobody watching that socket,
  // so without this, its outcome is invisible here forever: refreshing (or
  // opening this page fresh after a real push) left the log at STANDBY with
  // no way to see a result that already exists in the database.
  useEffect(() => {
    const contractId = contractData?.contractId;
    if (!contractId) return undefined;

    let cancelled = false;
    callApi(`/api/audits/${contractId}/results`)
      .then((res) => {
        if (cancelled || !res) return;
        setResults(res);
        setPipelineComplete(true);
        setCompletedSteps(PIPELINE_STEPS.map((step) => step.id));
      })
      .catch(() => {
        // No audit has run yet (404) or a transient read failure -- either
        // way, stay in the standby state rather than showing an error for a
        // page load that never asked anything to run.
      });

    return () => {
      cancelled = true;
    };
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
      <div className="bg-ink-2 border border-rule p-6 font-mono">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
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

        <RepoWorkspaceCard contractId={contractData?.contractId} />
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
          {PIPELINE_STEPS.map((step, index) => {
            const isActive = activeStep === step.id;
            const isComplete = completedSteps.includes(step.id);

            return (
              <div key={step.id} className="border-b border-rule/50 pb-4 last:border-0 last:pb-0">
                <div className="flex items-center justify-between text-xs sm:text-sm">
                  <div className="flex items-center gap-3">
                    {/* Displayed 1-based for readers; `step.id` stays the
                        server's 0-based protocol id. */}
                    <span className="text-prose-dim">STEP {String(index + 1).padStart(2, '0')}</span>
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

            <AuditFindingsDetail {...(results.details || {})} />

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

