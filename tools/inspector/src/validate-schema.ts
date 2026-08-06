/**
 * Validate the proposed schema against the real database WITHOUT creating anything.
 * The whole script runs inside a transaction that is always rolled back.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { env, REPO_ROOT } from './lib/env.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const sql = await readFile(resolve(REPO_ROOT, 'docs/schema/001_initial_schema.sql'), 'utf8');
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

  await client.connect();
  console.log('Connected.');

  const version = await client.query('SELECT version()');
  console.log(version.rows[0].version.split(',')[0]);

  const extensions = await client.query(
    `SELECT name, default_version, installed_version FROM pg_available_extensions
     WHERE name IN ('vector','pg_trgm','unaccent','pgcrypto') ORDER BY name`,
  );
  console.log('\nExtensions:');
  for (const row of extensions.rows) {
    console.log(`  ${String(row.name).padEnd(10)} available=${row.default_version} installed=${row.installed_version ?? '-'}`);
  }

  console.log('\nExecuting schema inside a transaction (will ROLLBACK)...');
  try {
    await client.query('BEGIN');
    await client.query(sql);

    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
    );
    const indexes = await client.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='public'`);
    console.log(`\nSUCCESS — ${tables.rows.length} tables, ${indexes.rows[0].n} indexes created in-transaction.`);
    console.log(tables.rows.map((r) => r.table_name).join(', '));
  } catch (error) {
    console.error(`\nSCHEMA ERROR: ${(error as Error).message}`);
    const position = (error as { position?: string }).position;
    if (position) {
      const offset = Number(position);
      console.error(`context: ...${sql.slice(Math.max(0, offset - 200), offset + 120)}...`);
    }
    process.exitCode = 1;
  } finally {
    await client.query('ROLLBACK');
    console.log('\nROLLBACK done — database is unchanged.');
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
