#!/usr/bin/env node
/**
 * Semgrep runner — finds the locally-installed `semgrep` on Windows where the
 * pip --user Scripts dir is not on PATH, then invokes it with the project's
 * baseline ruleset. Falls back to the `semgrep` binary on PATH (Linux/macOS
 * or after the user adds the Scripts dir to PATH).
 *
 * Usage:
 *   node tools/scan-semgrep.mjs                  # scan apps/, packages/, tools/, scripts/
 *   node tools/scan-semgrep.mjs --config p/owasp-top-ten
 *   node tools/scan-semgrep.mjs --config p/security-audit --severity ERROR
 *
 * Exit code mirrors semgrep's: 0 = clean, 1 = findings (or scan error).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);

// Candidate locations for the semgrep binary, in priority order.
const candidates = [
  // 1) PATH (if the user has already exported it)
  'semgrep',
  // 2) pip --user Scripts on Windows (Python 3.10+)
  join(homedir(), 'AppData', 'Roaming', 'Python', 'Python313', 'Scripts', 'semgrep.exe'),
  join(homedir(), 'AppData', 'Roaming', 'Python', 'Python312', 'Scripts', 'semgrep.exe'),
  join(homedir(), 'AppData', 'Roaming', 'Python', 'Python311', 'Scripts', 'semgrep.exe'),
  join(homedir(), 'AppData', 'Roaming', 'Python', 'Python310', 'Scripts', 'semgrep.exe'),
  // 3) pipx default
  join(homedir(), '.local', 'bin', 'semgrep'),
  // 4) Linux/macOS user install
  '/usr/local/bin/semgrep',
  '/usr/bin/semgrep',
];

let binary = null;
for (const c of candidates) {
  if (c.includes(delimiter) || c.includes('/') || c.includes('\\')) {
    if (existsSync(c)) { binary = c; break; }
  } else {
    binary = c; break; // bare 'semgrep' — let PATH resolution handle it
  }
}

if (!binary) {
  console.error(
    '[scan-semgrep] semgrep binary not found.\n' +
    '  Install with: pip install --user semgrep\n' +
    '  Then either add %APPDATA%\\Python\\Python313\\Scripts to PATH,\n' +
    '  or rerun via: node tools/scan-semgrep.mjs',
  );
  process.exit(2);
}

const defaultArgs = [
  '--config', 'p/default',
  '--error',
  '--metrics', 'off',
  '--quiet',
  // Scan source dirs only — skip dist/, node_modules/, etc.
  'apps', 'packages', 'tools', 'scripts',
];

// Allow user-supplied args to override the defaults (anything they pass wins).
const finalArgs = [...defaultArgs, ...args];

console.error(`[scan-semgrep] using: ${binary}`);
console.error(`[scan-semgrep] args: ${finalArgs.join(' ')}`);

const result = spawnSync(binary, finalArgs, { stdio: 'inherit' });
process.exit(result.status ?? 1);
