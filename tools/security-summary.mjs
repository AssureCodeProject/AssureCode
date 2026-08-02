#!/usr/bin/env node
/**
 * Summarise the most recent `npm audit` JSON file (docs/security/npm-audit.json)
 * so reviewers can see severity counts and the top advisories at a glance.
 *
 * Usage:  node tools/security-summary.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const auditPath = join(__dirname, '..', 'docs', 'security', 'npm-audit.json');

let report;
try {
  report = JSON.parse(readFileSync(auditPath, 'utf-8'));
} catch (err) {
  console.error(`[security-summary] could not read ${auditPath}: ${err.message}`);
  console.error('  Run: npm audit --json > docs/security/npm-audit.json');
  process.exit(1);
}

const vulns = report.vulnerabilities ?? {};
const bySeverity = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
const rows = [];

for (const [pkg, v] of Object.entries(vulns)) {
  const sev = v.severity || 'info';
  bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
  const viaTitles = (v.via ?? [])
    .map((x) => (typeof x === 'string' ? x : x.title))
    .filter(Boolean)
    .join('; ');
  rows.push({ pkg, severity: sev, title: viaTitles || '(see npm audit)', direct: v.isDirect });
}

const order = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
rows.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

console.log(`\n=== npm audit summary (${rows.length} advisories) ===`);
console.log(`  critical: ${bySeverity.critical}`);
console.log(`  high:     ${bySeverity.high}`);
console.log(`  moderate: ${bySeverity.moderate}`);
console.log(`  low:      ${bySeverity.low}`);
console.log('');
console.log('  SEV        PKG                              TITLE');
console.log('  ---------- --------------------------------  ' + '-'.repeat(40));
for (const r of rows.slice(0, 25)) {
  console.log(
    `  ${r.severity.padEnd(10)} ${r.pkg.padEnd(32)} ${r.title.slice(0, 80)}`,
  );
}
if (rows.length > 25) console.log(`  ... and ${rows.length - 25} more`);
console.log('\nFull report: docs/security/npm-audit.json\n');
