#!/usr/bin/env node
/** Corpus-wide Arabic text-quality report, by text source. */
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

const ALEF = 'اأإآ';
const IMPOSSIBLE = new RegExp(`(?:^|[^\\u0620-\\u064A])[${ALEF}][${ALEF}]ل`, 'gu');

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  `SELECT text_source, text FROM research_pages WHERE length(text) > 200`,
);

const stats = new Map();
for (const row of rows) {
  const tokens = row.text.split(/\s+/).filter((t) => /[ؠ-ي]/.test(t));
  if (tokens.length < 20) continue;
  const bad = (row.text.match(IMPOSSIBLE) ?? []).length;
  const entry = stats.get(row.text_source) ?? { pages: 0, corrupted: 0, rateSum: 0 };
  entry.pages += 1;
  const rate = (bad / tokens.length) * 1000;
  entry.rateSum += rate;
  if (rate > 3) entry.corrupted += 1;
  stats.set(row.text_source, entry);
}

console.log('text source        pages   corrupted   avg impossible/1k tokens');
for (const [source, s] of [...stats.entries()].sort()) {
  const pct = ((s.corrupted / s.pages) * 100).toFixed(1);
  console.log(
    `${String(source).padEnd(18)} ${String(s.pages).padStart(5)}   ${String(s.corrupted).padStart(6)} (${pct.padStart(5)}%)   ${(s.rateSum / s.pages).toFixed(2)}`,
  );
}

// Show a repaired page next to a still-broken one for eyeball comparison.
const { rows: sample } = await client.query(
  `SELECT text_source, left(replace(text, chr(10), ' '), 150) AS snippet
   FROM research_pages
   WHERE text_source = 'vision_ocr' AND text ILIKE '%كلية%'
   LIMIT 2`,
);
if (sample.length) {
  console.log('\nrepaired sample (vision_ocr):');
  for (const s of sample) console.log(`  ${s.snippet}`);
}

const { rows: broken } = await client.query(
  `SELECT left(replace(text, chr(10), ' '), 150) AS snippet
   FROM research_pages
   WHERE text_source = 'pdf_text_layer' AND text ILIKE '%كلي%'
   LIMIT 2`,
);
if (broken.length) {
  console.log('\nstill on original text layer:');
  for (const b of broken) console.log(`  ${b.snippet}`);
}

await client.end();
