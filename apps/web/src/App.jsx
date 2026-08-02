import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Menu,
  FileText,
  Activity,
  BrainCircuit,
  Lock,
  ChevronRight,
  RotateCcw,
  CheckCircle2,
} from 'lucide-react';

import ContractInitialization from './components/ContractInitialization';
import VerificationDashboard from './components/VerificationDashboard';
import XaiTrustScoreView from './components/XaiTrustScoreView';
import EscrowSettlementView from './components/EscrowSettlementView';
import MobileDrawer from './components/ui/MobileDrawer';

/**
 * App — Root component for the AssureCode audit ledger dashboard.
 *
 * Manages the 4-phase core pipeline:
 *   Phase 1: Contract Initialization ('contract')
 *   Phase 2: CI/CD Verification ('verification')
 *   Phase 3: XAI Trust Score ('xai')
 *   Phase 4: Escrow Settlement ('escrow')
 */
export function App() {
  // Navigation active tab state: 'contract' | 'verification' | 'xai' | 'escrow'
  const [activeTab, setActiveTab] = useState(() => {
    return localStorage.getItem('assurecode_active_tab') || 'contract';
  });

  // Shared contract data passed across all 4 phases
  const [contractData, setContractData] = useState(() => {
    const saved = localStorage.getItem('assurecode_contract_data');
    return saved ? JSON.parse(saved) : null;
  });

  // Live session timer state
  const [sessionTime, setSessionTime] = useState('14:02:11');

  useEffect(() => {
    const updateTimer = () => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      setSessionTime(`${hh}:${mm}:${ss}`);
    };
    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, []);

  // Mobile navigation drawer toggle state
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Synchronize state persistence to localStorage
  const isMountedRef = useRef(false);
  useEffect(() => {
    if (isMountedRef.current) {
      localStorage.setItem('assurecode_active_tab', activeTab);
    } else {
      isMountedRef.current = true;
    }
  }, [activeTab]);

  useEffect(() => {
    if (contractData) {
      localStorage.setItem('assurecode_contract_data', JSON.stringify(contractData));
    } else {
      localStorage.removeItem('assurecode_contract_data');
    }
  }, [contractData]);

  /** Called when contract is locked in Phase 1 */
  const handleContractLocked = (data) => {
    setContractData(data);
  };

  /** Reset active contract */
  const handleResetContract = () => {
    if (window.confirm('Reset current contract workspace? This will clear active session state.')) {
      setContractData(null);
      setActiveTab('contract');
      localStorage.removeItem('assurecode_contract_data');
      localStorage.setItem('assurecode_active_tab', 'contract');
    }
  };

  /** Helper navigation functions */
  const navigateTo = (tab) => {
    setActiveTab(tab);
    setIsMobileMenuOpen(false);
  };

  const navItems = [
    { id: 'contract', label: '01. Contract Initialization', shortLabel: '01. Contract', icon: FileText, disabled: false },
    { id: 'verification', label: '02. CI/CD Verification', shortLabel: '02. Verification', icon: Activity, disabled: !contractData },
    { id: 'xai', label: '03. XAI Trust Score', shortLabel: '03. Trust Score', icon: BrainCircuit, disabled: !contractData },
    { id: 'escrow', label: '04. Escrow Settlement', shortLabel: '04. Escrow', icon: Lock, disabled: !contractData },
  ];

  return (
    <div className="min-h-screen bg-ink text-prose flex flex-col font-sans max-w-full overflow-x-hidden selection:bg-signal/20 selection:text-prose">
      {/* ── Monochrome Dense Instrumentation Rail ─────────────────── */}
      <header className="bg-ink border-b border-rule py-2 px-4 sm:px-6 font-mono text-[11px] text-prose-muted flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="font-bold text-prose tracking-wider flex items-center gap-1.5">
            ASSURECODE <span className="text-signal">▮</span> TRUST-CODE 2.0
          </span>
          <span className="hidden sm:inline text-rule-hi">│</span>
          <span className="hidden sm:inline text-prose-muted">
            chain:<span className="text-prose font-medium">{contractData?.hash ? `${contractData.hash.slice(0, 10)}…${contractData.hash.slice(-4)}` : '0x7f3a…ecc1'}</span>
          </span>
        </div>

        <div className="flex items-center gap-4">
          <span className="hidden md:inline text-prose-muted">
            NIST ML-DSA <span className="text-signal">✓</span>
          </span>
          <span className="hidden md:inline text-rule-hi">│</span>
          <span className="text-prose-muted">
            session:<span className="text-prose">{sessionTime}</span>
          </span>
        </div>
      </header>

      {/* ── Main Navigation Bar ─────────────────────────────── */}
      <nav className="bg-ink-2 border-b border-rule sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          {/* Brand Wordmark & Status */}
          <div className="flex items-center gap-4">
            <span className="font-display text-lg font-semibold tracking-tight text-prose">
              AssureCode <span className="font-mono text-xs font-normal text-prose-muted ml-2">/ AUDIT LEDGER</span>
            </span>
          </div>

          {/* Desktop Phase Tabs */}
          <div className="hidden md:flex items-center h-full">
            {navItems.map((item) => {
              const isActive = activeTab === item.id;

              return (
                <button
                  key={item.id}
                  id={`nav-phase-${item.id}`}
                  onClick={() => !item.disabled && navigateTo(item.id)}
                  disabled={item.disabled}
                  className={`h-14 px-4 font-mono text-xs font-medium flex items-center gap-2 border-b-2 transition-colors ${
                    isActive
                      ? 'border-signal text-prose bg-ink-3/40'
                      : item.disabled
                      ? 'border-transparent text-prose-dim cursor-not-allowed opacity-40'
                      : 'border-transparent text-prose-muted hover:text-prose hover:border-rule-hi'
                  }`}
                >
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>

          {/* Actions: Reset & Status */}
          <div className="flex items-center gap-3">
            {contractData && (
              <button
                onClick={handleResetContract}
                className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 font-mono text-xs text-prose-muted hover:text-fail border border-rule hover:border-fail/50 transition-colors"
                title="Reset active contract workspace"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>[reset]</span>
              </button>
            )}

            <div className="flex items-center gap-2 px-2.5 py-1 font-mono text-xs border border-rule bg-ink">
              <span className="w-1.5 h-1.5 rounded-full bg-signal animate-data-tick" />
              <span className="text-signal tracking-wider font-semibold">LOCKED</span>
            </div>

            {/* Mobile Drawer Toggle */}
            <button
              id="btn-mobile-menu"
              onClick={() => setIsMobileMenuOpen(true)}
              className="md:hidden p-1.5 text-prose-muted hover:text-prose border border-rule"
              aria-label="Toggle Navigation Drawer"
            >
              <Menu className="w-5 h-5" />
            </button>
          </div>
        </div>
      </nav>

      {/* ── Mobile Navigation Drawer ────────────────────────── */}
      <MobileDrawer
        isOpen={isMobileMenuOpen}
        onClose={() => setIsMobileMenuOpen(false)}
        title="AUDIT LEDGER NAVIGATION"
        subtitle="4-Phase Pipeline"
        position="right"
      >
        <div className="space-y-1 py-2 font-mono text-xs">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;

            return (
              <button
                key={item.id}
                onClick={() => !item.disabled && navigateTo(item.id)}
                disabled={item.disabled}
                className={`w-full p-3 text-left font-medium flex items-center justify-between border ${
                  isActive
                    ? 'border-signal text-signal bg-ink-3'
                    : item.disabled
                    ? 'border-rule text-prose-dim opacity-40 cursor-not-allowed'
                    : 'border-rule text-prose-muted hover:text-prose hover:border-rule-hi'
                }`}
              >
                <span>{item.label}</span>
                <ChevronRight className="w-4 h-4 text-prose-muted" />
              </button>
            );
          })}
        </div>
      </MobileDrawer>

      {/* ── Main Viewport Content ──────────────────────────── */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
        {/* Active Contract Info Banner (Phases 2 - 4) */}
        {contractData && activeTab !== 'contract' && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8 p-4 bg-ink-2 border border-rule font-mono text-xs flex flex-wrap items-center justify-between gap-4"
          >
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-4 h-4 text-signal shrink-0" />
              <div>
                <span className="text-prose font-semibold">
                  ACTIVE CONTRACT: {contractData.title || contractData.contractId}
                </span>
                <div className="text-prose-muted text-[11px] mt-0.5">
                  ID: {contractData.contractId} │ HASH: <span className="text-signal">{contractData.hash ? `${contractData.hash.slice(0, 16)}…` : '—'}</span>
                </div>
              </div>
            </div>
            <button
              onClick={() => navigateTo('contract')}
              className="px-3 py-1 text-xs font-mono text-prose-muted hover:text-prose border border-rule hover:border-prose-muted transition-colors"
            >
              [edit specs]
            </button>
          </motion.div>
        )}

        {/* Tab View Routing Container */}
        <AnimatePresence mode="wait">
          {activeTab === 'contract' && (
            <motion.div
              key="contract"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <ContractInitialization
                onContractLocked={handleContractLocked}
                contractData={contractData}
                onProceedToPhase2={() => navigateTo('verification')}
              />
            </motion.div>
          )}

          {activeTab === 'verification' && (
            <motion.div
              key="verification"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <VerificationDashboard
                contractData={contractData}
                onBack={() => navigateTo('contract')}
                onNextPhase={() => navigateTo('xai')}
              />
            </motion.div>
          )}

          {activeTab === 'xai' && (
            <motion.div
              key="xai"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <XaiTrustScoreView
                contractData={contractData}
                onProceedToEscrow={() => navigateTo('escrow')}
              />
            </motion.div>
          )}

          {activeTab === 'escrow' && (
            <motion.div
              key="escrow"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <EscrowSettlementView
                contractData={contractData}
                onResetWorkflow={handleResetContract}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* ── Monochrome Instrumentation Footer ─────────────────── */}
      <footer className="bg-ink-2 border-t border-rule py-3 px-4 text-xs font-mono text-prose-muted mt-auto">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>ASSURECODE AUDIT LEDGER INSTRUMENTATION © 2026</span>
          <div className="flex items-center gap-4">
            <span>MERKLE HASH CHAIN ACTIVE</span>
            <span>│</span>
            <span>NIST ML-DSA POST-QUANTUM SIGNED</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;

