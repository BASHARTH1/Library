#!/usr/bin/env node
/**
 * Identify pages still on the original text layer that the quality detector
 * still flags, and characterise them so the rejection reason is understood
 * rather than guessed at.
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

const ALEF = 'اأإآ';
const IMPOSSIBLE = new RegExp(`(?:^|[^\\u0620-\\u064A])[${ALEF}][${ALEF}]ل`, 'gu');

function assess(text) {
  const trimmed = text.trim();
  if (trimmed.length < 120) return { quality: 'no_text', rate: 0, longRate: 0, arabicTokens: 0 };
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const arabic = tokens.filter((t) => /[ؠ-ي]/.test(t));
  if (arabic.length < 20) return { quality: 'clean', rate: 0, longRate: 0, arabicTokens: arabic.length };
  const bad = (trimmed.match(IMPOSSIBLE) ?? []).length;
  const rate = (bad / arabic.length) * 1000;
  const longRate = arabic.filter((t) => t.replace(/[^ؠ-ي]/g, '').length >= 18).length / arabic.length;
  const quality = longRate > 0.06 ? 'severe' : rate > 3 ? 'ligature_only' : 'clean';
  return { quality, rate, longRate, arabicTokens: arabic.length };
}

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  `SELECT p.id, p.page_number, p.text, p.char_count,
          left(COALESCE(r.title_ar, r.title_en), 38) AS title,
          f.stored_path
   FROM research_pages p
   JOIN research r ON r.id = p.research_id
   JOIN research_files f ON f.id = p.file_id
   WHERE p.text_source = 'pdf_text_layer' AND f.file_kind = 'pdf'
   ORDER BY r.created_at, p.page_number`,
);

const flagged = [];
for (const row of rows) {
  const a = assess(row.text);
  if (a.quality === 'clean') continue;
  flagged.push({ ...row, ...a });
}

console.log(`pages still on pdf_text_layer: ${rows.length}`);
console.log(`still flagged by the detector : ${flagged.length}\n`);

// Characterise: what do these pages look like?
let numeric = 0;
let tiny = 0;
for (const p of flagged) {
  const digits = (p.text.match(/\d/g) ?? []).length;
  const letters = (p.text.match(/[\p{L}]/gu) ?? []).length;
  const digitRatio = letters > 0 ? digits / (digits + letters) : 1;
  const kind = digitRatio > 0.35 ? 'TABLE/NUMERIC' : p.char_count < 400 ? 'SPARSE' : 'TEXT';
  if (kind === 'TABLE/NUMERIC') numeric += 1;
  if (kind === 'SPARSE') tiny += 1;
  console.log(
    `${kind.padEnd(14)} p.${String(p.page_number).padStart(3)}  ${String(p.char_count).padStart(5)}ch  ` +
    `rate=${p.rate.toFixed(1).padStart(6)}  long=${p.longRate.toFixed(3)}  ${p.title}`,
  );
}

console.log(`\nnumeric/table-heavy: ${numeric}`);
console.log(`sparse (<400 chars): ${tiny}`);
console.log(`ordinary text      : ${flagged.length - numeric - tiny}`);

await client.end();
