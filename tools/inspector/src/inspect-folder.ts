/**
 * Phase 1, step 1: inspect the research folder.
 *
 * Walks RESEARCH_SOURCE_DIR read-only, fingerprints every file, parses text to
 * detect scanned/encrypted/corrupted documents, and writes a folder analysis
 * report to reports/ as JSON + Excel.
 *
 * Originals are never modified.
 */
import { readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { env, reportName } from './lib/env.js';
import {
  classifyExtension,
  detectLanguage,
  detectMagicType,
  determineHealth,
  extractDocument,
  fileTimestamps,
  magicMatchesKind,
  parseFilename,
  parsePathContext,
  sha256File,
} from './lib/file-analysis.js';
import { writeJson, writeWorkbook } from './lib/report.js';
import type { DuplicateGroup, FileInventoryRecord, FolderAnalysisReport } from './lib/types.js';

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // e.g. a folder whose name ends in a space, which Win32 cannot open.
    console.warn(`  SKIPPED unreadable folder ${dir}: ${(error as Error).message}`);
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      // Skip Office lock files and OS metadata.
      if (entry.name.startsWith('~$') || entry.name === 'Thumbs.db' || entry.name === '.DS_Store') continue;
      files.push(full);
    }
  }
  return files;
}

function tally(records: FileInventoryRecord[], pick: (r: FileInventoryRecord) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const record of records) {
    const key = pick(record);
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

async function inspectFile(sourceDir: string, absolutePath: string): Promise<FileInventoryRecord> {
  const extension = extname(absolutePath).toLowerCase();
  const kind = classifyExtension(extension);
  const { relativePath, facultyFolder, yearFolder, thesisFolder } = parsePathContext(sourceDir, absolutePath);
  const originalFilename = absolutePath.split(/[\\/]/).pop() ?? absolutePath;
  const { createdAt, modifiedAt, sizeBytes } = await fileTimestamps(absolutePath);
  const sha256 = await sha256File(absolutePath);
  const magicType = await detectMagicType(absolutePath);
  const extensionMatchesMagic = magicMatchesKind(kind, magicType);
  // A part inside a thesis folder is named "ف2.doc"; the folder carries the
  // "<title>-<author>" convention instead.
  const { title, author } = parseFilename(thesisFolder ?? originalFilename);

  const extraction = await extractDocument(absolutePath, kind);
  const scannedPageCount = extraction.pages.filter((p) => p.likelyScanned).length;
  const totalTextChars = extraction.fullText.length;
  const pageCount = extraction.pageCount;

  const health = determineHealth({
    kind,
    extensionMatchesMagic,
    isEncrypted: extraction.isEncrypted,
    errors: extraction.errors,
    pageCount,
    totalTextChars,
    scannedPageCount,
  });

  return {
    id: sha256.slice(0, 16),
    absolutePath,
    relativePath,
    originalFilename,
    extension,
    kind,
    sizeBytes,
    sizeMb: Number((sizeBytes / (1024 * 1024)).toFixed(2)),
    createdAt,
    modifiedAt,
    sha256,
    facultyFolder,
    yearFolder,
    thesisFolder,
    filenameTitleGuess: title,
    filenameAuthorGuess: author,
    magicType,
    extensionMatchesMagic,
    health,
    isEncrypted: extraction.isEncrypted,
    pageCount: pageCount || null,
    totalTextChars,
    averageCharsPerPage: pageCount > 0 ? Math.round(totalTextChars / pageCount) : 0,
    scannedPageCount,
    textLayerCoverage: pageCount > 0 ? Number(((pageCount - scannedPageCount) / pageCount).toFixed(3)) : 0,
    detectedLanguage: detectLanguage(extraction.fullText),
    errors: extraction.errors,
    warnings: extraction.warnings,
    processedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const sourceDir = env.sourceDir;
  console.log(`Inspecting: ${sourceDir}`);
  const paths = await walk(sourceDir);
  console.log(`Found ${paths.length} files. Analyzing...`);

  const records: FileInventoryRecord[] = [];
  let index = 0;
  for (const path of paths) {
    index += 1;
    try {
      const record = await inspectFile(sourceDir, path);
      records.push(record);
      process.stdout.write(
        `  [${String(index).padStart(3)}/${paths.length}] ${record.health.padEnd(18)} ${record.pageCount ?? '-'}p  ${record.originalFilename.slice(0, 60)}\n`,
      );
    } catch (error) {
      console.error(`  [${index}/${paths.length}] FAILED ${path}: ${(error as Error).message}`);
      records.push({
        id: 'unknown',
        absolutePath: path,
        relativePath: path,
        originalFilename: path.split(/[\\/]/).pop() ?? path,
        extension: extname(path).toLowerCase(),
        kind: classifyExtension(extname(path)),
        sizeBytes: 0,
        sizeMb: 0,
        createdAt: '',
        modifiedAt: '',
        sha256: '',
        facultyFolder: null,
        yearFolder: null,
        thesisFolder: null,
        filenameTitleGuess: null,
        filenameAuthorGuess: null,
        magicType: null,
        extensionMatchesMagic: false,
        health: 'corrupted',
        isEncrypted: false,
        pageCount: null,
        totalTextChars: 0,
        averageCharsPerPage: 0,
        scannedPageCount: 0,
        textLayerCoverage: 0,
        detectedLanguage: 'unknown',
        errors: [(error as Error).message],
        warnings: [],
        processedAt: new Date().toISOString(),
      });
    }
  }

  const byHash = new Map<string, string[]>();
  for (const record of records) {
    if (!record.sha256) continue;
    const list = byHash.get(record.sha256) ?? [];
    list.push(record.relativePath);
    byHash.set(record.sha256, list);
  }
  const duplicates: DuplicateGroup[] = [...byHash.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([sha256, files]) => ({ sha256, files }));

  const report: FolderAnalysisReport = {
    generatedAt: new Date().toISOString(),
    sourceDirectory: sourceDir,
    totals: {
      files: records.length,
      sizeMb: Number(records.reduce((sum, r) => sum + r.sizeMb, 0).toFixed(2)),
      pages: records.reduce((sum, r) => sum + (r.pageCount ?? 0), 0),
      byKind: tally(records, (r) => r.kind),
      byHealth: tally(records, (r) => r.health),
      byFaculty: tally(records, (r) => r.facultyFolder ?? '(root)'),
      byYear: tally(records, (r) => (r.yearFolder ? String(r.yearFolder) : '(unknown)')),
      byLanguage: tally(records, (r) => r.detectedLanguage),
    },
    duplicates,
    needsOcr: records.filter((r) => r.health === 'scanned' || r.health === 'partially_scanned').map((r) => r.relativePath),
    needsReview: records
      .filter((r) => ['corrupted', 'encrypted', 'empty', 'unsupported', 'extension_mismatch'].includes(r.health))
      .map((r) => r.relativePath),
    files: records,
  };

  const jsonPath = reportName('folder-analysis', 'json');
  const xlsxPath = reportName('folder-analysis', 'xlsx');
  await writeJson(jsonPath, report);
  await writeWorkbook(xlsxPath, [
    {
      name: 'Files',
      columns: [
        { header: 'ID', key: 'id', width: 18 },
        { header: 'Filename', key: 'originalFilename', width: 70 },
        { header: 'Faculty (folder)', key: 'facultyFolder', width: 24 },
        { header: 'Year (folder)', key: 'yearFolder', width: 12 },
        { header: 'Thesis folder', key: 'thesisFolder', width: 50 },
        { header: 'Type', key: 'kind', width: 8 },
        { header: 'Size MB', key: 'sizeMb', width: 10 },
        { header: 'Pages', key: 'pageCount', width: 8 },
        { header: 'Health', key: 'health', width: 18 },
        { header: 'Text chars', key: 'totalTextChars', width: 12 },
        { header: 'Chars/page', key: 'averageCharsPerPage', width: 12 },
        { header: 'Scanned pages', key: 'scannedPageCount', width: 14 },
        { header: 'Text coverage', key: 'textLayerCoverage', width: 14 },
        { header: 'Language', key: 'detectedLanguage', width: 10 },
        { header: 'Title guess', key: 'filenameTitleGuess', width: 60 },
        { header: 'Author guess', key: 'filenameAuthorGuess', width: 30 },
        { header: 'SHA-256', key: 'sha256', width: 66 },
        { header: 'Errors', key: 'errors', width: 40 },
        { header: 'Warnings', key: 'warnings', width: 40 },
        { header: 'Relative path', key: 'relativePath', width: 70 },
      ],
      rows: records as unknown as Array<Record<string, unknown>>,
    },
    {
      name: 'Summary',
      columns: [
        { header: 'Metric', key: 'metric', width: 34 },
        { header: 'Value', key: 'value', width: 20 },
      ],
      rows: [
        { metric: 'Total files', value: report.totals.files },
        { metric: 'Total size (MB)', value: report.totals.sizeMb },
        { metric: 'Total pages', value: report.totals.pages },
        ...Object.entries(report.totals.byKind).map(([k, v]) => ({ metric: `Type: ${k}`, value: v })),
        ...Object.entries(report.totals.byHealth).map(([k, v]) => ({ metric: `Health: ${k}`, value: v })),
        ...Object.entries(report.totals.byFaculty).map(([k, v]) => ({ metric: `Faculty: ${k}`, value: v })),
        ...Object.entries(report.totals.byYear).map(([k, v]) => ({ metric: `Year: ${k}`, value: v })),
        ...Object.entries(report.totals.byLanguage).map(([k, v]) => ({ metric: `Language: ${k}`, value: v })),
        { metric: 'Duplicate groups', value: report.duplicates.length },
        { metric: 'Files needing OCR', value: report.needsOcr.length },
        { metric: 'Files needing review', value: report.needsReview.length },
      ],
    },
    {
      name: 'Duplicates',
      columns: [
        { header: 'SHA-256', key: 'sha256', width: 66 },
        { header: 'Files', key: 'files', width: 100 },
      ],
      rows: duplicates as unknown as Array<Record<string, unknown>>,
    },
  ]);

  console.log('\n=== FOLDER ANALYSIS ===');
  console.log(JSON.stringify(report.totals, null, 2));
  console.log(`Duplicate groups: ${duplicates.length}`);
  console.log(`Needs OCR: ${report.needsOcr.length}`);
  console.log(`Needs review: ${report.needsReview.length}`);
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${xlsxPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
