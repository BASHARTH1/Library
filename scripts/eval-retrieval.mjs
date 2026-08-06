#!/usr/bin/env node
/**
 * Retrieval quality check across the corpus.
 *
 * For each probe it reports how many distinct papers semantic retrieval reaches,
 * the top similarity, and whether the top hit is reachable by full-text search
 * at all — the cases where lexical retrieval would have returned nothing are the
 * ones that justify the embedding cost.
 *
 * Usage: node scripts/eval-retrieval.mjs
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const PROBES = [
  'ما العوامل التي تؤثر على قبول الموظفين للتقنيات الحديثة؟',
  'كيف تقيس الدراسات ثبات أدوات القياس؟',
  'ما أثر أسلوب القائد على رضا العاملين؟',
  'How do these studies measure organisational performance?',
  'الفجوات البحثية المقترحة للدراسات المستقبلية',
];

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
const model = env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-001';

const { rows: cov } = await client.query(
  `SELECT count(DISTINCT research_id)::int AS papers, count(*)::int AS vectors
   FROM research_embeddings WHERE model = $1`, [model]);
const { rows: tot } = await client.query(`SELECT count(*)::int AS n FROM research WHERE deleted_at IS NULL`);
console.log(`coverage: ${cov[0].papers}/${tot[0].n} papers, ${cov[0].vectors} vectors\n`);

for (const probe of PROBES) {
  const embedded = await ai.models.embedContent({
    model, contents: probe,
    config: { outputDimensionality: Number(env.GEMINI_EMBEDDING_DIMENSIONS ?? 1536), taskType: 'RETRIEVAL_QUERY' },
  });
  const vector = `[${(embedded.embeddings?.[0]?.values ?? []).join(',')}]`;

  const { rows } = await client.query(
    `SELECT COALESCE(r.title_ar, r.title_en) AS title,
            c.page_number,
            1 - (e.embedding <=> $1::vector) AS similarity,
            c.search_vector @@ websearch_to_tsquery('research_ar', $3) AS lexical_would_match
     FROM research_embeddings e
     JOIN research_chunks c ON c.id = e.chunk_id
     JOIN research r ON r.id = e.research_id
     WHERE e.model = $2
     ORDER BY e.embedding <=> $1::vector
     LIMIT 5`,
    [vector, model, probe],
  );

  const distinct = new Set(rows.map((r) => r.title)).size;
  const lexicalHits = rows.filter((r) => r.lexical_would_match).length;

  console.log(`▸ ${probe}`);
  console.log(`   top similarity ${Number(rows[0]?.similarity ?? 0).toFixed(3)} · ${distinct} distinct papers in top 5 · ${lexicalHits}/5 also findable by full-text`);
  for (const row of rows.slice(0, 3)) {
    console.log(`     ${Number(row.similarity).toFixed(3)}  p.${String(row.page_number).padStart(3)}  ${String(row.title).slice(0, 52)}`);
  }
  console.log();
}

await client.end();
