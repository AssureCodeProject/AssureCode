#!/usr/bin/env node
/**
 * Dependency audit gate.
 *
 * Replaces a bare `npm audit --audit-level=high`, which had failed on every
 * single run for months. A gate that is always red is not a gate: nobody can
 * tell the run where a new critical appeared from the two hundred runs before
 * it, and the only workable response becomes ignoring the job. It was also
 * wired into nothing, so it reddened the workflow without blocking a merge —
 * the worst of both worlds.
 *
 * What this does instead
 * ----------------------
 * 1. Audits **production** dependencies (`--omit=dev`). Dev-tool advisories are
 *    a different risk class: vitest and vite are not in any published image, and
 *    exploiting them requires already running attacker-controlled code on a
 *    developer's machine. They are still reported below, just not gated on.
 * 2. Fails on any high/critical production advisory that is not in
 *    `docs/security/audit-exceptions.json`.
 * 3. Fails on an **expired** exception, so accepting a risk has a deadline
 *    rather than being permanent by default.
 * 4. Fails on a **stale** exception — one whose advisory no longer fires. That
 *    keeps the file from silently accumulating entries that suppress findings
 *    nobody has looked at in a year.
 *
 * Every current exception exists for one reason: the only available fix is a
 * major-version bump (fastify 4→5, which drags @fastify/jwt, cors, multipart
 * and websocket with it; or OpenTelemetry 0.51→0.221). Those are real pieces of
 * work with real regression risk, not something to slip into an unrelated
 * change.
 *
 * Usage:  node scripts/audit-check.mjs [--json]
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCEPTIONS_PATH = path.join(ROOT, 'docs', 'security', 'audit-exceptions.json');
const GATED = new Set(['high', 'critical']);

/**
 * `npm audit` exits non-zero whenever it finds anything, so the report has to be
 * read off stdout of a "failed" call rather than from a clean exit.
 *
 * execSync (which goes through a shell) rather than execFileSync: on Windows
 * npm is a `.cmd` shim, and Node 24 refuses to spawn one directly.
 */
function runAudit(omitDev) {
  const cmd = `npm audit --json${omitDev ? ' --omit=dev' : ''}`;
  try {
    return JSON.parse(execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

function gatedVulns(report) {
  return Object.entries(report.vulnerabilities ?? {})
    .filter(([, v]) => GATED.has(v.severity))
    .map(([name, v]) => ({ name, severity: v.severity }));
}

const prod = runAudit(true);
const all = runAudit(false);

const exceptions = JSON.parse(readFileSync(EXCEPTIONS_PATH, 'utf8'));
const byName = new Map(exceptions.exceptions.map((e) => [e.package, e]));

const found = gatedVulns(prod);
const foundNames = new Set(found.map((f) => f.name));
const today = new Date().toISOString().slice(0, 10);

const unexcepted = found.filter((f) => !byName.has(f.name));
const expired = exceptions.exceptions.filter((e) => e.expires < today && foundNames.has(e.package));
const stale = exceptions.exceptions.filter((e) => !foundNames.has(e.package));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ found, unexcepted, expired, stale }, null, 2));
}

const prodMeta = prod.metadata.vulnerabilities;
const allMeta = all.metadata.vulnerabilities;

console.log('Dependency audit');
console.log(`  production : ${prodMeta.critical} critical, ${prodMeta.high} high, ${prodMeta.moderate} moderate  [GATED]`);
console.log(`  incl. dev  : ${allMeta.critical} critical, ${allMeta.high} high, ${allMeta.moderate} moderate  [reported only]`);
console.log('');

if (found.length) {
  console.log('Production high/critical advisories:');
  for (const f of found) {
    const e = byName.get(f.name);
    const status = e ? `accepted until ${e.expires} — ${e.reason}` : 'NOT ACCEPTED';
    console.log(`  ${f.severity.padEnd(8)} ${f.name.padEnd(32)} ${status}`);
  }
  console.log('');
}

let failed = false;

if (unexcepted.length) {
  failed = true;
  console.error('FAIL: production advisories with no reviewed exception:');
  for (const u of unexcepted) console.error(`  - ${u.name} (${u.severity})`);
  console.error(`  Fix them, or add a dated entry to ${path.relative(ROOT, EXCEPTIONS_PATH)}.`);
}

if (expired.length) {
  failed = true;
  console.error('FAIL: exceptions past their review date:');
  for (const e of expired) console.error(`  - ${e.package} expired ${e.expires} (${e.requires})`);
  console.error('  Do the upgrade, or re-review and extend with a new justification.');
}

if (stale.length) {
  failed = true;
  console.error('FAIL: exceptions for advisories that no longer fire (remove them):');
  for (const s of stale) console.error(`  - ${s.package}`);
}

if (failed) process.exit(1);
console.log('OK — no unaccepted production advisories.');
