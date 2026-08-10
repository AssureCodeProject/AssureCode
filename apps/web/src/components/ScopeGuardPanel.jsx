/**
 * ScopeGuardPanel — real chat through the scope guard, plus the C1
 * cumulative scope-drift assessment over that same message sequence.
 *
 * Both of these existed only as backend routes before this component: a
 * working /api/contracts/:id/chat + scope-check pipeline and a fully tested
 * conformal-martingale drift detector (apps/scope-guard/app/services/
 * drift_detector.py) with nothing in the UI to send a message or see an
 * assessment. Every value shown here comes from a real response — a blocked
 * message shows the gateway's actual similarity score and mediation text,
 * and the drift panel shows the actual martingale/CUSUM trace, not a
 * simulated one.
 */
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Send,
  ShieldAlert,
  ShieldCheck,
  Loader2,
  ActivitySquare,
  AlertTriangle,
} from 'lucide-react';
import { apiRequest } from '../utils/api';

/** apiRequest, not callApi — a blocked (403) message's body carries `reason`/
 *  `mediation`, not an `error` field, and callApi's throw-on-non-2xx would
 *  discard it. This needs the full body regardless of status. */
function post(path, body) {
  return apiRequest(path, { method: 'POST', body: body ?? {} });
}

export function ScopeGuardPanel({ contractId }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [drift, setDrift] = useState({ status: 'idle' });

  const handleSend = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isSending || !contractId) return;

    setInput('');
    setIsSending(true);

    const { status, payload } = await post(`/api/contracts/${contractId}/chat`, { message: text });

    setMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${prev.length}`,
        text,
        delivered: payload.delivered === true,
        reason: payload.reason,
        mediation: payload.mediation,
        httpStatus: status,
      },
    ]);
    setIsSending(false);
  };

  const handleAssessDrift = async () => {
    if (!contractId) return;
    setDrift({ status: 'loading' });
    const { status, ok, payload } = await post(`/api/contracts/${contractId}/drift`, {});
    if (!ok) {
      setDrift({ status: 'error', message: payload.error || `HTTP ${status}` });
      return;
    }
    setDrift({ status: 'ready', data: payload.assessment });
  };

  return (
    <div className="bg-ink-2 border border-rule font-mono">
      <div className="flex items-center justify-between border-b border-rule px-6 py-4">
        <div className="flex items-center gap-2 text-xs text-prose-muted uppercase tracking-wider">
          <ShieldAlert className="w-4 h-4 text-signal" />
          <span>Scope Guard — Contract Chat</span>
        </div>
        <span className="text-[11px] text-prose-dim">RAG-retrieval scope check, per message</span>
      </div>

      {/* ── Message thread ─────────────────────────────────────────── */}
      <div className="p-6 space-y-3 max-h-72 overflow-y-auto">
        {messages.length === 0 && (
          <p className="text-xs text-prose-dim">
            No messages yet. Try something in scope, then try asking for something the contract
            never mentioned — the scope guard checks each message against the locked requirements.
          </p>
        )}
        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`p-3 border text-xs ${
                m.delivered ? 'border-rule bg-ink' : 'border-fail/40 bg-fail/5'
              }`}
            >
              <div className="flex items-start gap-2">
                {m.delivered ? (
                  <ShieldCheck className="w-3.5 h-3.5 text-signal shrink-0 mt-0.5" />
                ) : (
                  <ShieldAlert className="w-3.5 h-3.5 text-fail shrink-0 mt-0.5" />
                )}
                <div className="min-w-0">
                  <p className="text-prose">{m.text}</p>
                  {!m.delivered && (
                    <div className="mt-1.5 text-[11px] text-fail space-y-0.5">
                      <p>{m.reason || `Not delivered (HTTP ${m.httpStatus})`}</p>
                      {m.mediation && <p className="text-prose-muted">{m.mediation}</p>}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <form onSubmit={handleSend} className="flex items-center gap-2 border-t border-rule p-4">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isSending || !contractId}
          placeholder={contractId ? 'Send a message to the freelancer...' : 'No active contract'}
          className="flex-1 bg-ink px-3 py-2.5 border border-rule text-prose text-xs placeholder:text-prose-dim
                     focus:border-signal outline-none transition-colors disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={isSending || !input.trim() || !contractId}
          className="px-4 py-2.5 bg-signal text-ink font-bold text-xs uppercase tracking-wider
                     hover:opacity-90 active:scale-[0.99] transition-all disabled:opacity-30 disabled:cursor-not-allowed
                     flex items-center gap-1.5"
        >
          {isSending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          <span>Send</span>
        </button>
      </form>

      {/* ── C1 drift assessment ─────────────────────────────────────── */}
      <div className="border-t border-rule p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-prose-muted uppercase tracking-wider">
            <ActivitySquare className="w-4 h-4 text-signal" />
            <span>Cumulative Scope-Drift Assessment</span>
          </div>
          <button
            onClick={handleAssessDrift}
            disabled={drift.status === 'loading' || !contractId || messages.length === 0}
            className="px-3 py-2 border border-rule text-prose-muted hover:text-prose text-[11px] uppercase tracking-wider
                       transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {drift.status === 'loading' && <Loader2 className="w-3 h-3 animate-spin" />}
            <span>Assess Drift</span>
          </button>
        </div>

        <p className="text-[11px] text-prose-dim leading-relaxed">
          Per-message thresholds miss gradual drift — twenty small, individually-plausible stretches
          can add up to a different product. This runs a conformal test martingale (Vovk 2003; Ville
          1939) over every message recorded for this contract, anchored to its genesis hash, and
          alarms with an anytime-valid false-alarm bound rather than a hand-picked threshold.
        </p>

        {messages.length === 0 && (
          <p className="text-[11px] text-prose-dim italic">Send at least one message to assess.</p>
        )}

        {drift.status === 'error' && (
          <div className="flex items-start gap-2 text-xs text-fail bg-fail/5 border border-fail/30 px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{drift.message}</span>
          </div>
        )}

        {drift.status === 'ready' && drift.data && (
          <div className="space-y-3">
            <div
              className={`px-3 py-2 border text-xs font-bold uppercase tracking-wider ${
                drift.data.alarmed ? 'border-fail text-fail bg-fail/5' : 'border-signal text-signal bg-signal/5'
              }`}
            >
              {drift.data.alarmed
                ? `⚠ Drift alarm — ${drift.data.alarm_reason} (first flagged at message #${drift.data.alarmed_at})`
                : `No drift alarm over ${drift.data.messages_observed} message(s)`}
            </div>

            {drift.data.calibration_is_synthetic && (
              <div className="flex items-start gap-2 text-[11px] text-warn bg-warn/5 border border-warn/30 px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{drift.data.coverage_note}</span>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px]">
              <div className="bg-ink p-2.5 border border-rule">
                <span className="text-prose-muted block uppercase">δ (target false-alarm)</span>
                <span className="text-prose font-bold">{drift.data.delta}</span>
              </div>
              <div className="bg-ink p-2.5 border border-rule">
                <span className="text-prose-muted block uppercase">Calibration n</span>
                <span className="text-prose font-bold">{drift.data.calibration_n}</span>
              </div>
              <div className="bg-ink p-2.5 border border-rule">
                <span className="text-prose-muted block uppercase">Messages observed</span>
                <span className="text-prose font-bold">{drift.data.messages_observed}</span>
              </div>
              <div className="bg-ink p-2.5 border border-rule">
                <span className="text-prose-muted block uppercase">Genesis hash</span>
                <span className="text-prose font-bold">{drift.data.genesis_hash?.slice(0, 10)}…</span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-[11px] text-left">
                <thead>
                  <tr className="text-prose-muted border-b border-rule uppercase">
                    <th className="py-1.5 pr-3">#</th>
                    <th className="py-1.5 pr-3">Residual</th>
                    <th className="py-1.5 pr-3">p-value</th>
                    <th className="py-1.5 pr-3">log martingale</th>
                    <th className="py-1.5">Alarmed</th>
                  </tr>
                </thead>
                <tbody>
                  {drift.data.steps.map((s) => (
                    <tr key={s.index} className={`border-b border-rule/40 ${s.alarmed ? 'text-fail' : 'text-prose'}`}>
                      <td className="py-1.5 pr-3">{s.index}</td>
                      <td className="py-1.5 pr-3">{s.residual.toFixed(4)}</td>
                      <td className="py-1.5 pr-3">{s.p_value.toFixed(4)}</td>
                      <td className="py-1.5 pr-3">{s.log_martingale.toFixed(4)}</td>
                      <td className="py-1.5">{s.alarmed ? 'YES' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ScopeGuardPanel;
