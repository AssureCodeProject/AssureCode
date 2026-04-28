import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldCheck, Cpu } from 'lucide-react';

import ContractInitialization from './components/ContractInitialization';
import VerificationDashboard from './components/VerificationDashboard';

/**
 * App — Root component for the AssureCode dashboard.
 *
 * Manages the two-phase workflow:
 *   Phase 1: Client Contract Initialization
 *   Phase 2: Freelancer Zero-Trust CI/CD Verification
 *
 * State lifted here so that contract data flows from Phase 1 → Phase 2.
 */
function App() {
  // Currently active phase (1 or 2)
  const [activePhase, setActivePhase] = useState(1);

  // Contract data produced by Phase 1, consumed by Phase 2
  const [contractData, setContractData] = useState(null);

  /**
   * Called by ContractInitialization when the contract is successfully locked.
   * Saves contract metadata and transitions the user to Phase 2.
   */
  const handleContractLocked = (data) => {
    setContractData(data);
  };

  /** Navigate to Phase 2 (only possible after contract is locked) */
  const goToPhase2 = () => {
    if (contractData) setActivePhase(2);
  };

  /** Navigate back to Phase 1 */
  const goToPhase1 = () => setActivePhase(1);

  return (
    <div className="min-h-screen bg-void-500 relative">
      {/* ── Ambient Background Orbs ────────────────────────── */}
      <div className="ambient-bg">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="orb orb-3" />
      </div>

      {/* ── Grid / Hex overlay ─────────────────────────────── */}
      <div className="fixed inset-0 bg-grid-futuristic hex-pattern pointer-events-none z-0" />

      {/* ── Content wrapper ────────────────────────────────── */}
      <div className="relative z-10">
        {/* ── Top Navigation Bar ─────────────────────────────── */}
        <nav className="sticky top-0 z-50 glass border-b border-white/5">
          <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyber-400 to-neon-500 flex items-center justify-center shadow-glow-cyan animate-float">
                <ShieldCheck className="w-5 h-5 text-white" strokeWidth={2.5} />
              </div>
              <div className="flex flex-col">
                <span className="text-lg font-bold tracking-tight text-white">
                  Assure<span className="text-cyber-400 text-glow-cyan">Code</span>
                </span>
                <span className="text-[10px] font-mono text-gray-500 -mt-1 tracking-widest uppercase">
                  Zero-Trust Protocol
                </span>
              </div>
            </div>

            {/* Phase tabs */}
            <div className="flex items-center glass-light rounded-xl p-1 gap-1">
              <button
                id="nav-phase-1"
                onClick={goToPhase1}
                className={`px-5 py-2 rounded-lg text-sm font-medium transition-all duration-300 ${
                  activePhase === 1
                    ? 'bg-gradient-to-r from-cyber-400/15 to-neon-500/15 text-cyber-300 shadow-neon-border ring-glow-cyan'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${activePhase === 1 ? 'bg-cyber-400 animate-pulse' : 'bg-gray-600'}`} />
                  Phase 1 — Contract
                </span>
              </button>
              <button
                id="nav-phase-2"
                onClick={goToPhase2}
                disabled={!contractData}
                className={`px-5 py-2 rounded-lg text-sm font-medium transition-all duration-300 ${
                  activePhase === 2
                    ? 'bg-gradient-to-r from-cyber-400/15 to-neon-500/15 text-cyber-300 shadow-neon-border ring-glow-cyan'
                    : contractData
                      ? 'text-gray-500 hover:text-gray-300'
                      : 'text-gray-700 cursor-not-allowed'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${activePhase === 2 ? 'bg-cyber-400 animate-pulse' : contractData ? 'bg-gray-600' : 'bg-gray-800'}`} />
                  Phase 2 — Verification
                </span>
              </button>
            </div>

            {/* Status indicator */}
            <div className="hidden sm:flex items-center gap-3">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg glass-light">
                <Cpu className="w-3.5 h-3.5 text-cyber-400 animate-pulse" />
                <span className="text-xs text-cyber-400 font-mono tracking-wider">
                  ACTIVE
                </span>
              </div>
              <div className="w-2 h-2 rounded-full bg-status-success animate-glow-pulse shadow-glow-green" />
            </div>
          </div>
        </nav>

        {/* ── Main Content Area ──────────────────────────────── */}
        <main className="max-w-7xl mx-auto px-6 py-10">
          <AnimatePresence mode="wait">
            {activePhase === 1 ? (
              <motion.div
                key="phase-1"
                initial={{ opacity: 0, x: -40, filter: 'blur(8px)' }}
                animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, x: -40, filter: 'blur(8px)' }}
                transition={{ duration: 0.45, ease: 'easeInOut' }}
              >
                <ContractInitialization
                  onContractLocked={handleContractLocked}
                  contractData={contractData}
                  onProceedToPhase2={goToPhase2}
                />
              </motion.div>
            ) : (
              <motion.div
                key="phase-2"
                initial={{ opacity: 0, x: 40, filter: 'blur(8px)' }}
                animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, x: 40, filter: 'blur(8px)' }}
                transition={{ duration: 0.45, ease: 'easeInOut' }}
              >
                <VerificationDashboard
                  contractData={contractData}
                  onBack={goToPhase1}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* ── Footer ─────────────────────────────────────────── */}
        <footer className="border-t border-white/5 mt-20">
          <div className="max-w-7xl mx-auto px-6 py-6 flex items-center justify-between text-xs text-gray-600">
            <span className="font-mono">© 2026 AssureCode · Zero-Trust Freelance Ecosystem</span>
            <div className="flex items-center gap-4">
              <span className="text-gray-700">Built with cryptographic assurance</span>
              <span className="font-mono text-cyber-700">v1.0.0-alpha</span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default App;
