import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT_DIR, 'apps', 'web');
const SRC_DIR = path.join(WEB_DIR, 'src');

console.log('====================================================');
console.log('   AssureCode Frontend Upgrade Verification Runner  ');
console.log('====================================================\n');

let totalPassed = 0;
let totalFailed = 0;

const results = {
  tier1: { name: 'Tier 1: Build Validation', passed: false, details: [] },
  tier2: { name: 'Tier 2: Pure JS/JSX Compliance', passed: false, details: [] },
  tier3: { name: 'Tier 3: Component Structure & Responsiveness', passed: false, details: [] },
  tier4: { name: 'Tier 4: Application Scenarios & State Persistence', passed: false, details: [] },
};

function logHeader(title) {
  console.log(`\n----------------------------------------------------`);
  console.log(` ${title}`);
  console.log(`----------------------------------------------------`);
}

function recordResult(tierKey, ok, message) {
  if (ok) {
    results[tierKey].details.push(`[PASS] ${message}`);
    console.log(`  ✓ ${message}`);
  } else {
    results[tierKey].details.push(`[FAIL] ${message}`);
    console.log(`  ✗ ${message}`);
  }
}

// ----------------------------------------------------
// TIER 1: Build Validation
// ----------------------------------------------------
logHeader('TIER 1: Build Pipeline Validation');
try {
  console.log('  Executing npm run build:web ...');
  const viteBin = path.join(ROOT_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  execSync(`node "${viteBin}" build`, {
    cwd: WEB_DIR,
    stdio: 'ignore'
  });
  recordResult('tier1', true, 'npm run build:web executed successfully with exit code 0');

  const distDir = path.join(WEB_DIR, 'dist');
  const indexHtml = path.join(distDir, 'index.html');
  const assetsDir = path.join(distDir, 'assets');

  if (fs.existsSync(distDir) && fs.existsSync(indexHtml)) {
    recordResult('tier1', true, `Build output dist directory and index.html exist (${indexHtml})`);
  } else {
    recordResult('tier1', false, `Build artifact index.html missing at ${indexHtml}`);
  }

  if (fs.existsSync(assetsDir) && fs.readdirSync(assetsDir).length > 0) {
    recordResult('tier1', true, `Bundled web assets found in ${assetsDir}`);
  } else {
    recordResult('tier1', false, `No bundled assets found in ${assetsDir}`);
  }
} catch (err) {
  const errorMsg = err.stderr || err.stdout || err.message;
  recordResult('tier1', false, `Build failed: ${errorMsg.split('\n')[0]}`);
}

// ----------------------------------------------------
// TIER 2: Pure JS/JSX Compliance Check
// ----------------------------------------------------
logHeader('TIER 2: Pure JS/JSX Compliance Check');

function getFilesRecursively(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const filePath = path.join(dir, file); // nosemgrep: path-join-resolve-traversal — dir is the constant SRC_DIR; file is from fs.readdirSync, not user input
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFilesRecursively(filePath));
    } else {
      results.push(filePath);
    }
  });
  return results;
}

const allSrcFiles = getFilesRecursively(SRC_DIR);
const tsFiles = allSrcFiles.filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));

if (tsFiles.length === 0) {
  recordResult('tier2', true, 'Zero .ts or .tsx files found in apps/web/src');
} else {
  recordResult('tier2', false, `Found ${tsFiles.length} TypeScript file(s) in apps/web/src:`);
  tsFiles.forEach(f => {
    const relPath = path.relative(ROOT_DIR, f);
    console.log(`    - ${relPath}`);
  });
}

// Verify index.html and vite config reference .jsx/.js entrypoint
const indexHtmlRoot = path.join(WEB_DIR, 'index.html');
if (fs.existsSync(indexHtmlRoot)) {
  const indexContent = fs.readFileSync(indexHtmlRoot, 'utf-8');
  if (indexContent.includes('.tsx') || indexContent.includes('.ts')) {
    recordResult('tier2', false, 'index.html contains references to TypeScript entry points (.ts / .tsx)');
  } else {
    recordResult('tier2', true, 'index.html references pure JavaScript/JSX entry point');
  }
} else {
  recordResult('tier2', false, 'apps/web/index.html not found');
}

// Verify no .ts/.tsx import references in .js/.jsx files
let tsImportViolations = [];
const jsFiles = allSrcFiles.filter(f => f.endsWith('.js') || f.endsWith('.jsx'));
jsFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf-8');
  if (/from\s+['"].*\.tsx?['"]/i.test(content) || /import\s+['"].*\.tsx?['"]/i.test(content)) {
    tsImportViolations.push(path.relative(ROOT_DIR, file));
  }
});

if (tsImportViolations.length === 0) {
  recordResult('tier2', true, 'No .js/.jsx files contain imports of .ts/.tsx extensions');
} else {
  recordResult('tier2', false, `Found ${tsImportViolations.length} file(s) importing .ts/.tsx files: ${tsImportViolations.join(', ')}`);
}

// ----------------------------------------------------
// TIER 3: Component Structure & Mobile Responsiveness
// ----------------------------------------------------
logHeader('TIER 3: Component Structure & Responsiveness Verification');

const requiredComponents = [
  { path: 'src/components/ContractInitialization.jsx', phase: 'Phase 1: Contract Initialization' },
  { path: 'src/components/VerificationDashboard.jsx', phase: 'Phase 2: Verification Dashboard' },
  { path: 'src/components/XaiTrustScoreView.jsx', phase: 'Phase 3: XAI Trust Score Evaluation' },
  { path: 'src/components/EscrowSettlementView.jsx', phase: 'Phase 4: Escrow & Settlement Status' },
  { path: 'src/components/ui/GlassCard.jsx', phase: 'UI Primitive: GlassCard' },
  { path: 'src/components/ui/StatusBadge.jsx', phase: 'UI Primitive: StatusBadge' },
  { path: 'src/components/ui/FuturisticButton.jsx', phase: 'UI Primitive: FuturisticButton' },
  { path: 'src/components/ui/RadialGauge.jsx', phase: 'UI Primitive: RadialGauge' },
  { path: 'src/components/ui/MobileDrawer.jsx', phase: 'UI Primitive: MobileDrawer' },
  { path: 'src/components/ui/ToastNotification.jsx', phase: 'UI Primitive: ToastNotification' },
  { path: 'src/App.jsx', phase: 'Main Application Component' },
  { path: 'src/main.jsx', phase: 'Application Mount Point' }
];

let missingComponents = [];
requiredComponents.forEach(comp => {
  const fullPath = path.join(WEB_DIR, comp.path); // nosemgrep: path-join-resolve-traversal — comp.path is from a hardcoded requiredComponents array
  if (fs.existsSync(fullPath)) {
    const content = fs.readFileSync(fullPath, 'utf-8');
    if (content.trim().length > 0) {
      // Check export default or component declaration
      if (/export\s+default/i.test(content) || /export\s+function/i.test(content) || /export\s+const/i.test(content)) {
        recordResult('tier3', true, `${comp.phase} present and exports standard component (${comp.path})`);
      } else {
        recordResult('tier3', false, `${comp.phase} missing default or named export (${comp.path})`);
      }
    } else {
      recordResult('tier3', false, `${comp.phase} file is empty (${comp.path})`);
    }
  } else {
    missingComponents.push(comp.path);
    recordResult('tier3', false, `${comp.phase} file missing (${comp.path})`);
  }
});

// Mobile Responsiveness checks (Drawer, responsive utilities, 375px viewport target)
const mobileDrawerPath = path.join(WEB_DIR, 'src/components/ui/MobileDrawer.jsx');
const appJsxPath = path.join(WEB_DIR, 'src/App.jsx');

if (fs.existsSync(mobileDrawerPath)) {
  const drawerContent = fs.readFileSync(mobileDrawerPath, 'utf-8');
  if (drawerContent.includes('AnimatePresence') || drawerContent.includes('motion') || drawerContent.includes('fixed') || drawerContent.includes('z-')) {
    recordResult('tier3', true, 'MobileDrawer implementation includes overlay animation / responsive positioning');
  } else {
    recordResult('tier3', false, 'MobileDrawer missing responsive modal/overlay structure');
  }
} else {
  recordResult('tier3', false, 'MobileDrawer component file missing');
}

if (fs.existsSync(appJsxPath)) {
  const appContent = fs.readFileSync(appJsxPath, 'utf-8');
  const hasResponsiveClasses = /md:|lg:|sm:|hidden|block/i.test(appContent);
  const hasMobileState = /mobile|drawer|menu|isopen|setisopen/i.test(appContent);
  
  if (hasResponsiveClasses && hasMobileState) {
    recordResult('tier3', true, 'App.jsx incorporates responsive layout hooks and mobile drawer toggle state');
  } else {
    recordResult('tier3', false, 'App.jsx missing mobile responsive hooks or drawer toggle integration');
  }
}

// ----------------------------------------------------
// TIER 4: Real-World Scenarios & State Persistence
// ----------------------------------------------------
logHeader('TIER 4: Real-World Application Scenarios & State Persistence');

// 1. Navigation Flow Check
if (fs.existsSync(appJsxPath)) {
  const appContent = fs.readFileSync(appJsxPath, 'utf-8');
  const hasContractTab = /['"]contract['"]/i.test(appContent);
  const hasVerificationTab = /['"]verification['"]/i.test(appContent);
  const hasXaiTab = /['"]xai['"]/i.test(appContent);
  const hasEscrowTab = /['"]escrow['"]/i.test(appContent);

  if (hasContractTab && hasVerificationTab && hasXaiTab && hasEscrowTab) {
    recordResult('tier4', true, 'App.jsx supports routing through all 4 core phases: contract, verification, xai, escrow');
  } else {
    recordResult('tier4', false, `App.jsx missing 4-phase route tabs (found: contract=${hasContractTab}, verification=${hasVerificationTab}, xai=${hasXaiTab}, escrow=${hasEscrowTab})`);
  }

  // 2. Shared State Persistence Check
  const hasSharedState = /contractData|activeTab|setActiveTab/i.test(appContent);
  const hasPersistence = /localStorage|sessionStorage|useEffect/i.test(appContent);

  if (hasSharedState) {
    recordResult('tier4', true, 'App.jsx manages shared contract state (activeTab, contractData) across view phases');
  } else {
    recordResult('tier4', false, 'App.jsx missing contractData / activeTab state management contract');
  }

  if (hasPersistence) {
    recordResult('tier4', true, 'App.jsx includes state persistence / side-effect synchronization');
  } else {
    recordResult('tier4', false, 'App.jsx missing state persistence mechanism across reloads/tab switches');
  }
} else {
  recordResult('tier4', false, 'App.jsx missing for Tier 4 evaluation');
}

// 3. Live-data compliance
//
// This block previously asserted that src/data/mockXaiData.js and
// mockEscrowData.js *existed*, and failed when they did not. Those modules were
// deleted when the views were pointed at real endpoints, so the harness was
// failing the build for having removed the fixtures it was written to guard.
// The assertion is inverted to match the design the project actually commits to:
// every phase view reads live data, and no view falls back to fabricated data
// when the backend is unavailable.

const legacyMockModules = ['src/data/mockXaiData.js', 'src/data/mockEscrowData.js'];
const survivingMocks = legacyMockModules.filter((rel) => fs.existsSync(path.join(WEB_DIR, rel)));

if (survivingMocks.length === 0) {
  recordResult('tier4', true, 'No mock data modules remain — all phase views read live endpoints');
} else {
  recordResult('tier4', false, `Mock data modules reintroduced: ${survivingMocks.join(', ')}`);
}

const PHASE_VIEWS = [
  ['ContractInitialization.jsx', 'Phase 1 (contract)'],
  ['VerificationDashboard.jsx', 'Phase 2 (verification)'],
  ['XaiTrustScoreView.jsx', 'Phase 3 (trust score)'],
  ['EscrowSettlementView.jsx', 'Phase 4 (escrow)'],
];

for (const [file, label] of PHASE_VIEWS) {
  const viewPath = path.join(WEB_DIR, 'src/components', file);
  if (!fs.existsSync(viewPath)) {
    recordResult('tier4', false, `${label}: ${file} missing`);
    continue;
  }

  const raw = fs.readFileSync(viewPath, 'utf-8');

  // Strip comments before scanning. VerificationDashboard.jsx documents the
  // removed Math.random() fallback in a comment explaining why it is gone;
  // matching that text would fail the file for describing the fix.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const callsBackend = /callApi\s*\(|apiRequest\s*\(|fetch\s*\(|new WebSocket\s*\(/.test(source);

  // Math.random() driving displayed telemetry is the specific defect this check
  // exists to catch: it makes an unreachable backend render as a passing audit.
  const fabricatesData = /Math\.random\s*\(/.test(source);

  if (callsBackend && !fabricatesData) {
    recordResult('tier4', true, `${label}: reads live data, no fabricated fallback`);
  } else if (!callsBackend) {
    recordResult('tier4', false, `${label}: makes no backend call — cannot be reading live data`);
  } else {
    recordResult('tier4', false, `${label}: contains Math.random() — displayed telemetry may be fabricated`);
  }
}


// ----------------------------------------------------
// VERIFICATION SUMMARY & EXIT CODE
// ----------------------------------------------------
logHeader('E2E VERIFICATION SUMMARY');

let allTiersPassed = true;

Object.keys(results).forEach(key => {
  const tier = results[key];
  const fails = tier.details.filter(d => d.startsWith('[FAIL]'));
  const passes = tier.details.filter(d => d.startsWith('[PASS]'));
  
  if (fails.length === 0 && passes.length > 0) {
    tier.passed = true;
    console.log(`  🟢 ${tier.name}: PASSED (${passes.length}/${tier.details.length} checks)`);
  } else {
    tier.passed = false;
    allTiersPassed = false;
    console.log(`  🔴 ${tier.name}: FAILED (${fails.length} failing checks out of ${tier.details.length})`);
  }
});

console.log('\n----------------------------------------------------');
if (allTiersPassed) {
  console.log('  🎉 ALL VERIFICATION TIERS PASSED SUCCESSFULLY!');
  console.log('----------------------------------------------------\n');
  process.exit(0);
} else {
  console.log('  ⚠️ VERIFICATION FAILED - ACTION REQUIRED BY IMPLEMENTATION AGENT');
  console.log('----------------------------------------------------\n');
  process.exit(1);
}
