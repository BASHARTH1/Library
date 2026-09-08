/**
 * Extract the abstract of every research that has none, and store it.
 *
 * Most of the corpus was ingested without an abstract: the section detector in
 * StructureService marks where the abstract *starts*, but the span runs to the
 * next detected heading, so it is far too broad to store verbatim. This script
 * hands that span to Gemini and asks it to return only the abstract itself.
 *
 * `similar` and the recommendations rank on abstract_embedding, and that vector
 * cannot exist without abstract text, so a paper without one is invisible to
 * both. Filling the text here is what makes those features work; run
 * `npm run api:embed` afterwards to write the vectors.
 *
 * Nothing is invented: a candidate is rejected unless its opening is found in
 * the source text, so a hallucinated abstract is never written. Idempotent —
 * only papers still missing an abstract are considered, so it is safe to re-run
 * after a quota stop.
 *
 * Usage: npm run api:extract-abstracts [-- --limit N] [-- --dry-run]
 */
import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { GeminiService } from '../gemini/gemini.service';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
loadEnv({ path: resolve(REPO_ROOT, '.env'), quiet: true });
// Same reasoning as seed-auth: .env.local carries the Neon URL the deployment
// serves from. Without the override this would edit the local database.
loadEnv({ path: resolve(REPO_ROOT, '.env.local'), override: true, quiet: true });

/** An abstract shorter than this is a heading fragment, not an abstract. */
const MIN_ABSTRACT_CHARS = 200;
/** Postgres holds more, but a thesis abstract past this is a mis-extraction. */
const MAX_ABSTRACT_CHARS = 6000;
/** Enough context to cover a title page, a TOC and the abstract that follows. */
const MAX_CONTEXT_CHARS = 24000;
/** How much of the opening must appear in the source for the text to be real. */
const PROVENANCE_PROBE_CHARS = 40;

const SYSTEM_INSTRUCTION = `You extract abstracts from Arabic and English master's theses.

Return the abstract EXACTLY as written in the source. Never summarise, translate,
rewrite, correct or complete it. Copy the wording verbatim.

The text you receive is raw OCR output: it may contain a title page, a table of
contents and page numbers around the abstract. Return only the abstract body —
not its heading ("المستخلص", "ABSTRACT"), not the title page, not the keywords
line that follows it.

A thesis often carries the same abstract twice, once in Arabic and once in
English. Return whichever are present. If one is absent, return null for it.
If the text contains no abstract at all, return null for both. Returning null is
correct and expected; inventing text is not.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    abstractAr: { type: ['string', 'null'], description: 'The Arabic abstract, verbatim, or null.' },
    abstractEn: { type: ['string', 'null'], description: 'The English abstract, verbatim, or null.' },
  },
  required: ['abstractAr', 'abstractEn'],
} as const;

interface Extracted {
  abstractAr: string | null;
  abstractEn: string | null;
}

/** Whitespace is unreliable in OCR text, so compare with it removed. */
function normalise(text: string): string {
  return text.replace(/\s+/gu, '');
}

/**
 * True when the extracted text demonstrably came from the source.
 *
 * The opening is probed rather than the whole string: the model legitimately
 * drops a trailing keywords line or a page number, but it has no reason to
 * change the first words of a passage it was told to copy.
 */
function cameFromSource(candidate: string, source: string): boolean {
  const probe = normalise(candidate).slice(0, PROVENANCE_PROBE_CHARS);
  return probe.length > 0 && normalise(source).includes(probe);
}

function clean(value: string | null, source: string, logger: Logger, label: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length < MIN_ABSTRACT_CHARS) {
    logger.warn(`  ${label}: ${trimmed.length} chars, below the ${MIN_ABSTRACT_CHARS} minimum — discarded`);
    return null;
  }
  if (!cameFromSource(trimmed, source)) {
    logger.warn(`  ${label}: opening not found in the source text — discarded as unverifiable`);
    return null;
  }
  return trimmed.slice(0, MAX_ABSTRACT_CHARS);
}

async function main(): Promise<void> {
  const logger = new Logger('ExtractAbstracts');
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const gemini = app.get(GeminiService);
  const dataSource = app.get(DataSource);

  const targets = await dataSource.query<Array<{ id: string; title: string }>>(
    `SELECT id, left(COALESCE(title_ar, title_en), 60) AS title
     FROM research
     WHERE deleted_at IS NULL
       AND COALESCE(NULLIF(btrim(abstract_ar), ''), NULLIF(btrim(abstract_en), '')) IS NULL
     ORDER BY publication_year DESC NULLS LAST`,
  );

  const queue = targets.slice(0, limit);
  console.log(`${targets.length} papers without an abstract; processing ${queue.length}${dryRun ? ' (dry run)' : ''}\n`);

  let written = 0;
  let empty = 0;
  let failed = 0;
  let tokens = 0;

  for (const [i, target] of queue.entries()) {
    const position = `[${i + 1}/${queue.length}]`;
    try {
      // Prefer the span the section detector already identified; fall back to
      // the opening of the paper, which is where an abstract otherwise sits.
      const [{ context }] = await dataSource.query<Array<{ context: string | null }>>(
        `WITH tagged AS (
           SELECT string_agg(text, E'\\n' ORDER BY chunk_index) AS text
           FROM (
             SELECT text, chunk_index FROM research_chunks
             WHERE research_id = $1 AND section_name IN ('abstract_ar', 'abstract_en')
             ORDER BY chunk_index LIMIT 12
           ) t
         ),
         opening AS (
           SELECT string_agg(text, E'\\n' ORDER BY chunk_index) AS text
           FROM (
             SELECT text, chunk_index FROM research_chunks
             WHERE research_id = $1 ORDER BY chunk_index LIMIT 12
           ) o
         )
         SELECT COALESCE(NULLIF(btrim((SELECT text FROM tagged)), ''), (SELECT text FROM opening)) AS context`,
        [target.id],
      );

      if (!context || context.trim().length < MIN_ABSTRACT_CHARS) {
        logger.warn(`${position} no usable text — ${target.title}`);
        empty++;
        continue;
      }

      const source = context.slice(0, MAX_CONTEXT_CHARS);
      const result = await gemini.generate<Extracted>(
        `Extract the abstract from this thesis text.\n\n---\n${source}\n---`,
        {
          tier: 'chat',
          systemInstruction: SYSTEM_INSTRUCTION,
          responseSchema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
          temperature: 0,
          maxOutputTokens: 4096,
        },
      );
      tokens += result.usage?.totalTokens ?? 0;

      const ar = clean(result.data?.abstractAr ?? null, source, logger, 'ar');
      const en = clean(result.data?.abstractEn ?? null, source, logger, 'en');

      if (!ar && !en) {
        console.log(`${position} no abstract present — ${target.title}`);
        empty++;
        continue;
      }

      if (!dryRun) {
        await dataSource.query(
          `UPDATE research
           SET abstract_ar = COALESCE($2, abstract_ar),
               abstract_en = COALESCE($3, abstract_en),
               updated_at = now()
           WHERE id = $1`,
          [target.id, ar, en],
        );
      }
      written++;
      console.log(`${position} ar=${ar ? ar.length : '-'} en=${en ? en.length : '-'} — ${target.title}`);
    } catch (error) {
      const message = (error as Error).message;
      if (/quota|RESOURCE_EXHAUSTED/i.test(message)) {
        logger.warn(`Quota reached after ${written} abstracts. Re-run once it resets; progress is saved.`);
        break;
      }
      failed++;
      logger.error(`${position} failed — ${target.title}: ${message.slice(0, 160)}`);
    }
  }

  const [totals] = await dataSource.query<Array<{ total: string; with_abstract: string }>>(
    `SELECT count(*) total,
            count(COALESCE(NULLIF(btrim(abstract_ar), ''), NULLIF(btrim(abstract_en), ''))) with_abstract
     FROM research WHERE deleted_at IS NULL`,
  );

  console.log(`\nwritten            : ${written}`);
  console.log(`no abstract found  : ${empty}`);
  console.log(`failed             : ${failed}`);
  console.log(`tokens used        : ${tokens}`);
  console.log(`corpus coverage    : ${totals.with_abstract}/${totals.total} papers have an abstract`);
  if (written > 0 && !dryRun) {
    console.log(`\nRun \`npm run api:embed\` to write the abstract vectors that similar/recommendations rank on.`);
  }

  await app.close();
}

void main().catch((error) => {
  new Logger('ExtractAbstracts').error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
