#!/usr/bin/env node
/**
 * Control the local portable PostgreSQL 18 + pgvector cluster.
 *
 * The cluster lives entirely under .localdb/ so it needs no administrator
 * rights and never touches the machine's system PostgreSQL service.
 *
 * Usage: node scripts/db.mjs <start|stop|status|psql>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Credentials come from .env, never from source. Even a local-only cluster
 * password should not be committed â€” it trips secret scanners and sets the
 * wrong precedent for the production connection string.
 */
function envValue(key, fallback = '') {
  try {
    const line = readFileSync(resolve(ROOT, '.env'), 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith(`${key}=`));
    return line ? line.slice(line.indexOf('=') + 1).trim() : fallback;
  } catch {
    return fallback;
  }
}

const DB_PASSWORD = process.env.PGPASSWORD ?? envValue('DATABASE_PASSWORD');
const PGSQL = resolve(ROOT, '.localdb', 'pgsql');
const DATA = resolve(ROOT, '.localdb', 'data');
const LOG = resolve(ROOT, '.localdb', 'pg.log');
const PORT = 5433;
const DB = 'gulf_research_repository';

const bin = (name) => resolve(PGSQL, 'bin', process.platform === 'win32' ? `${name}.exe` : name);

if (!existsSync(bin('pg_ctl'))) {
  console.error(`Portable PostgreSQL not found at ${PGSQL}`);
  console.error('See docs/setup/LOCAL-DATABASE.md to recreate it.');
  process.exit(1);
}

const run = (file, args, env = {}) =>
  spawnSync(file, args, { stdio: 'inherit', env: { ...process.env, ...env } });

const command = process.argv[2] ?? 'status';

switch (command) {
  case 'start': {
    const result = run(bin('pg_ctl'), ['-D', DATA, '-l', LOG, '-o', `-p ${PORT}`, 'start']);
    process.exit(result.status ?? 0);
    break;
  }
  case 'stop': {
    const result = run(bin('pg_ctl'), ['-D', DATA, '-m', 'fast', 'stop']);
    process.exit(result.status ?? 0);
    break;
  }
  case 'psql': {
    const result = run(bin('psql'), ['-U', 'postgres', '-h', '127.0.0.1', '-p', String(PORT), '-d', DB], {
      PGPASSWORD: DB_PASSWORD,
    });
    process.exit(result.status ?? 0);
    break;
  }
  default: {
    const result = spawnSync(bin('pg_isready'), ['-h', '127.0.0.1', '-p', String(PORT)], { encoding: 'utf8' });
    console.log((result.stdout ?? '').trim() || 'pg_isready produced no output');
    if ((result.status ?? 1) === 0) {
      const counts = spawnSync(
        bin('psql'),
        ['-U', 'postgres', '-h', '127.0.0.1', '-p', String(PORT), '-d', DB, '-c',
         'SELECT (SELECT count(*) FROM research) AS research, (SELECT count(*) FROM research_chunks) AS chunks, (SELECT count(*) FROM research_embeddings) AS embeddings;'],
        { encoding: 'utf8', env: { ...process.env, PGPASSWORD: DB_PASSWORD } },
      );
      console.log(counts.stdout ?? '');
    }
    process.exit(result.status ?? 0);
  }
}
