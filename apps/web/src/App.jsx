import { useState, useEffect } from 'react';
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
  LogOut,
} from 'lucide-react';

import ContractInitialization from './components/ContractInitialization';
import FreelancerAssignments from './components/FreelancerAssignments';
import ClientNotifications from './components/ClientNotifications';
import VerificationDashboard from './components/VerificationDashboard';
import XaiTrustScoreView from './components/XaiTrustScoreView';
import EscrowSettlementView from './components/EscrowSettlementView';
import MobileDrawer from './components/ui/MobileDrawer';
import LoginScreen from './components/LoginScreen';
import GithubCallback from './components/GithubCallback';
import ConnectReturn from './components/ConnectReturn';
import { ChainBadge, SignatureBadge } from './components/ui/LedgerBadges';
import { useLedgerStatus } from './hooks/useLedgerStatus';
import { useAuth } from './context/AuthContext';

/** Shared fade used by every phase panel, so they stay in step with each other. */
const PHASE_TRANSITION = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.15 },
};

function formatClockTime() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function desktopTabClasses(isActive, isDisabled) {
  const base = 'h-14 px-4 font-mono text-xs font-medium flex items-center gap-2 border-b-2 transition-colors';
  if (isActive) return `${base} border-signal text-prose bg-ink-3/40`;
  if (isDisabled) return `${base} border-transparent text-prose-dim cursor-not-allowed opacity-40`;
  return `${base} border-transparent text-prose-muted hover:text-prose hover:border-rule-hi`;
}

function drawerTabClasses(isActive, isDisabled) {
  const base = 'w-full p-3 text-left font-medium flex items-center justify-between border';
  if (isActive) return `${base} border-signal text-signal bg-ink-3`;
  if (isDisabled) return `${base} border-rule text-prose-dim opacity-40 cursor-not-allowed`;
  return `${base} border-rule text-prose-muted hover:text-prose hover:border-rule-hi`;
}

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
  const { user, isAuthenticated, isLoading, logout } = useAuth();

  // Navigation active tab state: 'contract' | 'verification' | 'xai' | 'escrow'
  const [activeTab, setActiveTab] = useState(() => {
    return localStorage.getItem('assurecode_active_tab') || 'contract';
  });

  // Shared contract data passed across all 4 phases
  const [contractData, setContractData] = useState(() => {
    const saved = localStorage.getItem('assurecode_contract_data');
    return saved ? JSON.parse(saved) : null;
  });

  // What the footer badges are allowed to claim about the ledger. Fetched
  // rather than assumed — see hooks/useLedgerStatus.
  const ledgerStatus = useLedgerStatus(contractData?.contractId);

  // Live session timer state
  const [sessionTime, setSessionTime] = useState(formatClockTime);

  useEffect(() => {
    const interval = setInterval(() => setSessionTime(formatClockTime()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Mobile navigation drawer toggle state
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Synchronize state persistence to localStorage
  useEffect(() => {
    localStorage.setItem('assurecode_active_tab', activeTab);
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

  /** Called when a freelancer picks an assignment from their list */
  const handleAssignmentSelected = (contract) => {
    setContractData(contract);
    navigateTo('verification');
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

  // Only clients post contracts; freelancers are assigned to them. A
  // freelancer landing on Phase 1 would just hit a 403 from the gateway, so
  // the tab is disabled here instead of failing after a full form fill-out.
  const isClient = user?.role === 'client';

  const navItems = [
    { id: 'contract', label: '01. Contract Initialization', shortLabel: '01. Contract', icon: FileText, disabled: !isClient },
    { id: 'verification', label: '02. CI/CD Verification', shortLabel: '02. Verification', icon: Activity, disabled: !contractData },
    { id: 'xai', label: '03. XAI Trust Score', shortLabel: '03. Trust Score', icon: BrainCircuit, disabled: !contractData },
    { id: 'escrow', label: '04. Escrow Settlement', shortLabel: '04. Escrow', icon: Lock, disabled: !contractData },
  ];

  // No router in this app — GitHub and payout-onboarding redirects both land
  // here as real page navigations, so these paths are checked ahead of the
  // loading/auth gates rather than through a route table.
  if (window.location.pathname === '/auth/github/callback') {
    return <GithubCallback />;
  }

  if (window.location.pathname === '/connect/return' || window.location.pathname === '/connect/refresh') {
    return <ConnectReturn />;
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-ink text-prose-muted flex items-center justify-center font-mono text-xs">
        Loading session...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

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
            {navItems.map((item) => (
              <button
                key={item.id}
                id={`nav-phase-${item.id}`}
                onClick={() => !item.disabled && navigateTo(item.id)}
                disabled={item.disabled}
                className={desktopTabClasses(activeTab === item.id, item.disabled)}
              >
                <span>{item.label}</span>
              </button>
            ))}
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

            {isClient && <ClientNotifications />}

            <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 font-mono text-xs border border-rule bg-ink text-prose-muted">
              <span className="text-prose">{user?.displayName || user?.email}</span>
              <span className="text-prose-dim">·</span>
              <span className="uppercase text-prose-dim">{user?.role}</span>
            </div>

            <button
              id="btn-logout"
              onClick={logout}
              className="flex items-center gap-1.5 px-2.5 py-1 font-mono text-xs text-prose-muted hover:text-fail border border-rule hover:border-fail/50 transition-colors"
              title="Sign out"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">[sign out]</span>
            </button>

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
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => !item.disabled && navigateTo(item.id)}
              disabled={item.disabled}
              className={drawerTabClasses(activeTab === item.id, item.disabled)}
            >
              <span>{item.label}</span>
              <ChevronRight className="w-4 h-4 text-prose-muted" />
            </button>
          ))}
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
          {activeTab === 'contract' && isClient && (
            <motion.div key="contract" {...PHASE_TRANSITION}>
              <ContractInitialization
                onContractLocked={handleContractLocked}
                contractData={contractData}
                onProceedToPhase2={() => navigateTo('verification')}
                onProceedToEscrow={() => navigateTo('escrow')}
              />
            </motion.div>
          )}

          {activeTab === 'contract' && !isClient && (
            <motion.div key="freelancer-landing" {...PHASE_TRANSITION}>
              <FreelancerAssignments onSelectContract={handleAssignmentSelected} />
            </motion.div>
          )}

          {activeTab === 'verification' && (
            <motion.div key="verification" {...PHASE_TRANSITION}>
              <VerificationDashboard
                contractData={contractData}
                onBack={() => navigateTo('contract')}
                onNextPhase={() => navigateTo('xai')}
              />
            </motion.div>
          )}

          {activeTab === 'xai' && (
            <motion.div key="xai" {...PHASE_TRANSITION}>
              <XaiTrustScoreView
                contractData={contractData}
                onProceedToEscrow={() => navigateTo('escrow')}
              />
            </motion.div>
          )}

          {activeTab === 'escrow' && (
            <motion.div key="escrow" {...PHASE_TRANSITION}>
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
          {/* Read from the ledger, not asserted. See components/ui/LedgerBadges. */}
          <div className="flex items-center gap-4">
            <ChainBadge status={ledgerStatus} />
            <span>│</span>
            <SignatureBadge status={ledgerStatus} />
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;

