/**
 * Repair corrupted Arabic text layers with vision OCR.
 *
 * For each research whose stored pages show the lam-alef corruption:
 *   1. OCR only the pages that actually need it (clean pages are left alone)
 *   2. Replace page text ONLY when the result is measurably cleaner
 *   3. Rebuild full_text, sections and chunks from the repaired pages
 *   4. Re-embed the rebuilt chunks
 *
 * Fully resumable: pages already marked text_source='vision_ocr' are skipped,
 * so an interrupted run continues where it stopped.
 *
 * Usage:
 *   node dist/scripts/ocr-repair.js [--limit N] [--concurrency N] [--dry-run] [--research <uuid>]
 */
import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { OcrService } from '../ingest/ocr.service';
import { StructureService } from '../ingest/structure.service';
import { IngestService } from '../ingest/ingest.service';
import { assessPage } from '../ingest/arabic-quality';
import { detectLanguage } from '../ingest/document-parser.service';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
loadEnv({ path: resolve(REPO_ROOT, '.env'), quiet: true });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Run tasks with bounded concurrency, preserving input order in the results. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

interface PageRow {
  id: string;
  page_number: number;
  text: string;
  text_source: string;
}

async function main(): Promise<void> {
  const logger = new Logger('OcrRepair');
  const dryRun = process.argv.includes('--dry-run');
  const limit = arg('limit') ? Number(arg('limit')) : Infinity;
  const concurrency = Number(arg('concurrency') ?? 6);
  const onlyResearch = arg('research');

  // 'log' must be enabled or this script's own progress output is swallowed.
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const ocr = app.get(OcrService);
  const structure = app.get(StructureService);
  const ingest = app.get(IngestService);
  const dataSource = app.get(DataSource);

  // Candidate PDFs: canonical file is a PDF and pages are not already OCR'd.
  const candidates = await dataSource.query<Array<{
    research_id: string; file_id: string; stored_path: string; title: string;
  }>>(
    `SELECT r.id AS research_id, f.id AS file_id, f.stored_path,
            left(COALESCE(r.title_ar, r.title_en), 46) AS title
     FROM research r
     JOIN research_files f ON f.research_id = r.id AND f.is_canonical AND f.deleted_at IS NULL
     WHERE r.deleted_at IS NULL
       AND f.file_kind = 'pdf'
       ${onlyResearch ? 'AND r.id = $1::uuid' : ''}
     ORDER BY r.created_at`,
    onlyResearch ? [onlyResearch] : [],
  );

  logger.log(`${candidates.length} PDF-backed research records to inspect`);

  let processed = 0;
  let pagesOcrd = 0;
  let pagesReplaced = 0;
  let pagesRejected = 0;
  let tokensUsed = 0;
  let researchRepaired = 0;
  let pagesNeedingOcr = 0;
  let researchNeedingOcr = 0;

  for (const candidate of candidates) {
    if (processed >= limit) break;
    processed += 1;

    const pages = await dataSource.query<PageRow[]>(
      `SELECT id, page_number, text, text_source FROM research_pages
       WHERE research_id = $1 ORDER BY page_number`,
      [candidate.research_id],
    );
    if (pages.length === 0) continue;

    // Only pages that are still on the original text layer AND look corrupted.
    const targets = pages.filter(
      (p) => p.text_source !== 'vision_ocr' && assessPage(p.text).needsOcr,
    );

    if (targets.length === 0) {
      logger.log(`[${processed}/${candidates.length}] clean, skipping — ${candidate.title}`);
      continue;
    }

    pagesNeedingOcr += targets.length;
    researchNeedingOcr += 1;
    logger.log(`[${processed}/${candidates.length}] ${targets.length}/${pages.length} pages need OCR — ${candidate.title}`);
    if (dryRun) continue;

    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await readFile(candidate.stored_path);
    } catch (error) {
      logger.error(`  cannot read ${candidate.stored_path}: ${(error as Error).message}`);
      continue;
    }

    const outcomes = await pool(targets, concurrency, async (page) => {
      try {
        const result = await ocr.repairPage(candidate.stored_path, page.page_number, page.text, pdfBuffer);
        return { page, ...result, error: null as string | null };
      } catch (error) {
        return {
          page, text: page.text, replaced: false,
          reason: 'error', tokens: 0, error: (error as Error).message,
        };
      }
    });

    let replacedHere = 0;
    for (const outcome of outcomes) {
      pagesOcrd += 1;
      tokensUsed += outcome.tokens;

      if (outcome.error) {
        logger.warn(`  p.${outcome.page.page_number} failed: ${outcome.error.slice(0, 90)}`);
        continue;
      }
      if (!outcome.replaced) {
        pagesRejected += 1;
        continue;
      }

      await dataSource.query(
        `UPDATE research_pages
         SET text = $2, char_count = $3, text_source = 'vision_ocr'
         WHERE id = $1`,
        [outcome.page.id, outcome.text, outcome.text.length],
      );
      replacedHere += 1;
      pagesReplaced += 1;
    }

    if (replacedHere === 0) {
      logger.log(`  no pages improved; leaving original text`);
      continue;
    }

    // ---- rebuild derived data from the repaired pages ----
    const repaired = await dataSource.query<Array<{ page_number: number; text: string }>>(
      `SELECT page_number, text FROM research_pages WHERE research_id = $1 ORDER BY page_number`,
      [candidate.research_id],
    );
    const parsedPages = repaired.map((p) => ({
      pageNumber: p.page_number,
      text: p.text,
      charCount: p.text.length,
      likelyScanned: false,
    }));

    const fullText = parsedPages.map((p) => p.text).join('\n\n');
    const sections = structure.detectSections(parsedPages);
    const chunks = structure.chunk(parsedPages, sections);

    await dataSource.transaction(async (manager) => {
      // Embeddings cascade from chunks, so old vectors are removed with them.
      await manager.query(`DELETE FROM research_chunks WHERE research_id = $1`, [candidate.research_id]);
      await manager.query(`DELETE FROM research_sections WHERE research_id = $1`, [candidate.research_id]);

      await manager.query(
        `UPDATE research SET full_text = $2, language = $3, text_source = 'vision_ocr' WHERE id = $1`,
        [candidate.research_id, fullText, detectLanguage(fullText)],
      );

      const sectionIds = new Map<string, string>();
      let order = 0;
      for (const section of sections) {
        const [row] = await manager.query<Array<{ id: string }>>(
          `INSERT INTO research_sections (research_id, name, heading, start_page, end_page, section_order)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [candidate.research_id, section.name, section.heading, section.startPage, section.endPage, order++],
        );
        sectionIds.set(section.name, row.id);
      }

      for (const chunk of chunks) {
        await manager.query(
          `INSERT INTO research_chunks
             (research_id, file_id, section_id, chunk_index, text, page_number, section_name,
              heading, token_count, char_count, language, is_overlap, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [candidate.research_id, candidate.file_id, sectionIds.get(chunk.sectionName) ?? null,
           chunk.chunkIndex, chunk.text, chunk.pageNumber, chunk.sectionName, chunk.heading,
           chunk.tokenCount, chunk.charCount, chunk.language, chunk.isOverlap,
           createHash('sha256').update(chunk.text).digest('hex')],
        );
      }
    });

    const embedResult = await ingest.embedResearch(candidate.research_id);
    researchRepaired += 1;
    logger.log(
      `  repaired ${replacedHere} pages · ${sections.length} sections · ${chunks.length} chunks · ${embedResult.embedded} vectors`,
    );
  }

  // Flash-lite pricing; input dominated by the page image.
  const estimatedCost = (tokensUsed / 1e6) * 0.4;

  console.log('\n=== OCR REPAIR SUMMARY ===');
  console.log(`  research inspected: ${processed}`);
  console.log(`  research needing  : ${researchNeedingOcr}`);
  console.log(`  pages needing OCR : ${pagesNeedingOcr}`);
  if (dryRun) {
    // ~1,500 input tokens (page image) + ~900 output tokens per page, measured.
    const projected = (pagesNeedingOcr * 1500 * 0.1 + pagesNeedingOcr * 900 * 0.4) / 1e6;
    console.log(`  projected cost    : ~$${projected.toFixed(2)}  (dry run — nothing changed)`);
    await app.close();
    return;
  }
  console.log(`  research repaired : ${researchRepaired}`);
  console.log(`  pages OCR'd       : ${pagesOcrd}`);
  console.log(`  pages replaced    : ${pagesReplaced}`);
  console.log(`  pages kept as-is  : ${pagesRejected} (OCR was not an improvement)`);
  console.log(`  tokens used       : ${tokensUsed}`);
  console.log(`  approx. cost      : $${estimatedCost.toFixed(2)}`);

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
