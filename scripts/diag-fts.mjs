#!/usr/bin/env node
/**
 * Diagnose Arabic full-text search behaviour over a real UTF-8 client
 * connection (the Windows psql console mangles Arabic literals).
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();

const TERM = 'كرونباخ ألفا';

const show = async (label, sql, params = []) => {
  const { rows } = await client.query(sql, params);
  console.log(`${label}: ${JSON.stringify(rows[0] ?? rows)}`);
};

console.log(`term = "${TERM}"\n--- tokenisation ---`);
await show('simple    tsvector', `SELECT to_tsvector('simple', $1)::text AS v`, [TERM]);
await show('research_ar tsvector', `SELECT to_tsvector('research_ar', $1)::text AS v`, [TERM]);
await show('simple    tsquery ', `SELECT websearch_to_tsquery('simple', $1)::text AS q`, [TERM]);
await show('research_ar tsquery', `SELECT websearch_to_tsquery('research_ar', $1)::text AS q`, [TERM]);
await show('unaccent on term  ', `SELECT unaccent($1) AS u`, [TERM]);

console.log('\n--- does the term exist in any seeded paper ---');
const { rows } = await client.query(
  `SELECT left(COALESCE(title_ar, title_en), 42) AS title,
          full_text LIKE '%' || $1 || '%' AS has_kronbach,
          search_vector @@ websearch_to_tsquery('research_ar', $2) AS fts_match,
          ts_rank(search_vector, websearch_to_tsquery('research_ar', $2)) AS rank
   FROM research`,
  ['كرونباخ', TERM],
);
for (const r of rows) {
  console.log(`  ${r.has_kronbach ? 'HAS ' : 'no  '} fts=${r.fts_match} rank=${r.rank}  ${r.title}`);
}

console.log('\n--- control: a word that IS present ---');
const control = 'الإعلام';
const { rows: c } = await client.query(
  `SELECT left(COALESCE(title_ar, title_en), 42) AS title,
          search_vector @@ websearch_to_tsquery('research_ar', $1) AS fts_match,
          ts_rank(search_vector, websearch_to_tsquery('research_ar', $1)) AS rank
   FROM research`,
  [control],
);
console.log(`  query "${control}"`);
for (const r of c) console.log(`    fts=${r.fts_match} rank=${r.rank}  ${r.title}`);

await client.end();
