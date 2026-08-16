import React, { createContext, useContext, useState, useEffect } from 'react';
import { MOCK_CONTRACTS } from '../data/mockContracts';
import { MOCK_FREELANCERS } from '../data/mockFreelancers';
import { MOCK_LEDGER_BLOCKS } from '../data/mockLedgerBlocks';
import { MOCK_AST_METRICS, MOCK_OWASP_REPORT, MOCK_HIDDEN_TESTS, MOCK_SANDBOX_LOGS } from '../data/mockAuditTelemetry';
import { MerkleTree, computeBlockHash, canonicalizeJson } from '../utils/cryptoUtils';
import { evaluateScopeMessage, getSimulatedEmbedding, computeCosineSimilarity } from '../utils/scopeGuardEngine';
import { calculateTrustScore } from '../utils/trustScoreModel';
import confetti from 'canvas-confetti';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  // Current user perspective: 'CLIENT' | 'FREELANCER' | 'AUDITOR'
  const [role, setRole] = useState('CLIENT');

  // Navigation tab: 'OVERVIEW' | 'NEW_CONTRACT' | 'WORKSPACE' | 'CI_SANDBOX' | 'SCOPE_CHAT' | 'SETTLEMENT' | 'LEDGER'
  const [activeTab, setActiveTab] = useState('OVERVIEW');

  // All contracts
  const [contracts, setContracts] = useState(MOCK_CONTRACTS);
  const [selectedContractId, setSelectedContractId] = useState(MOCK_CONTRACTS[0].id);

  // Freelancer talent pool
  const [freelancers, setFreelancers] = useState(MOCK_FREELANCERS);

  // Cryptographic Ledger (PostgreSQL Hash Chain)
  const [ledgerBlocks, setLedgerBlocks] = useState(MOCK_LEDGER_BLOCKS);

  // Active Contract Telemetry & State
  const [astMetrics, setAstMetrics] = useState(MOCK_AST_METRICS);
  const [owaspReport, setOwaspReport] = useState(MOCK_OWASP_REPORT);
  const [hiddenTests, setHiddenTests] = useState(MOCK_HIDDEN_TESTS);
  const [sandboxLogs, setSandboxLogs] = useState(MOCK_SANDBOX_LOGS);
  const [isSandboxRunning, setIsSandboxRunning] = useState(false);
  const [sandboxProgress, setSandboxProgress] = useState(100);

  // Notifications
  const [notifications, setNotifications] = useState([
    {
      id: 'notif-1',
      title: 'Deterministic Trust Score: 94.2/100',
      message: 'Zero-Trust CI verification passed with 0 critical OWASP findings.',
      type: 'success',
      timestamp: '10m ago'
    },
    {
      id: 'notif-2',
      title: 'Ledger Block #5 Appended',
      message: 'Scope Guard verified chat history anchored to Genesis Hash.',
      type: 'info',
      timestamp: '25m ago'
    }
  ]);

  // Modals & Visualizers
  const [isProofModalOpen, setIsProofModalOpen] = useState(false);
  const [selectedProofData, setSelectedProofData] = useState(null);
  const [isAmendmentModalOpen, setIsAmendmentModalOpen] = useState(false);
  const [isSettlementModalOpen, setIsSettlementModalOpen] = useState(false);
  const [guidedTourStep, setGuidedTourStep] = useState(null); // null or 0..5

  // Get active contract object
  const activeContract = contracts.find(c => c.id === selectedContractId) || contracts[0];

  // Derived Trust Score
  const trustScoreData = calculateTrustScore({
    totalTests: activeContract.telemetry?.testsTotal || 8,
    passedTests: activeContract.telemetry?.testsPassed || 8,
    maintainabilityIndex: activeContract.telemetry?.maintainabilityIndex || 91.4,
    cyclomaticComplexity: activeContract.telemetry?.cyclomaticComplexityAvg || 3.8,
    securityVulnerabilities: activeContract.telemetry?.owaspFindings || { critical: 0, high: 0, medium: 1, low: 2 },
    scopeComplianceRate: activeContract.telemetry?.scopeComplianceRate || 0.96
  });

  const addNotification = (notif) => {
    setNotifications(prev => [
      { id: `notif-${Date.now()}`, timestamp: 'Just now', ...notif },
      ...prev.slice(0, 19)
    ]);
  };

  // Switch Active Contract
  const switchContract = (contractId) => {
    setSelectedContractId(contractId);
  };

  /**
   * Append a new block to the PostgreSQL Hash Chain Ledger
   */
  const appendLedgerBlock = async (eventType, payload, signer = 'system:assurecode-oracle') => {
    const lastBlock = ledgerBlocks[ledgerBlocks.length - 1];
    const prevHash = lastBlock ? lastBlock.blockHash : '0x0000000000000000000000000000000000000000000000000000000000000000';
    const sequenceNumber = ledgerBlocks.length;
    const timestamp = new Date().toISOString();
    const merkleRoot = activeContract?.merkleRoot || lastBlock?.merkleRoot || '0x44d8201948271039582910492847192847192847192847192847192847192847';

    const blockHash = await computeBlockHash({
      prevHash,
      sequenceNumber,
      timestamp,
      eventType,
      merkleRoot,
      payload
    });

    const newBlock = {
      sequenceNumber,
      blockHash,
      prevHash,
      eventType,
      timestamp,
      merkleRoot,
      signer,
      signature: `sig_ed25519_${Math.random().toString(36).substring(2, 10)}...${Math.random().toString(36).substring(2, 6)}`,
      payload
    };

    setLedgerBlocks(prev => [...prev, newBlock]);
    addNotification({
      title: `New Ledger Block #${sequenceNumber}: ${eventType}`,
      message: `Appended with Merkle Root: ${merkleRoot.slice(0, 10)}...`,
      type: 'info'
    });

    return newBlock;
  };

  /**
   * Trigger a simulated GitHub push and Ephemeral CI Sandbox run
   */
  const triggerPushAndCISandbox = async () => {
    if (isSandboxRunning) return;
    setIsSandboxRunning(true);
    setSandboxProgress(0);
    setSandboxLogs([
      `[SANDBOX:INIT] Ingested GitHub commit ${Math.random().toString(36).substring(2, 9)} (HMAC SHA-256 Verified)...`,
      `[SANDBOX:ISOLATION] Spawning Ephemeral Docker Sandbox (network: NONE, memory: 512MB)...`
    ]);

    const logSteps = [
      { progress: 20, log: '[SANDBOX:AST] AST Parsing 14 source files: McCabe Avg 3.8, Halstead Vol 3097.4, SEI MI: 91.4' },
      { progress: 45, log: '[SANDBOX:TEST] Injecting 8 Cloudflare Workers AI hidden test suites in read-only mode...' },
      { progress: 70, log: '[SANDBOX:TEST] 8/8 Hidden test suites PASSED. Execution duration: 210ms' },
      { progress: 85, log: '[SANDBOX:SECURITY] Dual-Layer OWASP 2025 Audit: 0 Critical, 0 High vulnerabilities detected.' },
      { progress: 100, log: '[SANDBOX:SUCCESS] Zero-Trust CI verification completed! Deterministic Trust Score: 94.2/100' }
    ];

    for (let i = 0; i < logSteps.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 600));
      setSandboxProgress(logSteps[i].progress);
      setSandboxLogs(prev => [...prev, logSteps[i].log]);
    }

    setIsSandboxRunning(false);

    // Update contract status & append to ledger
    setContracts(prev => prev.map(c => {
      if (c.id === activeContract.id) {
        return {
          ...c,
          status: 'CI_VERIFIED',
          telemetry: {
            ...c.telemetry,
            testsPassed: 8,
            deterministicTrustScore: 94.2
          }
        };
      }
      return c;
    }));

    await appendLedgerBlock('ZERO_TRUST_CI_VERIFIED', {
      contractId: activeContract.id,
      branch: activeContract.contractBranch,
      testsPassed: '8/8 (100%)',
      maintainabilityIndex: 91.4,
      owaspCriticalCount: 0,
      sandboxRunner: 'docker-ephemeral-sandbox-v2'
    }, 'worker:ci-ephemeral-sandbox');

    addNotification({
      title: 'Zero-Trust CI Pipeline Passed',
      message: 'Hidden tests & OWASP audit cleared. Contract ready for settlement.',
      type: 'success'
    });
  };

  /**
   * Send a chat message through Autonomous Scope Guard
   */
  const sendChatMessage = async (text, senderOverride) => {
    const sender = senderOverride || (role === 'CLIENT' ? 'client' : 'freelancer');
    const senderName = sender === 'client' ? activeContract.client.name : activeContract.freelancer.name;
    const avatar = sender === 'client' ? activeContract.client.avatar : activeContract.freelancer.avatar;

    // Run Scope Guard Evaluation against Contract
    const scopeResult = evaluateScopeMessage(text, activeContract);

    const newMessage = {
      id: `msg-${Date.now()}`,
      sender,
      senderName,
      avatar,
      text,
      timestamp: new Date().toISOString(),
      scopeResult
    };

    setContracts(prev => prev.map(c => {
      if (c.id === activeContract.id) {
        return {
          ...c,
          chatMessages: [...(c.chatMessages || []), newMessage]
        };
      }
      return c;
    }));

    if (!scopeResult.allowed) {
      addNotification({
        title: '⚠️ Scope Creep Warning Detected',
        message: `Message similarity ${(scopeResult.bestSimilarity * 100).toFixed(1)}% < 27.31% threshold. Amendment suggested.`,
        type: 'warning'
      });
    } else {
      addNotification({
        title: 'Scope Guard Verified',
        message: `Cosine similarity ${(scopeResult.bestSimilarity * 100).toFixed(1)}% verified against genesis anchor.`,
        type: 'success'
      });
    }

    return newMessage;
  };

  /**
   * Settle Escrow Payment via Oracle evaluation & Stripe capture
   */
  const executeSettlement = async () => {
    if (!trustScoreData.isApproved) {
      addNotification({
        title: 'Settlement Blocked by Oracle',
        message: trustScoreData.blockers.join(' '),
        type: 'error'
      });
      return false;
    }

    // Single-fire settlement state change
    setContracts(prev => prev.map(c => {
      if (c.id === activeContract.id) {
        return {
          ...c,
          status: 'SETTLED',
          escrowStatus: 'CAPTURED'
        };
      }
      return c;
    }));

    // Trigger celebratory confetti
    try {
      confetti({
        particleCount: 120,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#6366f1', '#10b981', '#06b6d4', '#f59e0b']
      });
    } catch (e) {
      // ignore in test env
    }

    // Finalize on ledger
    await appendLedgerBlock('SETTLEMENT_COMPLETED', {
      contractId: activeContract.id,
      amountCaptured: `$${activeContract.budget}.00 ${activeContract.currency}`,
      recipient: activeContract.freelancer.name,
      stripePaymentIntentId: activeContract.escrowPaymentIntentId,
      finalTrustScore: trustScoreData.score,
      settlementOracleRule: 'SCORE_GE_85_AND_CRITICAL_EQ_0'
    }, 'oracle:assurecode-settlement-worker');

    addNotification({
      title: '🎉 Escrow Settled & Released!',
      message: `Stripe PaymentIntent ${activeContract.escrowPaymentIntentId} captured. Ledger finalized.`,
      type: 'success'
    });

    return true;
  };

  /**
   * Create a new Contract and Lock Requirements into Merkle Tree & Ledger
   */
  const createAndLockContract = async ({ title, budget, deadline, requirements, freelancerId }) => {
    const selectedFreelancer = freelancers.find(f => f.id === freelancerId) || freelancers[0];
    
    // Build Merkle Tree over requirements
    const merkleTree = new MerkleTree(requirements.map(r => `${r.title}: ${r.description}`));
    const merkleRoot = await merkleTree.build();

    const newContractId = `ac-contract-${Math.floor(1000 + Math.random() * 9000)}`;
    const genesisHash = await computeBlockHash({
      prevHash: ledgerBlocks[ledgerBlocks.length - 1]?.blockHash || '0x0',
      sequenceNumber: ledgerBlocks.length,
      timestamp: new Date().toISOString(),
      eventType: 'CONTRACT_LOCKED',
      merkleRoot,
      payload: { newContractId, title, budget, requirementsCount: requirements.length }
    });

    const newContract = {
      id: newContractId,
      title,
      client: {
        id: 'client-881',
        name: 'Apex Fintech Solutions',
        contact: 'Sarah Jenkins',
        avatar: 'https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?w=150&auto=format&fit=crop&q=80',
        rating: 4.95,
        totalSpend: '$148,000'
      },
      freelancer: selectedFreelancer,
      status: 'LOCKED',
      budget: Number(budget),
      currency: 'USD',
      escrowPaymentIntentId: `pi_3P${Math.random().toString(36).substring(2, 18).toUpperCase()}`,
      escrowStatus: 'HELD_IN_ESCROW',
      deadline,
      createdAt: new Date().toISOString(),
      lockedAt: new Date().toISOString(),
      genesisLedgerHash: genesisHash,
      contractLockedHash: genesisHash,
      merkleRoot,
      repositoryUrl: `https://github.com/apex-fintech/${title.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      contractBranch: `contract/${newContractId}-main`,
      requirements: requirements.map((r, i) => ({
        id: `req-${i + 1}`,
        title: r.title,
        description: r.description,
        weight: 1.2,
        techStack: r.techStack || 'TypeScript / Docker / Postgres',
        status: 'PENDING_PUSH'
      })),
      deliverables: [
        'Production grade codebase with 100% hidden test pass rate',
        'Deterministic AST Maintainability report (MI >= 85)',
        'Zero critical OWASP security vulnerabilities'
      ],
      telemetry: {
        testsTotal: 6,
        testsPassed: 0,
        maintainabilityIndex: 0,
        cyclomaticComplexityAvg: 0,
        owaspFindings: { critical: 0, high: 0, medium: 0, low: 0 },
        scopeComplianceRate: 1.0,
        deterministicTrustScore: 0
      },
      chatMessages: [
        {
          id: `msg-${Date.now()}`,
          sender: 'client',
          senderName: 'Sarah Jenkins',
          avatar: 'https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?w=150&auto=format&fit=crop&q=80',
          text: `Welcome ${selectedFreelancer.name}! Contract requirements have been cryptographically locked into Merkle Root ${merkleRoot.slice(0, 10)}... and escrow is funded.`,
          timestamp: new Date().toISOString(),
          scopeResult: {
            allowed: true,
            bestSimilarity: 0.95,
            explanation: 'Contract Genesis Message. Anchored to Merkle Root.'
          }
        }
      ]
    };

    setContracts(prev => [newContract, ...prev]);
    setSelectedContractId(newContractId);

    // Append to Ledger
    await appendLedgerBlock('CONTRACT_LOCKED', {
      contractId: newContractId,
      title,
      freelancer: selectedFreelancer.name,
      budget: `$${budget} USD`,
      merkleRoot
    }, 'multisig:client+freelancer');

    addNotification({
      title: 'Contract Initialized & Locked',
      message: `Merkle Root ${merkleRoot.slice(0, 12)}... pinned to Postgres ledger.`,
      type: 'success'
    });

    return newContract;
  };

  /**
   * Submit an out-of-scope Contract Amendment
   */
  const submitAmendment = async ({ title, addedScope, budgetAdjustment, deadlineExtension }) => {
    const updatedBudget = activeContract.budget + Number(budgetAdjustment || 0);
    const newRequirement = {
      id: `req-${(activeContract.requirements?.length || 0) + 1}`,
      title: `[Amendment] ${title}`,
      description: addedScope,
      weight: 1.0,
      techStack: 'As specified in amendment',
      status: 'AMENDED'
    };

    const newRequirementsList = [...(activeContract.requirements || []), newRequirement];
    const merkleTree = new MerkleTree(newRequirementsList.map(r => `${r.title}: ${r.description}`));
    const newMerkleRoot = await merkleTree.build();

    setContracts(prev => prev.map(c => {
      if (c.id === activeContract.id) {
        return {
          ...c,
          budget: updatedBudget,
          merkleRoot: newMerkleRoot,
          requirements: newRequirementsList
        };
      }
      return c;
    }));

    await appendLedgerBlock('CONTRACT_AMENDED', {
      contractId: activeContract.id,
      amendmentTitle: title,
      budgetDelta: `+$${budgetAdjustment}`,
      newMerkleRoot
    }, 'multisig:client+freelancer+oracle');

    addNotification({
      title: 'Contract Amendment Executed',
      message: `Scope added. Merkle Root re-anchored: ${newMerkleRoot.slice(0, 10)}...`,
      type: 'success'
    });

    setIsAmendmentModalOpen(false);
  };

  return (
    <AppContext.Provider
      value={{
        role,
        setRole,
        activeTab,
        setActiveTab,
        contracts,
        selectedContractId,
        switchContract,
        activeContract,
        freelancers,
        ledgerBlocks,
        astMetrics,
        owaspReport,
        hiddenTests,
        sandboxLogs,
        isSandboxRunning,
        sandboxProgress,
        trustScoreData,
        notifications,
        addNotification,
        triggerPushAndCISandbox,
        sendChatMessage,
        executeSettlement,
        createAndLockContract,
        submitAmendment,
        isProofModalOpen,
        setIsProofModalOpen,
        selectedProofData,
        setSelectedProofData,
        isAmendmentModalOpen,
        setIsAmendmentModalOpen,
        isSettlementModalOpen,
        setIsSettlementModalOpen,
        guidedTourStep,
        setGuidedTourStep
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
