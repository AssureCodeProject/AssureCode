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

const SEED_DIR = resolve(import.meta.dirname, '..', 'infra', 'seed', 'neo4j');

function getNeo4jConfig() {
  const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
  const user = process.env.NEO4J_USER ?? 'neo4j';
  const password = process.env.NEO4J_PASSWORD ?? 'assurecode_local_dev';
  return { uri, user, password };
}

/**
 * A Cypher seed file is a sequence of semicolon-terminated statements, with
 * inline // comments and blank lines. We split on semicolons that are not
 * inside a string, then trim and drop empties/comments.
 */
function splitStatements(text: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Toggle string state on an unescaped quote.
    if ((ch === "'" || ch === '"') && text[i - 1] !== '\\') {
      if (inString === ch) inString = null;
      else if (inString === null) inString = ch;
    }

    if (ch === ';' && inString === null) {
      pushIfExecutable(statements, current);
      current = '';
    } else {
      current += ch;
    }
  }
  pushIfExecutable(statements, current);
  return statements;
}

/**
 * Push `chunk`'s executable content, unless it's nothing but comment lines.
 *
 * Comments never contain a semicolon, so a chunk spanning a `// section
 * header` (or the file's own leading doc comment) immediately followed by a
 * real statement — with no semicolon between them — arrives here as ONE
 * chunk whose first line, after trimming, is `//`. Checking only
 * `chunk.startsWith('//')` (the previous approach) misjudged that whole
 * chunk as "just a comment" and dropped the real statement bundled after
 * it — silently, since a dropped MERGE throws no error.
 *
 * Comment lines are stripped from what's actually pushed, not just detected:
 * Aura's server-side parser counts a leading `//` line plus a statement on
 * the next line as more than "exactly one statement per query" and rejects
 * the whole query, even though Cypher's grammar treats `//` as a same-line
 * comment. Sending only the statement lines avoids that entirely.
 */
function pushIfExecutable(statements: string[], chunk: string): void {
  const withoutComments = chunk
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .trim();
  if (withoutComments) statements.push(withoutComments);
}

async function applyFile(session: Session, filename: string, content: string): Promise<number> {
  const statements = splitStatements(content);
  let count = 0;
  for (const stmt of statements) {
    // Strip trailing inline comments after the statement body.
    const cleaned = stmt.replace(/\/\/.*$/, '').trim();
    if (!cleaned) continue;
    await session.run(cleaned);
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
