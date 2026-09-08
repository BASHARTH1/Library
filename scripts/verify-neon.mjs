#!/usr/bin/env node
/**
 * Functional verification of the Neon database over a real UTF-8 client.
 *
 * The Windows psql console mangles Arabic literals before they reach the
 * server, so FTS and trigram results measured through it are meaningless.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function envVal(file, key) {
  try {
    const line = readFileSync(resolve(ROOT, file), 'utf8')
      .split('\n').find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '') : null;
  } catch { return null; }
}

const url = envVal('.env.local', 'DATABASE_URL_UNPOOLED') ?? envVal('.env.local', 'DATABASE_URL');
if (!url) { console.error('no Neon URL in .env.local'); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log(`search_path: [${(await client.query("SELECT current_setting('search_path') s")).rows[0].s}]`);

const show = async (label, sql, params = []) => {
  const { rows } = await client.query(sql, params);
  console.log(`${label}: ${JSON.stringify(rows[0])}`);
};

console.log('\n--- Arabic full-text search ---');
await show('tsquery parses  ', `SELECT websearch_to_tsquery('research_ar', $1)::text AS q`, ['الذكاء الاصطناعي']);
await show('research matches', `SELECT count(*)::int AS n FROM research WHERE search_vector @@ websearch_to_tsquery('research_ar', $1)`, ['الذكاء الاصطناعي']);
await show('chunk matches   ', `SELECT count(*)::int AS n FROM research_chunks WHERE search_vector @@ websearch_to_tsquery('research_ar', $1)`, ['كرونباخ']);

console.log('\n--- trigram author matching ---');
await show('similarity      ', `SELECT round(similarity($1,$2)::numeric,3) AS sim`, ['ناصر رياض الناصر', 'ناصر رياض ناصر']);

console.log('\n--- pgvector: is the HNSW index used? ---');
const { rows: probe } = await client.query('SELECT embedding FROM research_embeddings LIMIT 1');
const plan = await client.query(
  'EXPLAIN (COSTS OFF) SELECT id FROM research_embeddings ORDER BY embedding <=> $1::vector LIMIT 5',
  [probe[0].embedding],
);
for (const r of plan.rows) console.log(`  ${r['QUERY PLAN']}`);

console.log('\n--- nearest neighbours ---');
const { rows: nn } = await client.query(
  `SELECT left(COALESCE(r.title_ar, r.title_en), 46) AS title,
          round((1 - (e.embedding <=> $1::vector))::numeric, 4) AS sim
   FROM research_embeddings e JOIN research r ON r.id = e.research_id
   ORDER BY e.embedding <=> $1::vector LIMIT 3`,
  [probe[0].embedding],
);
for (const r of nn) console.log(`  ${r.sim}  ${r.title}`);

await client.end();
