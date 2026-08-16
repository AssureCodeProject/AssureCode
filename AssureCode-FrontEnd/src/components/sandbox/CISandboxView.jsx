import React from 'react';
import { useApp } from '../../context/AppContext';
import { LivePushSimulator } from './LivePushSimulator';
import { ASTMetricsCard } from './ASTMetricsCard';
import { OWASPReport } from './OWASPReport';
import { Terminal } from '../common/Terminal';
import { CheckCircle2, ShieldCheck, Cpu, Code2, Lock } from 'lucide-react';
import { Badge } from '../common/Badge';

export function CISandboxView() {
  const { 
    sandboxLogs, 
    isSandboxRunning, 
    triggerPushAndCISandbox, 
    astMetrics, 
    owaspReport, 
    hiddenTests,
    activeContract 
  } = useApp();

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="glass-panel rounded-2xl p-6 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-cyan-400" />
            <h2 className="text-xl font-bold text-white">Objective 2: Zero-Trust CI Sandbox & Verification</h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Evaluates untrusted developer code in ephemeral Docker sandbox (network: none) with AST parsing, hidden test injection, and dual-layer OWASP auditing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="cyan">Ephemeral Runner</Badge>
          <Badge variant="success">Read-Only Tests</Badge>
        </div>
      </div>

      {/* Push Simulator */}
      <LivePushSimulator />

      {/* Grid: Terminal & Hidden Tests Runner */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Terminal
            logs={sandboxLogs}
            isRunning={isSandboxRunning}
            onRunSimulation={triggerPushAndCISandbox}
          />
        </div>

        {/* Hidden Test Suite Status */}
        <div className="glass-panel rounded-2xl p-5 border border-slate-800 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Lock className="w-4 h-4 text-indigo-400" />
              Hidden Test Injections ({hiddenTests.length})
            </h3>
            <Badge variant="success" size="xs">
              {hiddenTests.filter(t => t.status === 'PASSED').length}/{hiddenTests.length} Passed
            </Badge>
          </div>

          <p className="text-xs text-slate-400">
            Synthesized by Cloudflare Workers AI and executed read-only in sandbox to prevent test tampering.
          </p>

          <div className="space-y-2 max-h-[300px] overflow-y-auto font-mono text-xs">
            {hiddenTests.map(test => (
              <div
                key={test.id}
                className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 flex items-center justify-between"
              >
                <div className="flex items-center gap-2 truncate">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                  <span className="text-slate-300 truncate">{test.name}</span>
                </div>
                <span className="text-[10px] text-slate-500 font-semibold">{test.duration}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* AST Code Quality & Complexity */}
      <ASTMetricsCard astMetrics={astMetrics} />

      {/* Dual Layer OWASP Security Audit Report */}
      <OWASPReport report={owaspReport} />
    </div>
  );
}
