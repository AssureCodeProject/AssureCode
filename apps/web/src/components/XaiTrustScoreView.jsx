/**
 * XaiTrustScoreView — renders the trust score the backend actually computed.
 *
 * What this replaced
 * ------------------
 * The previous version seeded its state from `mockXaiData` and swallowed every
 * fetch failure with a catch block whose entire body was the comment "Fall back
 * to static mock data". The screen then showed score 92, grade A+, "0 Critical",
 * and a five-entry audit trail with invented block hashes — for a contract that
 * had never been audited, or while the gateway was down. That is the same defect
 * Phase 5 removed from the backend (the hardcoded 0.92), rendered instead of
 * returned.
 *
 * The rule here is the same one the API follows: no measurement, no number.
 * Every failure the gateway can return gets a distinct visible state, because
 * "the scorer refused because no tests ran" and "the gateway is unreachable"
 * are different problems and the user has to be able to tell them apart.
 *
 * While loading, the card renders blurred and disabled behind a "not a reading"
 * label rather than showing plausible placeholder digits — a screenshot taken
 * mid-load should not be mistakable for a result.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { apiRequest } from '../utils/api';
import {
  ShieldCheck,
  Target,
  Layers,
  Bug,
  BrainCircuit,
  ChevronRight,
  TrendingUp,
  Cpu,
  Clock,
  AlertTriangle,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import RadialGauge from './ui/RadialGauge';
import StatusBadge from './ui/StatusBadge';
import { AuditFindingsDetail } from './AuditFindingsDetail';

/** Icon per term name returned by /xai/score. */
const TERM_ICONS = {
  tests: ShieldCheck,
  maintainability: Layers,
  security: Bug,
  scope_adherence: Target,
};

const TERM_LABELS = {
  tests: 'Hidden Test Pass Rate',
  maintainability: 'SEI Maintainability Index',
  security: 'OWASP 2025 Security Score',
  scope_adherence: 'RAG Scope Adherence',
};

function gateStatusClasses(status, meetsGate) {
  if (status !== 'ready') return 'text-prose-muted';
  return meetsGate ? 'text-signal font-semibold' : 'text-warn font-semibold';
}

function gateStatusLabel(status, meetsGate) {
  switch (status) {
    case 'ready':
      return meetsGate ? '✓ SCORED — GATE PASSED' : '✗ SCORED — GATE NOT MET';
    case 'error':
      return '⚠ NOT SCORED';
    default:
      return '… MEASURING';
  }
}

function settlementLabel(status, meetsGate) {
  if (status !== 'ready') return 'MEASURING';
  return meetsGate ? 'SETTLEMENT ELIGIBLE' : 'SETTLEMENT BLOCKED';
}

export function XaiTrustScoreView({ contractData, onProceedToEscrow }) {
  const [showAuditTrail, setShowAuditTrail] = useState(true);
  const [state, setState] = useState({ status: 'idle' });

  const contractId = contractData?.contractId;

  const load = useCallback(async () => {
    if (!contractId) {
      setState({
        status: 'error',
        kind: 'no-contract',
        message: 'No contract selected. Initialize a contract before requesting a trust score.',
      });
      return;
    }

    setState({ status: 'loading' });

    // apiRequest rather than callApi: each HTTP status gets its own visible
    // explanation below, which a thrown Error would flatten into one string.
    let res;
    try {
      res = await apiRequest(`/api/contracts/${encodeURIComponent(contractId)}/score`);
    } catch (err) {
      setState({
        status: 'error',
        kind: 'unreachable',
        message: `The API gateway is unreachable (${err instanceof Error ? err.message : String(err)}).`,
      });
      return;
    }

    if (!res.ok) {
      setState({
        status: 'error',
        kind: `http-${res.status}`,
        message: res.payload.error || `Gateway returned HTTP ${res.status}.`,
      });
      return;
    }

    setState({ status: 'ready', data: res.payload });
  }, [contractId]);

  useEffect(() => {
    void load();
  }, [load]);

  const data = state.status === 'ready' ? state.data : null;
  const score = data ? data.trustScore : null;
  const threshold = data?.threshold ?? 85;
  const meetsGate = data ? score >= threshold && data.criticalVulns === 0 : false;

  return (
    <div className="max-w-5xl mx-auto space-y-8 font-sans">
      {/* ── Section Header ─────────────────────────────────────────── */}
      <div className="border-b border-rule pb-6">
        <div className="flex items-center justify-between font-mono text-xs text-prose-muted uppercase tracking-widest mb-3">
          <span>PHASE 03 of 04 ───────────────────────────────────────────</span>
          <span className={gateStatusClasses(state.status, meetsGate)}>
            {gateStatusLabel(state.status, meetsGate)}
          </span>
        </div>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-4xl sm:text-5xl font-display font-bold text-prose tracking-tight">
              XAI Trust Score.
            </h1>
            <p className="text-prose-muted mt-2 text-base max-w-2xl">
              Deterministic linear model over CI telemetry — T = 0.40·S<sub>test</sub> + 0.25·S
              <sub>maint</sub> + 0.20·S<sub>sec</sub> + 0.15·S<sub>scope</sub>.
            </p>
          </div>

          <div className="flex items-center gap-2 self-start md:self-auto">
            <button
              onClick={load}
              disabled={state.status === 'loading'}
              className="px-4 py-3.5 border border-rule text-prose-muted hover:text-prose font-mono text-xs uppercase tracking-wider transition-colors flex items-center gap-2 disabled:opacity-40"
            >
              <RefreshCw className={`w-4 h-4 ${state.status === 'loading' ? 'animate-spin' : ''}`} />
              <span>rescore</span>
            </button>

            {/* Advancing to escrow is only offered once the gate is actually met.
                Offering it regardless would invite the user to request a
                settlement the oracle is certain to reject. */}
            {onProceedToEscrow && (
              <button
                id="btn-proceed-escrow"
                onClick={onProceedToEscrow}
                disabled={!meetsGate}
                title={
                  meetsGate
                    ? undefined
                    : `Settlement requires trustScore >= ${threshold} and 0 critical vulnerabilities.`
                }
                className={`px-6 py-3.5 font-mono font-bold text-xs uppercase tracking-wider transition-all flex items-center gap-2 ${
                  meetsGate
                    ? 'bg-signal text-ink hover:opacity-90'
                    : 'bg-ink-3 text-prose-muted border border-rule cursor-not-allowed'
                }`}
              >
                <span>Proceed to Escrow Settlement</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Error state ─────────────────────────────────────────────── */}
      {state.status === 'error' && (
        <div className="bg-ink-2 border border-warn p-8 font-mono space-y-4">
          <div className="flex items-center gap-3 text-warn">
            <AlertTriangle className="w-6 h-6" />
            <span className="text-lg font-bold uppercase tracking-wide">No trust score available</span>
          </div>
          <p className="text-sm text-prose font-sans leading-relaxed">{state.message}</p>
          <div className="text-xs text-prose-muted border-t border-rule pt-3 space-y-1">
            <p>
              <span className="text-warn">{state.kind}</span> — the score is computed from recorded CI
              telemetry. No telemetry, no score: this screen will not display a placeholder value.
            </p>
            {state.kind === 'http-409' && (
              <p>Run the CI pipeline for this contract, then rescore.</p>
            )}
            {(state.kind === 'http-502' || state.kind === 'unreachable') && (
              <p>Check that the api-gateway and ai-service are running.</p>
            )}
          </div>
        </div>
      )}

      {/* ── Hero Trust Score Overview Card ───────────────────────────── */}
      {state.status !== 'error' && (
        <div
          className={`bg-ink-2 border border-rule p-8 font-mono relative ${
            state.status !== 'ready' ? 'opacity-40 blur-[2px] select-none' : ''
          }`}
          aria-busy={state.status !== 'ready'}
        >
          <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-center">
            {/* Radial Score Gauge */}
            <div className="md:col-span-5 flex flex-col items-center justify-center p-4 border-b md:border-b-0 md:border-r border-rule">
              <RadialGauge
                value={score ?? 0}
                max={100}
                size={190}
                strokeWidth={12}
                colorMode="auto"
                centerContent={
                  <div className="flex flex-col items-center justify-center">
                    <span className="text-5xl font-bold font-mono text-prose tracking-tight">
                      {score === null ? '—' : score.toFixed(1)}
                    </span>
                    <span className="text-xs font-mono uppercase tracking-widest text-prose-muted mt-1">
                      / 100
                    </span>
                  </div>
                }
              />
              <div className="mt-4 text-xs text-prose-muted text-center">
                Settlement threshold:{' '}
                <strong className="text-prose font-bold">{threshold}</strong>
              </div>
            </div>

            {/* Key Indicators */}
            <div className="md:col-span-7 space-y-6">
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`px-3 py-1 text-xs font-mono font-bold tracking-wider bg-ink border border-rule ${
                    meetsGate ? 'text-signal' : 'text-warn'
                  }`}
                >
                  {settlementLabel(state.status, meetsGate)}
                </span>
                {data && !data.scopeMeasured && (
                  <StatusBadge variant="warning" size="sm">
                    SCOPE TERM NOT MEASURED
                  </StatusBadge>
                )}
              </div>

              <div>
                <h3 className="text-2xl font-bold text-prose tracking-tight font-display">
                  Contract #{contractId || '—'}
                </h3>
                <p className="text-xs text-prose-muted mt-1">
                  {data ? `Scored: ${new Date(data.scoredAt).toLocaleString()}` : 'Awaiting score…'}
                </p>
              </div>

              {/* Raw telemetry, so the score can be checked against its inputs. */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-ink p-3 border border-rule">
                  <span className="text-[10px] text-prose-muted uppercase block">Tests</span>
                  <p className="text-sm font-bold text-prose">
                    {data ? `${data.telemetry.passedTests}/${data.telemetry.totalTests}` : '—'}
                  </p>
                </div>
                <div className="bg-ink p-3 border border-rule">
                  <span className="text-[10px] text-prose-muted uppercase block">Maintainability</span>
                  <p className="text-sm font-bold text-prose">
                    {data ? data.telemetry.maintainability.toFixed(1) : '—'}
                  </p>
                </div>
                <div className="bg-ink p-3 border border-rule">
                  <span className="text-[10px] text-prose-muted uppercase block">Critical Vulns</span>
                  <p
                    className={`text-sm font-bold ${
                      data && data.criticalVulns > 0 ? 'text-warn' : 'text-signal'
                    }`}
                  >
                    {data ? data.criticalVulns : '—'}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {state.status !== 'ready' && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="px-3 py-1 bg-ink border border-rule text-xs font-mono uppercase tracking-widest text-prose-muted">
                measuring — not a reading
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Term Breakdown ────────────────────────────────── */}
      {state.status === 'ready' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between font-mono text-xs text-prose-muted uppercase border-b border-rule pb-2">
            <span className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-signal" />
              WEIGHTED TERM BREAKDOWN
            </span>
            <span>
              {data.terms.length} of 4 terms measured
              {!data.scopeMeasured && ' — weights renormalised'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {data.terms.map((term) => {
              const Icon = TERM_ICONS[term.name] || BrainCircuit;
              return (
                <div key={term.name} className="p-5 bg-ink-2 border border-rule font-mono">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-ink border border-rule">
                        <Icon className="w-4 h-4 text-signal" />
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-prose font-sans">
                          {TERM_LABELS[term.name] || term.name}
                        </h4>
                        <span className="text-[11px] text-prose-muted">
                          Weight {(term.weight * 100).toFixed(1)}% → contributes{' '}
                          {term.contribution.toFixed(2)}
                        </span>
                      </div>
                    </div>
                    <span className="text-base font-bold text-signal">
                      {term.value.toFixed(1)}/100
                    </span>
                  </div>

                  <div className="w-full bg-ink h-1.5 border border-rule overflow-hidden mb-3">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(100, term.value)}%` }}
                      transition={{ duration: 0.8 }}
                      className="h-full bg-signal"
                    />
                  </div>

                  <p className="text-xs text-prose-muted leading-relaxed font-sans">
                    {term.justification}
                  </p>
                </div>
              );
            })}
          </div>

          <AuditFindingsDetail {...(data.details || {})} />
        </div>
      )}

      {/* ── Advisory LLM Narrative ───────────────────────────
          Explanation of the score above, never a second opinion — the terms
          table is the primary display and this is prose about the same
          arithmetic. Rendered only when the LLM produced one; a missing
          narrative (LLM unavailable) does not block or alter the score. */}
      {state.status === 'ready' && data.narrative && (
        <div className="bg-ink-2 border border-rule p-6 font-mono text-xs">
          <div className="flex items-center gap-2 mb-3 text-prose-muted uppercase tracking-wider">
            <Sparkles className="w-4 h-4 text-signal" />
            <span className="font-bold">AI Explanation (Advisory — Not a Judgment)</span>
          </div>
          <p className="text-sm text-prose font-sans leading-relaxed">{data.narrative}</p>
          <p className="text-[11px] text-prose-muted border-t border-rule pt-3 mt-4 font-sans">
            Generated after the score above was final, from the same terms shown in this screen.
            It explains the number; it cannot change it. The deterministic weighted sum is what
            releases funds, and it is unaffected by this text or by whether it exists at all.
          </p>
        </div>
      )}

      {/* ── Contribution shares ──────────────── */}
      {state.status === 'ready' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 font-mono text-xs">
          <div className="bg-ink-2 border border-rule p-6 space-y-4">
            <div className="flex items-center gap-2 mb-2 text-prose font-bold text-sm uppercase">
              <TrendingUp className="w-4 h-4 text-signal" />
              <span>Share of Final Score</span>
            </div>

            <div className="space-y-3">
              {data.terms.map((term) => (
                <div key={term.name} className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-prose-muted">{TERM_LABELS[term.name] || term.name}</span>
                    <span className="text-signal">
                      +{term.contribution.toFixed(2)} of {score.toFixed(1)}
                    </span>
                  </div>
                  <div className="w-full bg-ink h-1.5 border border-rule overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${score > 0 ? (term.contribution / score) * 100 : 0}%` }}
                      transition={{ duration: 0.6 }}
                      className="h-full bg-signal"
                    />
                  </div>
                </div>
              ))}
            </div>

            <p className="text-[11px] text-prose-muted border-t border-rule pt-3 font-sans">
              Contributions sum to the score exactly. This is a linear model with no learned
              component, so the attribution is the arithmetic itself rather than an approximation
              of it.
            </p>
          </div>

          <div className="bg-ink-2 border border-rule p-6 space-y-4">
            <div className="flex items-center gap-2 mb-2 text-prose font-bold text-sm uppercase">
              <Target className="w-4 h-4 text-signal" />
              <span>Settlement Gate</span>
            </div>

            <div className="space-y-3">
              <div className="flex justify-between items-center bg-ink p-3 border border-rule">
                <span className="text-prose-muted">trustScore ≥ {threshold}</span>
                <span className={score >= threshold ? 'font-bold text-signal' : 'font-bold text-warn'}>
                  {score.toFixed(1)} {score >= threshold ? 'PASS' : 'FAIL'}
                </span>
              </div>

              <div className="flex justify-between items-center bg-ink p-3 border border-rule">
                <span className="text-prose-muted">criticalVulns == 0</span>
                <span
                  className={data.criticalVulns === 0 ? 'font-bold text-signal' : 'font-bold text-warn'}
                >
                  {data.criticalVulns} {data.criticalVulns === 0 ? 'PASS' : 'FAIL'}
                </span>
              </div>

              <div className="flex justify-between items-center bg-ink p-3 border border-rule">
                <span className="text-prose-muted">Scope term measured</span>
                <span className={data.scopeMeasured ? 'font-bold text-signal' : 'font-bold text-warn'}>
                  {data.scopeMeasured ? 'YES' : 'NO'}
                </span>
              </div>
            </div>

            {!data.scopeMeasured && (
              <p className="text-[11px] text-prose-muted border-t border-rule pt-3 font-sans">
                No scope checks are recorded for this contract, so the fourth term was excluded and
                the remaining weights renormalised. The score neither rewards nor penalises the
                missing evidence — but note that a contract which never uses the chat channel avoids
                this term entirely.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Justifications ────────────────────────────────── */}
      {state.status === 'ready' && (
        <div className="bg-ink-2 border border-rule p-6 font-mono text-xs">
          <div className="flex items-center justify-between mb-4 border-b border-rule pb-3">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-signal" />
              <span className="font-bold text-prose uppercase">Score Justifications</span>
            </div>
            <button
              onClick={() => setShowAuditTrail(!showAuditTrail)}
              className="text-prose-muted hover:text-prose transition-colors"
            >
              [{showAuditTrail ? 'hide log' : 'show log'}]
            </button>
          </div>

          {showAuditTrail && (
            <div className="space-y-3">
              {data.justifications.map((j, i) => (
                <div key={i} className="p-3 bg-ink border border-rule space-y-1">
                  <div className="flex items-center justify-between text-prose-muted">
                    <span className="text-signal font-bold">
                      TERM-{String(i + 1).padStart(2, '0')}
                    </span>
                    <span>{new Date(data.scoredAt).toLocaleTimeString()}</span>
                  </div>
                  <p className="text-prose font-sans text-xs">{j}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default XaiTrustScoreView;
