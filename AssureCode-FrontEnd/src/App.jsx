import React from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { Header } from './components/common/Header';
import { Sidebar } from './components/common/Sidebar';
import { ClientDashboard } from './views/ClientDashboard';
import { FreelancerDashboard } from './views/FreelancerDashboard';
import { ContractWorkspaceView } from './views/ContractWorkspaceView';
import { CISandboxView } from './components/sandbox/CISandboxView';
import { ScopeGuardChat } from './components/scope/ScopeGuardChat';
import { TrustScoreGauge } from './components/escrow/TrustScoreGauge';
import { OracleSettlementCard } from './components/escrow/OracleSettlementCard';
import { LedgerAuditView } from './views/LedgerAuditView';
import { ContractWizard } from './components/contracts/ContractWizard';
import { CryptographicProofModal } from './components/ledger/CryptographicProofModal';
import { AmendmentModal } from './components/scope/AmendmentModal';
import { GuidedDemoTour } from './components/demo/GuidedDemoTour';

function AppContent() {
  const { activeTab, role, trustScoreData } = useApp();

  const renderContent = () => {
    switch (activeTab) {
      case 'OVERVIEW':
        if (role === 'CLIENT') return <ClientDashboard />;
        if (role === 'FREELANCER') return <FreelancerDashboard />;
        return <LedgerAuditView />;
      case 'NEW_CONTRACT':
        return <ContractWizard />;
      case 'WORKSPACE':
        return <ContractWorkspaceView />;
      case 'CI_SANDBOX':
        return <CISandboxView />;
      case 'SCOPE_CHAT':
        return <ScopeGuardChat />;
      case 'SETTLEMENT':
        return (
          <div className="space-y-6">
            <TrustScoreGauge trustScoreData={trustScoreData} />
            <OracleSettlementCard />
          </div>
        );
      case 'LEDGER':
        return <LedgerAuditView />;
      default:
        return <ClientDashboard />;
    }
  };

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-white">
      <Header />
      
      <div className="flex flex-1">
        <Sidebar />

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full overflow-x-hidden">
          {renderContent()}
        </main>
      </div>

      {/* Global Modals & Guided Walkthrough */}
      <CryptographicProofModal />
      <AmendmentModal />
      <GuidedDemoTour />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
