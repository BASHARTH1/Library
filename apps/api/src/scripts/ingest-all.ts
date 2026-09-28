/**
 * Ingest the entire research folder.
 *
 * Design notes
 *  - 93 files are only 79 theses: 13 are stored as both a PDF and its Word
 *    source, and one PDF is filed under two year folders. Twins are merged into
 *    ONE research record with multiple research_files (canonical = PDF).
 *  - Text is taken from the cleanest available source: a clean PDF layer, else a
 *    clean Word twin, else the corrupted PDF (until the OCR stage exists).
 *  - Later deliveries also hold theses as a FOLDER of parts (cover, chapters,
 *    references, appendices). The folder is one thesis: a complete PDF/Word file
 *    inside it is used when there is one, otherwise the parts are joined in
 *    reading order.
 *  - A thesis whose file is already in the database (same SHA-256) is skipped,
 *    never re-ingested: IngestService replaces a research on a checksum match,
 *    which would drop its abstract, OCR repairs and conversations.
 *  - Embeddings are attempted but never required. When the Gemini daily quota is
 *    exhausted the content is still ingested and fully full-text searchable;
 *    run `npm run api:embed` later to backfill.
 *
 * Writes to the database in .env.local (Neon, what the deployment serves) —
 * the same target as embed-pending and extract-abstracts.
 *
 * Usage:
 *   node dist/scripts/ingest-all.js [--batch NAME] [--dry-run] [--limit N] [--no-embed] [--faculty "..."]
 *
 *   --batch NAME  read reports/folder-analysis-NAME.json and
 *                 reports/arabic-diagnosis-NAME.json (from the inspector run
 *                 with the same --batch) instead of the first corpus's reports
 *   --dry-run     print and save the grouping plan; write nothing
 */
import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { IngestService, type IngestInput } from '../ingest/ingest.service';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
loadEnv({ path: resolve(REPO_ROOT, '.env'), quiet: true });
// The deployment serves the Neon corpus; the local database is no longer kept
// in sync with it, so new theses go straight to Neon.
loadEnv({ path: resolve(REPO_ROOT, '.env.local'), override: true, quiet: true });

interface InventoryFile {
  absolutePath: string;
  relativePath: string;
  originalFilename: string;
  kind: string;
  health: string;
  sha256: string;
  pageCount: number | null;
  totalTextChars: number;
  facultyFolder: string | null;
  yearFolder: number | null;
  /** Absent from reports written before thesis folders were recognised. */
  thesisFolder?: string | null;
  filenameTitleGuess: string | null;
  filenameAuthorGuess: string | null;
  detectedLanguage: string;
}

interface DiagnosisRow {
  filename: string;
  relativePath?: string;
  severity: 'clean' | 'ligature_only' | 'severe';
}

/** How a group of files becomes one research record. */
interface ThesisPlan {
  key: string;
  display: InventoryFile;
  /** Single file the text comes from (whole-thesis mode). */
  textSource: InventoryFile | null;
  /** Ordered part files the text is joined from (folder-of-parts mode). */
  parts: InventoryFile[];
  additional: InventoryFile[];
  mode: 'file' | 'parts';
}

/** A PDF this long, or a Word file with this much text, is a whole thesis rather than a chapter. */
const WHOLE_PDF_MIN_PAGES = 50;
const WHOLE_WORD_MIN_CHARS = 100_000;
/** Readable parts adding up to less than this are a cover or abstract, not the thesis. */
const PARTS_MIN_CHARS = 30_000;

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

const ORDINALS: Array<[RegExp, number]> = [
  [/الاول|الأول|^أول|^اول|first|\b1\b|١/i, 1],
  [/الثاني|second|\b2\b|٢/i, 2],
  [/الثالث|third|\b3\b|٣/i, 3],
  [/الرابع|fourth|\b4\b|٤/i, 4],
  [/الخامس|fifth|\b5\b|٥/i, 5],
  [/السادس|sixth|\b6\b|٦/i, 6],
  [/السابع|seventh|\b7\b|٧/i, 7],
];

/**
 * Reading-order rank of a thesis part from its path: front matter, chapters in
 * order, references, appendices. Parts arrive named "غلاف", "ف2", "الفصل الثالث",
 * "المراجع", "ملحق 7/..." and so on.
 */
function partRank(file: InventoryFile): number {
  // Only the path below the thesis folder: the folder's own name is the title
  // and would match these patterns by accident.
  const segments = file.relativePath.split(/[\\/]/);
  const path = segments.slice(file.thesisFolder ? segments.indexOf(file.thesisFolder) + 1 : -1).join('/');
  const name = file.originalFilename;
  if (/ملحق|ملاحق|appendi/i.test(path)) return 900;
  if (/مراجع|references|bibliograph/i.test(name)) return 800;
  if (/فهرس|^فه\s*\d|محتويات|contents/i.test(name)) return 70;
  // "الفصل الثالث/...", "ف2.doc", "ف1 إطار الدراسة.doc", "Chapter 4.docx"
  const chapter = /(?:^|[\s/_(-])(?:الفصل|فصل|chapter|ف)\s*[-_]?\s*([^\s/]+)/i.exec(path);
  if (chapter) {
    for (const [pattern, n] of ORDINALS) if (pattern.test(chapter[1])) return 100 + n * 10;
  }
  if (/غلاف|cover|عنوان|title/i.test(name)) return 10;
  if (/آية|اية|بسمل/i.test(name)) return 20;
  if (/توقيع|تواقيع|اجاز|إجاز|لجنة|الدرجة/i.test(name)) return 30;
  if (/اهداء|إهداء|dedicat/i.test(name)) return 40;
  if (/شكر|acknowledg/i.test(name)) return 50;
  if (/مستخلص|ملخص|abstract|summary/i.test(name)) return 60;
  if (/ترجمة|انجليزي|إنجليزي|english/i.test(name)) return 75;
  return 500;
}

function pickLargest(files: InventoryFile[], size: (f: InventoryFile) => number): InventoryFile | undefined {
  return [...files].sort((a, b) => size(b) - size(a))[0];
}

/** A file whose text layer can be read (a scanned PDF can be shown, not read). */
const readable = (f: InventoryFile) => f.health === 'ok';

/**
 * PDF is the display file, a Word twin rides along, text comes from the
 * cleanest readable one. A scanned PDF can still be the display file when a
 * readable twin supplies the text.
 */
function planWholeFile(key: string, candidates: InventoryFile[], severityOf: (f: InventoryFile) => string): ThesisPlan | null {
  const pdf = pickLargest(candidates.filter((f) => f.kind === 'pdf'), (f) => f.pageCount ?? 0);
  const word = pickLargest(candidates.filter((f) => f.kind !== 'pdf' && readable(f)), (f) => f.totalTextChars);
  const display = (pdf ?? word)!;

  const readablePdf = pdf && readable(pdf) ? pdf : undefined;
  const textSource =
    [readablePdf, word].find((f) => f && severityOf(f) === 'clean') ?? readablePdf ?? word;
  if (!textSource) return null;

  return {
    key,
    display,
    textSource,
    parts: [],
    additional: candidates.filter((f) => f !== display),
    mode: 'file',
  };
}

function planGroup(key: string, files: InventoryFile[], severityOf: (f: InventoryFile) => string): ThesisPlan | null {
  const loose = files.filter((f) => !f.thesisFolder);
  const nested = files.filter((f) => f.thesisFolder);

  // A standalone PDF/Word next to the folder is the complete thesis; the folder
  // only holds its sources, so none of it needs to be stored again.
  if (loose.length > 0) {
    const plan = planWholeFile(key, loose, severityOf);
    if (plan) return plan;
  }

  const wholePdfs = nested.filter((f) => f.kind === 'pdf' && (f.pageCount ?? 0) >= WHOLE_PDF_MIN_PAGES);
  const wholeWords = nested.filter((f) => f.kind !== 'pdf' && readable(f) && f.totalTextChars >= WHOLE_WORD_MIN_CHARS);
  if (wholePdfs.length > 0 || wholeWords.length > 0) {
    const plan = planWholeFile(key, [...wholePdfs, ...wholeWords], severityOf);
    if (plan) return plan;
  }

  // Only parts: join the Word parts when there are any (Word text has no
  // corrupted-ligature problem), otherwise the PDF parts.
  const words = nested.filter((f) => f.kind !== 'pdf' && readable(f));
  const chosen = words.length > 0 ? words : nested.filter(readable);
  if (chosen.reduce((sum, f) => sum + f.totalTextChars, 0) < PARTS_MIN_CHARS) return null;
  const parts = [...chosen].sort(
    (a, b) => partRank(a) - partRank(b) || a.relativePath.localeCompare(b.relativePath, 'ar', { numeric: true }),
  );
  const display = pickLargest(chosen, (f) => f.totalTextChars)!;
  return {
    key,
    display,
    textSource: null,
    parts,
    additional: parts.filter((f) => f !== display),
    mode: 'parts',
  };
}

/** Name parts too common to show that two author strings are the same person. */
const COMMON_NAME_TOKENS = new Set(['محمد', 'عبدالله', 'احمد', 'علي', 'بن', 'بنت', 'al', 'abdulla', 'mohammed']);

function authorTokens(files: InventoryFile[]): Set<string> {
  const tokens = new Set<string>();
  for (const f of files) {
    for (const t of titleKey(f.filenameAuthorGuess ?? '').split(' ')) {
      if (t.length >= 3 && !COMMON_NAME_TOKENS.has(t)) tokens.add(t);
    }
  }
  return tokens;
}

/**
 * The 8-word title key misses copies of one thesis filed under a shortened
 * title ("…الموجهين الفنيين-محمد سعود العازمي/" next to "…الموجهين الفنيين في
 * المدارس المتوسطة…-محمد سعود العازمي.pdf") or a misspelt author. Merge two
 * groups when they share an identical file, or when faculty, year and the
 * opening title words agree and the author matches (or is missing from one),
 * or the PDFs have the same page count.
 */
function mergeDuplicateGroups(groups: Map<string, InventoryFile[]>): void {
  const keys = [...groups.keys()];
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k: string): string => (parent.get(k) === k ? k : find(parent.get(k)!));
  const union = (a: string, b: string) => parent.set(find(b), find(a));

  const bySha = new Map<string, string>();
  for (const [key, files] of groups) {
    for (const f of files) {
      const seen = bySha.get(f.sha256);
      if (seen) union(seen, key);
      else bySha.set(f.sha256, key);
    }
  }

  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = groups.get(keys[i])!;
      const b = groups.get(keys[j])!;
      if (a[0].facultyFolder !== b[0].facultyFolder || a[0].yearFolder !== b[0].yearFolder) continue;
      if (keys[i].split(' ').slice(0, 4).join(' ') !== keys[j].split(' ').slice(0, 4).join(' ')) continue;
      const authorsA = authorTokens(a);
      const authorsB = authorTokens(b);
      const sameAuthor =
        authorsA.size === 0 || authorsB.size === 0 || [...authorsA].some((t) => authorsB.has(t));
      const pagesA = new Set(a.filter((f) => f.kind === 'pdf').map((f) => f.pageCount));
      const samePages = b.some((f) => f.kind === 'pdf' && f.pageCount && pagesA.has(f.pageCount));
      if (sameAuthor || samePages) union(keys[i], keys[j]);
    }
  }

  for (const key of keys) {
    const root = find(key);
    if (root === key) continue;
    groups.set(root, [...groups.get(root)!, ...groups.get(key)!]);
    groups.delete(key);
  }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const logger = new Logger('IngestAll');
  const noEmbed = process.argv.includes('--no-embed');
  const dryRun = process.argv.includes('--dry-run');
  const limit = arg('limit') ? Number(arg('limit')) : Infinity;
  const facultyFilter = arg('faculty');
  const batch = arg('batch');
  const report = (base: string, ext: string) => resolve(REPO_ROOT, 'reports', batch ? `${base}-${batch}.${ext}` : `${base}.${ext}`);

  const inventory = JSON.parse(await readFile(report('folder-analysis', 'json'), 'utf8')) as {
    sourceDirectory?: string;
    files: InventoryFile[];
  };

  const diagnosis = JSON.parse(await readFile(report('arabic-diagnosis', 'json'), 'utf8')) as { rows: DiagnosisRow[] };
  // Part files share names across theses ("الفصل الأول.doc"), so match on the
  // relative path when the diagnosis has it.
  const severityByPath = new Map(diagnosis.rows.filter((r) => r.relativePath).map((r) => [r.relativePath!, r.severity]));
  const severityByName = new Map(diagnosis.rows.map((r) => [r.filename, r.severity]));
  const severityOf = (f: InventoryFile) =>
    severityByPath.get(f.relativePath) ?? severityByName.get(f.originalFilename) ?? 'clean';

  // ---- group files into logical theses ----------------------------------
  const groups = new Map<string, InventoryFile[]>();
  for (const file of inventory.files) {
    // Scanned PDFs are kept as display candidates; planGroup only reads text
    // from files with a usable text layer.
    if (!['ok', 'scanned', 'partially_scanned'].includes(file.health)) continue;
    if (facultyFilter && file.facultyFolder !== facultyFilter) continue;
    // A thesis folder and a standalone copy of the same thesis share a title,
    // so both are keyed on it and end up in one group.
    const key = titleKey(file.thesisFolder ?? file.originalFilename);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }

  mergeDuplicateGroups(groups);

  const plans: ThesisPlan[] = [];
  const unreadable: string[] = [];
  for (const [key, files] of groups) {
    const plan = planGroup(key, files, severityOf);
    if (plan) plans.push(plan);
    else unreadable.push(files[0].thesisFolder ?? files[0].relativePath);
  }
  logger.log(
    `${inventory.files.length} files -> ${plans.length} logical theses ` +
    `(${plans.filter((p) => p.mode === 'parts').length} joined from parts)`,
  );
  if (unreadable.length > 0) {
    logger.warn(`${unreadable.length} thesis(es) exist only as scans and need OCR before they can be ingested:`);
    for (const path of unreadable) logger.warn(`   ${path}`);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const ingest = app.get(IngestService);
  const dataSource = app.get(DataSource);
  const [{ db }] = await dataSource.query<Array<{ db: string }>>(`SELECT current_database() || '@' || inet_server_addr() AS db`);
  logger.log(`Target database: ${db ?? 'unknown'}${dryRun ? ' (dry run — nothing is written)' : ''}`);

  const existingResearch = async (sha256: string) => {
    const [row] = await dataSource.query<Array<{ chunks: string; embeddings: string; research_id: string }>>(
      `SELECT f.research_id,
              (SELECT count(*) FROM research_chunks c WHERE c.research_id = f.research_id) AS chunks,
              (SELECT count(*) FROM research_embeddings e WHERE e.research_id = f.research_id) AS embeddings
       FROM research_files f
       WHERE f.sha256 = $1 AND f.deleted_at IS NULL LIMIT 1`,
      [sha256],
    );
    return row;
  };

  if (dryRun) {
    const rows = [];
    for (const plan of plans.slice(0, limit)) {
      const existing = await existingResearch(plan.display.sha256);
      rows.push({
        status: existing ? 'already present' : 'new',
        mode: plan.mode,
        faculty: plan.display.facultyFolder,
        year: plan.display.yearFolder,
        title: plan.display.filenameTitleGuess,
        author: plan.display.filenameAuthorGuess,
        display: plan.display.relativePath,
        textFrom: plan.mode === 'parts' ? plan.parts.map((p) => p.relativePath) : [plan.textSource?.relativePath],
        additional: plan.additional.map((f) => f.relativePath),
      });
      console.log(
        `${existing ? 'SKIP' : 'NEW '} ${plan.mode.padEnd(5)} ${String(plan.display.yearFolder).padEnd(4)} ` +
        `${plan.mode === 'parts' ? `${String(plan.parts.length).padStart(2)} parts` : `${plan.textSource?.kind}-text`.padEnd(8)} ` +
        `${plan.key.slice(0, 60)}`,
      );
    }
    const planPath = report('ingest-plan', 'json');
    await writeFile(planPath, JSON.stringify({ generatedAt: new Date().toISOString(), theses: rows }, null, 2));
    console.log(`\n${rows.filter((r) => r.status === 'new').length} new, ${rows.filter((r) => r.status !== 'new').length} already present`);
    console.log(`Wrote ${planPath}`);
    await app.close();
    return;
  }

  const [job] = await dataSource.query<Array<{ id: string }>>(
    `INSERT INTO import_jobs (source_directory, status, total_files, started_at)
     VALUES ($1,'running',$2, now()) RETURNING id`,
    [inventory.sourceDirectory ?? process.env.RESEARCH_SOURCE_DIR ?? '', plans.length],
  );

  let done = 0;
  let failed = 0;
  let skipped = 0;
  let embeddedTotal = 0;
  let pendingTotal = 0;
  let quotaExhausted = noEmbed;
  let index = 0;

  for (const plan of plans) {
    index += 1;
    if (index > limit) break;
    const { key, display } = plan;

    const existing = await existingResearch(display.sha256);
    if (existing && Number(existing.chunks) > 0) {
      // Content already loaded — only try to finish its embeddings.
      const missing = Number(existing.chunks) - Number(existing.embeddings);
      if (missing > 0 && !quotaExhausted) {
        try {
          const r = await ingest.embedResearch(existing.research_id);
          embeddedTotal += r.embedded;
          logger.log(`[${index}/${plans.length}] backfilled ${r.embedded} vectors — ${key.slice(0, 45)}`);
        } catch (error) {
          quotaExhausted = /quota/i.test((error as Error).message);
          pendingTotal += missing;
          logger.warn(`[${index}/${plans.length}] embeddings deferred — ${(error as Error).message.slice(0, 90)}`);
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
        additionalFiles: plan.additional.map((f) => f.absolutePath),
        textSourcePath: plan.textSource?.absolutePath,
        textSourceParts: plan.parts.map((f) => f.absolutePath),
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
        `[${index}/${plans.length}] ${String(result.pages).padStart(3)}p ${String(result.chunks).padStart(4)}ch ` +
        `${String(result.embedded).padStart(4)}emb ${result.pendingEmbeddings > 0 ? `(${result.pendingEmbeddings} pending)` : ''} ` +
        `${plan.mode === 'parts' ? `${plan.parts.length}-parts` : `${plan.textSource?.kind}-text`} — ${key.slice(0, 42)}`,
      );
    } catch (error) {
      failed += 1;
      const message = (error as Error).message;
      await dataSource.query(`UPDATE import_files SET status='failed', finished_at=now() WHERE id=$1`, [importFile.id]);
      await dataSource.query(
        `INSERT INTO import_errors (import_file_id, stage, message) VALUES ($1,'ingest',$2)`,
        [importFile.id, message.slice(0, 2000)],
      );
      logger.error(`[${index}/${plans.length}] FAILED ${display.originalFilename.slice(0, 45)}: ${message.slice(0, 120)}`);
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
