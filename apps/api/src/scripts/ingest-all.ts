/**
 * Ingest the entire research folder.
 *
 * Design notes
 *  - 93 files are only 79 theses: 13 are stored as both a PDF and its Word
 *    source, and one PDF is filed under two year folders. Twins are merged into
 *    ONE research record with multiple research_files (canonical = PDF).
 *  - Text is taken from the cleanest available source: a clean PDF layer, else a
 *    clean Word twin, else the corrupted PDF (until the OCR stage exists).
 *  - Embeddings are attempted but never required. When the Gemini daily quota is
 *    exhausted the content is still ingested and fully full-text searchable;
 *    run `npm run api:embed` later to backfill.
 *
 * Usage:
 *   node dist/scripts/ingest-all.js [--limit N] [--no-embed] [--faculty "..."]
 */
import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { IngestService, type IngestInput } from '../ingest/ingest.service';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
loadEnv({ path: resolve(REPO_ROOT, '.env'), quiet: true });

interface InventoryFile {
  absolutePath: string;
  relativePath: string;
  originalFilename: string;
  kind: string;
  health: string;
  pageCount: number | null;
  facultyFolder: string | null;
  yearFolder: number | null;
  filenameTitleGuess: string | null;
  filenameAuthorGuess: string | null;
  detectedLanguage: string;
}

interface DiagnosisRow {
  filename: string;
  severity: 'clean' | 'ligature_only' | 'severe';
}

/** Normalized key used to recognise the same thesis stored in two formats. */
function titleKey(name: string): string {
  return name
    .replace(/\.(pdf|docx?)$/i, '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(' ');
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const logger = new Logger('IngestAll');
  const noEmbed = process.argv.includes('--no-embed');
  const limit = arg('limit') ? Number(arg('limit')) : Infinity;
  const facultyFilter = arg('faculty');

  const inventory = JSON.parse(
    await readFile(resolve(REPO_ROOT, 'reports', 'folder-analysis.json'), 'utf8'),
  ) as { files: InventoryFile[] };

  const diagnosis = JSON.parse(
    await readFile(resolve(REPO_ROOT, 'reports', 'arabic-diagnosis.json'), 'utf8'),
  ) as { rows: DiagnosisRow[] };
  const severityOf = new Map(diagnosis.rows.map((r) => [r.filename, r.severity]));

  // ---- group files into logical theses ----------------------------------
  const groups = new Map<string, InventoryFile[]>();
  for (const file of inventory.files) {
    if (file.health !== 'ok') continue;
    if (facultyFilter && file.facultyFolder !== facultyFilter) continue;
    const key = titleKey(file.originalFilename);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }

  logger.log(`${inventory.files.length} files -> ${groups.size} logical theses`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const ingest = app.get(IngestService);
  const dataSource = app.get(DataSource);

  const [job] = await dataSource.query<Array<{ id: string }>>(
    `INSERT INTO import_jobs (source_directory, status, total_files, started_at)
     VALUES ($1,'running',$2, now()) RETURNING id`,
    [process.env.RESEARCH_SOURCE_DIR ?? '', groups.size],
  );

  let done = 0;
  let failed = 0;
  let skipped = 0;
  let embeddedTotal = 0;
  let pendingTotal = 0;
  let quotaExhausted = noEmbed;
  let index = 0;

  for (const [key, files] of groups) {
    index += 1;
    if (index > limit) break;

    // PDF is the display file; a Word twin is stored alongside it.
    const pdf = files.find((f) => f.kind === 'pdf');
    const word = files.find((f) => f.kind === 'docx' || f.kind === 'doc');
    const display = pdf ?? word;
    if (!display) continue;

    const pdfSeverity = pdf ? (severityOf.get(pdf.originalFilename) ?? 'clean') : null;
    const wordSeverity = word ? (severityOf.get(word.originalFilename) ?? 'clean') : null;

    // Choose the cleanest text source available.
    let textSource = display;
    if (pdf && pdfSeverity === 'clean') textSource = pdf;
    else if (word && wordSeverity === 'clean') textSource = word;
    else textSource = display;

    const additional = files.filter((f) => f.absolutePath !== display.absolutePath).map((f) => f.absolutePath);

    const [existing] = await dataSource.query<Array<{ chunks: string; embeddings: string; research_id: string }>>(
      `SELECT f.research_id,
              (SELECT count(*) FROM research_chunks c WHERE c.research_id = f.research_id) AS chunks,
              (SELECT count(*) FROM research_embeddings e WHERE e.research_id = f.research_id) AS embeddings
       FROM research_files f
       WHERE f.original_filename = $1 AND f.deleted_at IS NULL LIMIT 1`,
      [display.originalFilename],
    );

    if (existing && Number(existing.chunks) > 0) {
      // Content already loaded — only try to finish its embeddings.
      const missing = Number(existing.chunks) - Number(existing.embeddings);
      if (missing > 0 && !quotaExhausted) {
        try {
          const r = await ingest.embedResearch(existing.research_id);
          embeddedTotal += r.embedded;
          logger.log(`[${index}/${groups.size}] backfilled ${r.embedded} vectors — ${key.slice(0, 45)}`);
        } catch (error) {
          quotaExhausted = /quota/i.test((error as Error).message);
          pendingTotal += missing;
          logger.warn(`[${index}/${groups.size}] embeddings deferred — ${(error as Error).message.slice(0, 90)}`);
        }
      } else {
        pendingTotal += Math.max(0, missing);
      }
      skipped += 1;
      continue;
    }

    const input: IngestInput = {
      absolutePath: display.absolutePath,
      facultyNameAr: display.facultyFolder,
      accessLevel: 'public',
      metadata: {
        // Bulk load uses filename/folder conventions plus rule-based parsing.
        // Gemini metadata enrichment runs later, per paper, in the review centre.
        titleAr: /[؀-ۿ]/.test(display.filenameTitleGuess ?? '') ? display.filenameTitleGuess : null,
        titleEn: /[؀-ۿ]/.test(display.filenameTitleGuess ?? '') ? null : display.filenameTitleGuess,
        authors: display.filenameAuthorGuess ? [display.filenameAuthorGuess] : [],
        supervisors: [],
        abstractAr: null,
        abstractEn: null,
        keywordsAr: [],
        keywordsEn: [],
        publicationYear: display.yearFolder,
        faculty: display.facultyFolder,
        department: null,
        degree: null,
        researchType: 'thesis',
        publicationType: 'master_thesis',
        doi: null,
      },
    };

    const [importFile] = await dataSource.query<Array<{ id: string }>>(
      `INSERT INTO import_files (import_job_id, absolute_path, relative_path, original_filename, status, started_at)
       VALUES ($1,$2,$3,$4,'processing', now())
       ON CONFLICT (import_job_id, absolute_path) DO UPDATE SET status='processing' RETURNING id`,
      [job.id, display.absolutePath, display.relativePath, display.originalFilename],
    );

    try {
      const result = await ingest.ingestFile(input, {
        embed: !quotaExhausted,
        additionalFiles: additional,
        textSourcePath: textSource.absolutePath,
      });

      embeddedTotal += result.embedded;
      pendingTotal += result.pendingEmbeddings;
      if (result.embeddingError && /quota/i.test(result.embeddingError)) quotaExhausted = true;

      await dataSource.query(
        `UPDATE import_files SET status=$2, completed_stage=$3, finished_at=now() WHERE id=$1`,
        [importFile.id, result.pendingEmbeddings > 0 ? 'requires_review' : 'published',
         result.pendingEmbeddings > 0 ? 'chunking' : 'embedding'],
      );

      done += 1;
      logger.log(
        `[${index}/${groups.size}] ${String(result.pages).padStart(3)}p ${String(result.chunks).padStart(4)}ch ` +
        `${String(result.embedded).padStart(4)}emb ${result.pendingEmbeddings > 0 ? `(${result.pendingEmbeddings} pending)` : ''} ` +
        `${textSource.kind}-text — ${key.slice(0, 42)}`,
      );
    } catch (error) {
      failed += 1;
      const message = (error as Error).message;
      await dataSource.query(`UPDATE import_files SET status='failed', finished_at=now() WHERE id=$1`, [importFile.id]);
      await dataSource.query(
        `INSERT INTO import_errors (import_file_id, stage, message) VALUES ($1,'ingest',$2)`,
        [importFile.id, message.slice(0, 2000)],
      );
      logger.error(`[${index}/${groups.size}] FAILED ${display.originalFilename.slice(0, 45)}: ${message.slice(0, 120)}`);
    }
  }

  await dataSource.query(
    `UPDATE import_jobs SET status='completed', processed_files=$2, failed_files=$3, finished_at=now() WHERE id=$1`,
    [job.id, done, failed],
  );

  console.log('\n=== INGEST SUMMARY ===');
  console.log(`  theses ingested : ${done}`);
  console.log(`  already present : ${skipped}`);
  console.log(`  failed          : ${failed}`);
  console.log(`  vectors written : ${embeddedTotal}`);
  console.log(`  vectors pending : ${pendingTotal}`);
  if (quotaExhausted) {
    console.log('\n  Embedding quota exhausted — content is ingested and full-text searchable.');
    console.log('  Run `npm run api:embed` after the quota resets to enable semantic search.');
  }

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
