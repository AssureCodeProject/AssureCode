/**
 * AssureCode Neo4j seed runner.
 *
 * Idempotently applies .cypher files from infra/seed/neo4j/ against the
 * configured Neo4j instance. Each seed file is split on `// === SPLIT ===`
 * markers (or run as a single transaction) and statements are written to the
 * driver as auto-commit queries so MERGE-based seeds are safe to re-run.
 *
 * Usage:
 *   npm run seed:neo4j                 # uses NEO4J_URI from .env
 *   NEO4J_URI=bolt://localhost:7687 npx tsx tools/seed-neo4j.ts
 *
 * Requires the `neo4j-driver` package (added to package.json devDeps).
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { loadDotEnv } from './test-support/env.js';

// Same as tools/migrate.ts: the connection details live in the gitignored .env,
// so without this `npm run seed:neo4j` silently falls back to the localhost
// defaults below and fails to authenticate against a configured instance.
// Existing environment variables still win, so CI can point this anywhere.
loadDotEnv();

const SEED_DIR = resolve(import.meta.dirname, '..', 'infra', 'seed', 'neo4j');

function getNeo4jConfig() {
  const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
  const user = process.env.NEO4J_USER ?? 'neo4j';
  const password = process.env.NEO4J_PASSWORD ?? 'assurecode_local_dev';
  return { uri, user, password };
}

/**
 * A Cypher seed file is a sequence of semicolon-terminated statements, with
 * inline // comments and blank lines. We strip comments and split on semicolons
 * in a single string-aware pass, then trim and drop empties.
 *
 * Comments are removed *before* splitting rather than after, because every
 * alternative silently corrupts the seed rather than failing loudly:
 *
 *   - Dropping statements that `startsWith('//')` deletes any statement
 *     preceded by a comment line, since the comment trims into the head of the
 *     *following* statement's text. A documented seed file would apply only its
 *     first statement and report success for the rest.
 *   - A `;` inside a comment would split one statement into two invalid halves.
 *   - An apostrophe inside a comment (`// don't`) would open a string that
 *     never closes, so every subsequent `;` stops separating statements and the
 *     rest of the file merges into one unparseable query.
 *
 * All three fail as "seeded N statements" with N quietly wrong, which is the
 * worst possible failure mode for a fixture other tests are asserting against.
 */
function splitStatements(text: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Outside a string, `//` starts a comment that runs to end of line.
    if (inString === null && ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      if (newline === -1) break;
      current += '\n';
      i = newline;
      continue;
    }

    // Toggle string state on an unescaped quote.
    if ((ch === "'" || ch === '"') && text[i - 1] !== '\\') {
      if (inString === ch) inString = null;
      else if (inString === null) inString = ch;
    }

    if (ch === ';' && inString === null) {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = '';
    } else {
      current += ch;
    }
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

async function applyFile(session: Session, filename: string, content: string): Promise<number> {
  const statements = splitStatements(content);
  let count = 0;
  for (const stmt of statements) {
    // splitStatements has already removed comments; stripping again here would
    // cut a statement short at a `//` appearing inside a string literal.
    await session.run(stmt);
    count++;
  }
  console.log(`  [apply] ${filename} (${count} statements)`);
  return count;
}

async function run() {
  const { uri, user, password } = getNeo4jConfig();
  console.log(`[seed:neo4j] Connecting to ${uri} as ${user}...`);

  const driver: Driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  // Verify connectivity — fail fast with a clear message if Neo4j is down.
  await driver.verifyConnectivity();
  console.log('[seed:neo4j] Connected.');

  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });

  try {
    const files = (await readdir(SEED_DIR)).filter((f) => f.endsWith('.cypher')).sort();

    if (files.length === 0) {
      console.log('[seed:neo4j] No seed files found.');
      return;
    }

    let total = 0;
    for (const file of files) {
      const content = await readFile(join(SEED_DIR, file), 'utf-8');
      total += await applyFile(session, file, content);
    }

    // Sanity check: matchmaker needs at least one freelancer to rank.
    const check = await session.run(
      'MATCH (f:Freelancer) RETURN count(f) AS n, collect(f.id) AS ids',
    );
    const record = check.records[0];
    const n = record?.get('n').toNumber() ?? 0;
    const ids: string[] = record?.get('ids') ?? [];

    console.log(`[seed:neo4j] Complete. ${files.length} file(s), ${total} statements.`);
    console.log(`[seed:neo4j] Freelancer count: ${n} (ids: ${ids.join(', ') || 'none'})`);
    if (n < 1) {
      console.warn('[seed:neo4j] WARN: expected >=1 Freelancer; /match will return empty.');
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

run().catch((err) => {
  console.error('[seed:neo4j] Fatal error:', err);
  process.exit(1);
});
