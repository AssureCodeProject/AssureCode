import React, { useRef, useEffect, useState } from 'react';
import { Terminal as TerminalIcon, Copy, Check, Trash2, ShieldCheck, Play, Loader2 } from 'lucide-react';

export function Terminal({ logs = [], title = 'Ephemeral CI Sandbox Terminal', isRunning = false, onRunSimulation }) {
  const terminalEndRef = useRef(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const copyLogs = () => {
    navigator.clipboard.writeText(logs.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-[#070a12] shadow-2xl overflow-hidden font-mono text-xs">
      {/* Terminal Title Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#0f1422] border-b border-slate-800">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 mr-2">
            <div className="w-3 h-3 rounded-full bg-rose-500/80" />
            <div className="w-3 h-3 rounded-full bg-amber-500/80" />
            <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
          </div>
          <TerminalIcon className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-300 font-semibold">{title}</span>
          {isRunning ? (
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 text-[10px] border border-cyan-500/30">
              <Loader2 className="w-3 h-3 animate-spin" />
              RUNNING SANDBOX
            </span>
          ) : (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-[10px] border border-emerald-500/30">
              <ShieldCheck className="w-3 h-3" />
              ISOLATED (NET: NONE)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {onRunSimulation && (
            <button
              onClick={onRunSimulation}
              disabled={isRunning}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-[11px] font-medium transition-colors"
            >
              <Play className="w-3 h-3" />
              {isRunning ? 'Running...' : 'Re-Run Sandbox'}
            </button>
          )}
          <button
            onClick={copyLogs}
            className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            title="Copy Logs"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Terminal Body */}
      <div className="p-4 max-h-[380px] overflow-y-auto space-y-1.5 bg-[#080c16] text-slate-300 select-text">
        {logs.length === 0 ? (
          <div className="text-slate-500 italic py-6 text-center">
            No CI logs generated yet. Trigger a commit or webhook to execute zero-trust sandbox.
          </div>
        ) : (
          logs.map((log, index) => {
            let color = 'text-slate-300';
            if (log.includes('[SANDBOX:INIT]') || log.includes('[SANDBOX:ISOLATION]')) color = 'text-cyan-400 font-semibold';
            if (log.includes('[PASS]') || log.includes('[SANDBOX:SUCCESS]')) color = 'text-emerald-400 font-semibold';
            if (log.includes('[FAIL]') || log.includes('ERROR') || log.includes('Critical')) color = 'text-rose-400 font-semibold';
            if (log.includes('[SANDBOX:AST]') || log.includes('Halstead')) color = 'text-purple-400';
            if (log.includes('[SANDBOX:TEST]')) color = 'text-indigo-300';
            if (log.includes('[SANDBOX:SECURITY]')) color = 'text-amber-400';

            return (
              <div key={index} className={`leading-relaxed tracking-tight ${color} flex items-start gap-2`}>
                <span className="text-slate-600 select-none text-[10px] pt-0.5">
                  {(index + 1).toString().padStart(2, '0')}
                </span>
                <span>{log}</span>
              </div>
            );
          })
        )}
        <div ref={terminalEndRef} />
      </div>
    </div>
  );
}
