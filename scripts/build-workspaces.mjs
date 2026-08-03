/**
 * Ordered workspace build.
 *
 * npm does not guarantee topological ordering across `--workspaces`, and
 * chaining `&&` inside an npm script breaks under cmd.exe on Windows. Each
 * package consumes its dependencies' emitted .d.ts from dist/, so the order
 * below is load-bearing: a package must be built before anything importing it.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ORDER = [
  'packages/shared',
  'packages/telemetry',
  'packages/stripe-adapter',
  'packages/config',
  'packages/event-bus',
  'packages/ledger-client',
  'apps/api-gateway',
  'apps/ci-worker',
  'apps/settlement-worker',
  'apps/webhook-ingest',
];

// Invoke tsc's entrypoint through node rather than the .bin shim, so no shell
// is involved and argument escaping stays the platform's problem, not ours.
const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

for (const workspace of ORDER) {
  process.stdout.write(`building ${workspace} ... `);
  const result = spawnSync(process.execPath, [tsc, '-p', path.join(repoRoot, workspace, 'tsconfig.json')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.log('FAILED');
    process.stderr.write((result.stdout ?? '') + (result.stderr ?? ''));
    process.exit(1);
  }
  console.log('ok');
}

/**
 * Assets tsc does not emit.
 *
 * egress-guard.cjs is authored as CommonJS and preloaded into the sandbox child
 * via --require. It is not part of any TypeScript program, so tsc ignores it —
 * but without it in dist/, the built sandbox has no network isolation. The
 * runner refuses to start when the guard is missing rather than running
 * untrusted code unguarded, so a missed copy fails loudly; copying it here
 * means it never comes up.
 */
const ASSETS = [['apps/ci-worker/src/sandbox/egress-guard.cjs', 'apps/ci-worker/dist/sandbox/egress-guard.cjs']];

for (const [from, to] of ASSETS) {
  const src = path.join(repoRoot, from);
  const dest = path.join(repoRoot, to);
  if (!existsSync(src)) {
    console.error(`missing build asset: ${from}`);
    process.exit(1);
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`copied ${from} -> ${to}`);
}

console.log(`\nBuilt ${ORDER.length} workspaces.`);
