/**
 * Retry the pages that the first OCR pass declined to replace.
 *
 * The initial guards were tuned for the common case and rejected 48 pages.
 * This pass reports the exact reason per page and applies two corrections:
 *
 *  1. Higher render scale (3x). Dense body text at 2x can transcribe partially,
 *     which then trips the length guard.
 *  2. A length guard aware that corrupted Arabic is INFLATED — broken ligatures
 *     and spurious spaces add characters — so a correct transcription of a badly
 *     corrupted page is legitimately shorter than the original.
 *
 * Pages with no text layer at all (figures, charts) are reported separately:
 * OCR cannot extract text that was never there, and that is not a failure.
 *
 * Usage: node dist/scripts/ocr-retry-flagged.js [--dry-run] [--scale N] [--concurrency N]
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

async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]);
      }
    }),
  );
  return results;
}

interface Target {
  id: string;
  research_id: string;
  file_id: string;
  page_number: number;
  text: string;
  stored_path: string;
  title: string;
}

async function main(): Promise<void> {
  const logger = new Logger('OcrRetry');
  const dryRun = process.argv.includes('--dry-run');
  const scale = Number(arg('scale') ?? 3);
  const concurrency = Number(arg('concurrency') ?? 12);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const ocr = app.get(OcrService);
  const structure = app.get(StructureService);
  const ingest = app.get(IngestService);
  const dataSource = app.get(DataSource);

  const rows = await dataSource.query<Target[]>(
    `SELECT p.id, p.research_id, p.file_id, p.page_number, p.text, f.stored_path,
            left(COALESCE(r.title_ar, r.title_en), 38) AS title
     FROM research_pages p
     JOIN research r ON r.id = p.research_id
     JOIN research_files f ON f.id = p.file_id
     WHERE p.text_source = 'pdf_text_layer' AND f.file_kind = 'pdf'
     ORDER BY r.created_at, p.page_number`,
  );

  const targets = rows.filter((r) => assessPage(r.text).needsOcr);
  const noTextLayer = targets.filter((r) => r.text.trim().length < 120);
  const realText = targets.filter((r) => r.text.trim().length >= 120);

  logger.log(`${targets.length} flagged pages: ${realText.length} with real text, ${noTextLayer.length} with no text layer`);
  if (dryRun) {
    for (const t of targets) {
      const a = assessPage(t.text);
      logger.log(`  p.${t.page_number} ${String(t.text.trim().length).padStart(5)}ch ${a.quality} rate=${a.impossiblePrefixRate} — ${t.title}`);
    }
    await app.close();
    return;
  }

  const touchedResearch = new Set<string>();
  let replaced = 0;
  let stillRejected = 0;
  let emptyPages = 0;
  let tokens = 0;
  const bufferCache = new Map<string, Buffer>();

  const outcomes = await pool([...realText, ...noTextLayer], concurrency, async (target) => {
    try {
      let buffer = bufferCache.get(target.stored_path);
      if (!buffer) {
        buffer = await readFile(target.stored_path);
        bufferCache.set(target.stored_path, buffer);
      }

      const png = await ocr.renderPage(buffer, target.page_number, scale);
      const transcription = await ocr.transcribe(png);

      if (transcription === null) {
        // Nothing on the page to read — a figure or chart, not a failure.
        return { target, action: 'empty' as const, detail: 'no text in image', tokens: 0 };
      }
      tokens += transcription.tokens;

      const before = assessPage(target.text);
      const after = assessPage(transcription.text);

      // Corrupted Arabic is inflated, so require only that the transcription is
      // not a drastic truncation. Heavily corrupted originals get more slack.
      const ratio = transcription.text.length / Math.max(1, target.text.trim().length);
      const floor = before.impossiblePrefixRate > 20 ? 0.3 : 0.5;
      if (ratio < floor && target.text.trim().length > 400) {
        return {
          target, action: 'rejected' as const,
          detail: `truncated ${ratio.toFixed(2)}x (floor ${floor})`, tokens: transcription.tokens,
        };
      }

      const improved =
        after.impossiblePrefixRate < before.impossiblePrefixRate || before.quality === 'no_text';
      if (!improved) {
        return {
          target, action: 'rejected' as const,
          detail: `no gain ${before.impossiblePrefixRate} -> ${after.impossiblePrefixRate}`,
          tokens: transcription.tokens,
        };
      }

      await dataSource.query(
        `UPDATE research_pages SET text = $2, char_count = $3, text_source = 'vision_ocr' WHERE id = $1`,
        [target.id, transcription.text, transcription.text.length],
      );
      return {
        target, action: 'replaced' as const,
        detail: `${before.impossiblePrefixRate} -> ${after.impossiblePrefixRate}`,
        tokens: transcription.tokens,
      };
    } catch (error) {
      return { target, action: 'error' as const, detail: (error as Error).message.slice(0, 90), tokens: 0 };
    }
  });

  for (const outcome of outcomes) {
    const label = `p.${String(outcome.target.page_number).padStart(3)} ${outcome.target.title}`;
    if (outcome.action === 'replaced') {
      replaced += 1;
      touchedResearch.add(outcome.target.research_id);
      logger.log(`  REPLACED ${label} (${outcome.detail})`);
    } else if (outcome.action === 'empty') {
      emptyPages += 1;
      logger.log(`  NO TEXT  ${label} (${outcome.detail})`);
    } else {
      stillRejected += 1;
      logger.warn(`  REJECTED ${label} (${outcome.detail})`);
    }
  }

  // Rebuild chunks and vectors for every research whose pages changed.
  for (const researchId of touchedResearch) {
    const pages = await dataSource.query<Array<{ page_number: number; text: string }>>(
      `SELECT page_number, text FROM research_pages WHERE research_id = $1 ORDER BY page_number`,
      [researchId],
    );
    const parsed = pages.map((p) => ({
      pageNumber: p.page_number, text: p.text, charCount: p.text.length, likelyScanned: false,
    }));
    const fullText = parsed.map((p) => p.text).join('\n\n');
    const sections = structure.detectSections(parsed);
    const chunks = structure.chunk(parsed, sections);
    const [file] = await dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM research_files WHERE research_id = $1 AND is_canonical LIMIT 1`, [researchId]);

    await dataSource.transaction(async (manager) => {
      await manager.query(`DELETE FROM research_chunks WHERE research_id = $1`, [researchId]);
      await manager.query(`DELETE FROM research_sections WHERE research_id = $1`, [researchId]);
      await manager.query(
        `UPDATE research SET full_text = $2, language = $3 WHERE id = $1`,
        [researchId, fullText, detectLanguage(fullText)],
      );
      const sectionIds = new Map<string, string>();
      let order = 0;
      for (const section of sections) {
        const [row] = await manager.query<Array<{ id: string }>>(
          `INSERT INTO research_sections (research_id, name, heading, start_page, end_page, section_order)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [researchId, section.name, section.heading, section.startPage, section.endPage, order++]);
        sectionIds.set(section.name, row.id);
      }
      for (const chunk of chunks) {
        await manager.query(
          `INSERT INTO research_chunks
             (research_id, file_id, section_id, chunk_index, text, page_number, section_name,
              heading, token_count, char_count, language, is_overlap, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [researchId, file?.id ?? null, sectionIds.get(chunk.sectionName) ?? null, chunk.chunkIndex,
           chunk.text, chunk.pageNumber, chunk.sectionName, chunk.heading, chunk.tokenCount,
           chunk.charCount, chunk.language, chunk.isOverlap,
           createHash('sha256').update(chunk.text).digest('hex')]);
      }
    });

    const embedded = await ingest.embedResearch(researchId);
    logger.log(`  rebuilt ${chunks.length} chunks / ${embedded.embedded} vectors — ${researchId.slice(0, 8)}`);
  }

  console.log('\n=== RETRY SUMMARY ===');
  console.log(`  pages retried    : ${targets.length}`);
  console.log(`  replaced         : ${replaced}`);
  console.log(`  no text in image : ${emptyPages} (figures/charts — nothing to extract)`);
  console.log(`  still rejected   : ${stillRejected}`);
  console.log(`  research rebuilt : ${touchedResearch.size}`);
  console.log(`  tokens used      : ${tokens}`);

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
