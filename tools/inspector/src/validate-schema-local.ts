/**
 * Validate the proposed schema in an embedded Postgres (PGlite) with pgvector.
 * Runs entirely locally — no external database is touched.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { REPO_ROOT } from './lib/env.js';

/**
 * PGlite does not bundle `unaccent` or `pgcrypto`. Both exist on Supabase and on
 * any standard Postgres, so we neutralize only those two statements locally and
 * report them as un-exercised rather than silently pretending they passed.
 * gen_random_uuid() is native from Postgres 13 on, so dropping pgcrypto is safe here.
 */
const UNSUPPORTED_LOCALLY = ['CREATE EXTENSION IF NOT EXISTS unaccent;', 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'];

function adaptForPglite(sql: string): { sql: string; skipped: string[] } {
  let out = sql;
  const skipped: string[] = [];
  for (const statement of UNSUPPORTED_LOCALLY) {
    if (out.includes(statement)) {
      out = out.replace(statement, `-- [skipped locally] ${statement}`);
      skipped.push(statement);
    }
  }
  out = out.replace('WITH unaccent, simple;', 'WITH simple; -- [unaccent dropped locally]');
  skipped.push('ALTER TEXT SEARCH CONFIGURATION ... WITH unaccent');
  return { sql: out, skipped };
}

async function main(): Promise<void> {
  const raw = await readFile(resolve(REPO_ROOT, 'docs/schema/001_initial_schema.sql'), 'utf8');
  const { sql, skipped } = adaptForPglite(raw);

  const db = await new PGlite({ extensions: { vector, pg_trgm } });
  const version = await db.query<{ version: string }>('SELECT version()');
  console.log(version.rows[0].version.split(',')[0]);
  console.log(`NOT exercised locally (present on Supabase): ${skipped.join(' | ')}`);

  try {
    await db.exec(sql);
  } catch (error) {
    console.error(`\nSCHEMA ERROR: ${(error as Error).message}`);
    process.exitCode = 1;
    await db.close();
    return;
  }

  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
  );
  const indexes = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='public'`);
  const fks = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.table_constraints
     WHERE table_schema='public' AND constraint_type='FOREIGN KEY'`,
  );
  const checks = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.table_constraints
     WHERE table_schema='public' AND constraint_type='CHECK'`,
  );

  console.log(`\nSUCCESS`);
  console.log(`  tables : ${tables.rows.length}`);
  console.log(`  indexes: ${indexes.rows[0].n}`);
  console.log(`  FKs    : ${fks.rows[0].n}`);
  console.log(`  CHECKs : ${checks.rows[0].n}`);
  console.log(`\n  ${tables.rows.map((r) => r.table_name).join(', ')}`);

  // Smoke-test the parts that matter most: vector search, FTS, trigram, constraints.
  console.log('\n--- functional smoke tests ---');

  await db.exec(`
    INSERT INTO faculties (name_ar, name_en, slug) VALUES ('كلية الإعلام','College of Media','media');
    INSERT INTO research (title_ar, abstract_ar, publication_year, language, status, access_level)
    VALUES ('اتجاهات الإعلاميين نحو الذكاء الاصطناعي','دراسة حول استخدام تقنيات الذكاء الاصطناعي في إنتاج المحتوى', 2025, 'ar', 'published', 'public');
  `);

  const fts = await db.query<{ title_ar: string; rank: number }>(
    `SELECT title_ar, ts_rank(search_vector, websearch_to_tsquery('research_ar','الإعلاميين')) AS rank
     FROM research WHERE search_vector @@ websearch_to_tsquery('research_ar','الإعلاميين')`,
  );
  console.log(`  Arabic FTS match       : ${fts.rows.length} row(s), rank=${fts.rows[0]?.rank ?? '-'}`);

  const research = await db.query<{ id: string }>('SELECT id FROM research LIMIT 1');
  const researchId = research.rows[0].id;

  await db.query(
    `INSERT INTO research_files (research_id, original_filename, stored_path, mime_type, file_kind, size_bytes, sha256, page_count, is_canonical)
     VALUES ($1,'t.pdf','/s/t.pdf','application/pdf','pdf',1,'abc',10,true)`,
    [researchId],
  );
  const file = await db.query<{ id: string }>('SELECT id FROM research_files LIMIT 1');

  await db.query(
    `INSERT INTO research_chunks (research_id, file_id, chunk_index, text, page_number, token_count, char_count, language, content_hash)
     VALUES ($1,$2,0,'الذكاء الاصطناعي في إنتاج المحتوى الإعلامي',5,20,40,'ar','h1')`,
    [researchId, file.rows[0].id],
  );
  const chunk = await db.query<{ id: string }>('SELECT id FROM research_chunks LIMIT 1');

  const embedding = `[${Array.from({ length: 1536 }, (_, i) => (i % 7) / 10).join(',')}]`;
  await db.query(
    `INSERT INTO research_embeddings (chunk_id, research_id, embedding, model) VALUES ($1,$2,$3::vector,'gemini-embedding-001')`,
    [chunk.rows[0].id, researchId, embedding],
  );
  const knn = await db.query<{ distance: number }>(
    `SELECT embedding <=> $1::vector AS distance FROM research_embeddings ORDER BY distance LIMIT 1`,
    [embedding],
  );
  console.log(`  pgvector cosine search : distance=${knn.rows[0].distance}`);

  const trgm = await db.query<{ sim: number }>(
    `SELECT similarity('ناصر رياض الناصر','ناصر رياض ناصر') AS sim`,
  );
  console.log(`  pg_trgm fuzzy names    : similarity=${trgm.rows[0].sim}`);

  // Constraint enforcement checks.
  const expectFailure = async (label: string, statement: string): Promise<void> => {
    try {
      await db.exec(statement);
      console.log(`  ${label}: NOT ENFORCED  <-- problem`);
      process.exitCode = 1;
    } catch {
      console.log(`  ${label}: enforced`);
    }
  };

  await expectFailure(
    'embargo requires date  ',
    `INSERT INTO research (title_en, access_level) VALUES ('X','embargoed')`,
  );
  await expectFailure(
    'research needs a title ',
    `INSERT INTO research (publication_year) VALUES (2020)`,
  );
  await expectFailure(
    'one canonical file only',
    `INSERT INTO research_files (research_id, original_filename, stored_path, mime_type, file_kind, size_bytes, sha256, is_canonical)
     SELECT id,'t2.pdf','/s/t2.pdf','application/pdf','pdf',1,'def',true FROM research WHERE title_ar IS NOT NULL LIMIT 1`,
  );
  await expectFailure(
    'empty chunk rejected   ',
    `INSERT INTO research_chunks (research_id, chunk_index, text, page_number, token_count, char_count, content_hash)
     SELECT id, 99, '   ', 1, 0, 0, 'h9' FROM research LIMIT 1`,
  );

  // updated_at trigger.
  const before = await db.query<{ updated_at: string }>('SELECT updated_at FROM research LIMIT 1');
  await db.exec(`UPDATE research SET view_count = view_count + 1`);
  const after = await db.query<{ updated_at: string }>('SELECT updated_at FROM research LIMIT 1');
  console.log(`  updated_at trigger     : ${before.rows[0].updated_at !== after.rows[0].updated_at ? 'fires' : 'DID NOT FIRE  <-- problem'}`);

  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
