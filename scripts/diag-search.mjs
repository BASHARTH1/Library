#!/usr/bin/env node
/** Diagnose why a query returns nothing across the ingested corpus. */
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

console.log('=== index population ===');
const { rows: pop } = await client.query(`
  SELECT count(*)                                              AS research,
         count(*) FILTER (WHERE search_vector IS NULL)         AS null_vector,
         count(*) FILTER (WHERE full_text IS NULL OR full_text = '') AS empty_text,
         count(*) FILTER (WHERE title_ar IS NULL AND title_en IS NULL) AS no_title
  FROM research WHERE deleted_at IS NULL`);
console.log(pop[0]);

const { rows: chunkPop } = await client.query(`
  SELECT count(*) AS chunks,
         count(*) FILTER (WHERE search_vector IS NULL) AS null_vector
  FROM research_chunks`);
console.log(chunkPop[0]);

console.log('\n=== sample of ingested titles ===');
const { rows: titles } = await client.query(
  `SELECT left(COALESCE(title_ar, title_en), 60) AS t FROM research ORDER BY created_at DESC LIMIT 5`);
for (const r of titles) console.log(`  ${r.t}`);

console.log('\n=== term probes (document-level FTS + chunk FTS + ILIKE) ===');
const TERMS = [
  'التحول الرقمي', 'القيادة', 'الذكاء الاصطناعي', 'الرضا الوظيفي',
  'الاستبانة', 'العينة', 'الصدق', 'المنهج الوصفي', 'كرونباخ',
];

for (const term of TERMS) {
  const { rows } = await client.query(
    `SELECT
       (SELECT count(*) FROM research r
         WHERE r.search_vector @@ websearch_to_tsquery('research_ar', $1)) AS doc_fts,
       (SELECT count(DISTINCT c.research_id) FROM research_chunks c
         WHERE c.search_vector @@ websearch_to_tsquery('research_ar', $1)) AS chunk_fts,
       (SELECT count(*) FROM research r WHERE r.full_text ILIKE '%' || $1 || '%') AS ilike_raw,
       (SELECT count(*) FROM research r WHERE r.full_text ILIKE '%' || $2 || '%') AS ilike_corrupt`,
    [term, term.replace(/ل([اأإآ])/gu, '$1ل')],
  );
  const r = rows[0];
  console.log(
    `  ${term.padEnd(20)} docFTS=${String(r.doc_fts).padStart(3)} chunkFTS=${String(r.chunk_fts).padStart(3)} ` +
    `ilike=${String(r.ilike_raw).padStart(3)} ilikeCorrupted=${String(r.ilike_corrupt).padStart(3)}`,
  );
}

await client.end();
