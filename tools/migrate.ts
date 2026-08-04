/**
 * AssureCode migration runner.
 *
 * Idempotently applies SQL files from infra/migrations/postgres/ against
 * the configured Postgres database. Tracks applied migrations in a
 * `_migrations` table.
 *
 * Usage:
 *   npm run migrate              # uses DATABASE_URL from .env
 *   DATABASE_URL=... npx tsx tools/migrate.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import pg from 'pg';
import { buildDbConfig } from '@assurecode/config';
import { loadDotEnv } from './test-support/env.js';

const { Client } = pg;

loadDotEnv();

const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', 'infra', 'migrations', 'postgres');

async function getDatabaseUrl(): Promise<string> {
  const url =
    process.env.DATABASE_URL ??
    (process.env.POSTGRES_HOST
      ? `postgresql://${process.env.POSTGRES_USER ?? 'assurecode'}:${process.env.POSTGRES_PASSWORD ?? 'assurecode_local_dev'}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT ?? 5432}/${process.env.POSTGRES_DB ?? 'assurecode'}`
      : null);

  if (!url) {
    throw new Error(
      'DATABASE_URL or POSTGRES_HOST must be set. Copy .env.example to .env and configure.',
    );
  }
  return url;
}

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         SERIAL PRIMARY KEY,
      filename   TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(client: pg.Client): Promise<Set<string>> {
  const result = await client.query('SELECT filename FROM _migrations');
  return new Set(result.rows.map((r) => r.filename));
}

async function run() {
  const databaseUrl = await getDatabaseUrl();
  console.log(`[migrate] Connecting to ${databaseUrl.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}...`);

  // Same TLS policy as the services: verification stays on, with the pinned
  // Supabase root where one is needed. A migration runner that disabled
  // verification would send the password over an unauthenticated session.
  const client = new Client(buildDbConfig(databaseUrl));
  await client.connect();
  console.log('[migrate] Connected.');

  await ensureMigrationsTable(client);

  const applied = await getAppliedMigrations(client);
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('[migrate] No migration files found.');
    await client.end();
    return;
  }

  let appliedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  [skip] ${file} (already applied)`);
      skippedCount++;
      continue;
    }

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    console.log(`  [apply] ${file} ...`);
    await client.query(sql);
    await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
    console.log(`  [done]  ${file}`);
    appliedCount++;
  }

  console.log(`[migrate] Complete. ${appliedCount} applied, ${skippedCount} skipped.`);
  await client.end();
}

run().catch((err) => {
  console.error('[migrate] Fatal error:', err);
  process.exit(1);
});
