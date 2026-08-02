import fs from 'fs';
import path from 'path';

const filesToDelete = [
  'apps/web/src/App.tsx',
  'apps/web/src/main.tsx',
  'apps/web/src/components/ContractInitialization.tsx',
  'apps/web/src/components/VerificationDashboard.tsx',
  'apps/web/src/components/ui/FuturisticButton.tsx',
  'apps/web/src/components/ui/GlassCard.tsx',
  'apps/web/src/components/ui/MobileDrawer.tsx',
  'apps/web/src/components/ui/RadialGauge.tsx',
  'apps/web/src/components/ui/StatusBadge.tsx',
  'apps/web/src/components/ui/ToastNotification.tsx',
  'apps/web/src/components/ui/index.ts',
  'apps/web/src/types/contract.ts',
  'apps/web/src/types/escrow.ts',
  'apps/web/src/types/index.ts',
  'apps/web/src/types/telemetry.ts',
  'apps/web/src/types/xai.ts',
  'apps/web/vite.config.ts'
];

let deletedCount = 0;
filesToDelete.forEach(file => {
  const fullPath = path.resolve(file); // nosemgrep: path-join-resolve-traversal — file is a hardcoded entry from filesToDelete above, no untrusted input
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
    console.log(`Deleted: ${file}`);
    deletedCount++;
  } else {
    console.log(`Not found (already deleted): ${file}`);
  }
});

console.log(`Total files deleted: ${deletedCount}`);
