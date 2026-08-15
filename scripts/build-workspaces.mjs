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
  'packages/razorpay-adapter',
  'packages/kyc-adapter',
  'packages/config',
  'packages/event-bus',
  'packages/ledger-client',
  'packages/oracle',
  'apps/api-gateway',
  'apps/ci-worker',
  'apps/settlement-worker',
  'apps/webhook-ingest',
];

// Invoke tsc's entrypoint through node rather than the .bin shim, so no shell
// is involved and argument escaping stays the platform's problem, not ours.
const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * Which workspaces to build.
 *
 * A service container image copies only the workspaces it needs — the gateway
 * image has no apps/ci-worker, the webhook-ingest image has no
 * apps/api-gateway. Building the full hardcoded ORDER inside one of those
 * images fails on the first absent tsconfig with TS5058, so every service
 * Dockerfile that ran `npm run build` was unbuildable.
 *
 * Absent workspaces are therefore skipped rather than fatal. In a full
 * checkout nothing is absent and the behaviour is unchanged; the skip only
 * engages where the directory genuinely is not there. Pass explicit
 * workspace paths as arguments to narrow the build further.
 */
const requested = process.argv.slice(2);
const selected = requested.length > 0 ? ORDER.filter((w) => requested.includes(w)) : ORDER;

for (const name of requested) {
  if (!ORDER.includes(name)) {
    console.error(`unknown workspace: ${name}\nknown: ${ORDER.join(', ')}`);
    process.exit(1);
  }
}

let built = 0;
for (const workspace of selected) {
  const tsconfig = path.join(repoRoot, workspace, 'tsconfig.json');
  if (!existsSync(tsconfig)) {
    console.log(`skipping ${workspace} ... not present in this checkout`);
    continue;
  }

  process.stdout.write(`building ${workspace} ... `);
  const result = spawnSync(process.execPath, [tsc, '-p', tsconfig], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.log('FAILED');
    process.stderr.write((result.stdout ?? '') + (result.stderr ?? ''));
    process.exit(1);
  }
  console.log('ok');
  built += 1;
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
const ASSETS = [
  ['apps/ci-worker/src/sandbox/egress-guard.cjs', 'apps/ci-worker/dist/sandbox/egress-guard.cjs'],
  // test-harness.cjs is copied into each run's work directory and executed as
  // the sandbox entrypoint. Like the guard it is CommonJS and outside every
  // TypeScript program, so tsc does not emit it — and without it in dist/ the
  // built worker materialises a workspace with no runner, which reports 0/0 and
  // is indistinguishable from a pipeline that ran and measured nothing.
  ['apps/ci-worker/src/sandbox/test-harness.cjs', 'apps/ci-worker/dist/sandbox/test-harness.cjs'],
];

// Only meaningful when ci-worker is part of this checkout and was built. An
// image that does not ship the sandbox has no guard to copy — but if the
// workspace IS here, a missing asset stays fatal, because the alternative is
// a sandbox running untrusted code without its egress guard.
const ciWorkerPresent =
  selected.includes('apps/ci-worker') &&
  existsSync(path.join(repoRoot, 'apps/ci-worker', 'tsconfig.json'));

if (ciWorkerPresent) {
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
}

console.log(`\nBuilt ${built} workspace${built === 1 ? '' : 's'}.`);
