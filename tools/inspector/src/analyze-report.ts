/**
 * Secondary analysis over reports/folder-analysis.json:
 *  - logical (near-)duplicates: same thesis stored as both PDF and DOCX
 *  - text-density outliers that may still hide image-only pages
 *  - the representative 5-file sample selection for phase-1 extraction
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from './lib/env.js';
import type { FileInventoryRecord, FolderAnalysisReport } from './lib/types.js';

/** Normalized Arabic title key for logical duplicate matching. */
function titleKey(record: FileInventoryRecord): string {
  const base = (record.filenameTitleGuess ?? record.originalFilename)
    .toLowerCase()
    // Unify Arabic orthographic variants (alef forms, ta marbuta, alef maqsura).
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return base.split(/\s+/).slice(0, 8).join(' ');
}

async function main(): Promise<void> {
  const path = resolve(env.reportsDir, 'folder-analysis.json');
  const report = JSON.parse(await readFile(path, 'utf8')) as FolderAnalysisReport;

  const groups = new Map<string, FileInventoryRecord[]>();
  for (const record of report.files) {
    const key = titleKey(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  const logicalDuplicates = [...groups.entries()].filter(([, files]) => files.length > 1);

  console.log(`=== LOGICAL DUPLICATE GROUPS (same title, different file) : ${logicalDuplicates.length} ===`);
  for (const [key, files] of logicalDuplicates) {
    console.log(`\n[${key.slice(0, 70)}]`);
    for (const f of files) {
      console.log(`   ${f.kind.padEnd(5)} ${String(f.pageCount ?? '-').padStart(4)}p  ${String(f.totalTextChars).padStart(7)} chars  ${f.originalFilename.slice(0, 75)}`);
    }
  }

  const affected = logicalDuplicates.reduce((sum, [, files]) => sum + files.length, 0);
  console.log(`\nFiles in duplicate groups: ${affected}`);
  console.log(`Unique theses (estimate): ${report.files.length - (affected - logicalDuplicates.length)}`);

  // DOCX files report 1 page because DOCX has no page model — flag for pagination strategy.
  const docxNoPages = report.files.filter((f) => f.kind !== 'pdf' && (f.pageCount ?? 0) <= 1);
  console.log(`\nDOC/DOCX without page model: ${docxNoPages.length}`);

  // Low text density PDFs — parsed OK but may still be partially image-based.
  const lowDensity = report.files
    .filter((f) => f.kind === 'pdf' && f.averageCharsPerPage < 700)
    .sort((a, b) => a.averageCharsPerPage - b.averageCharsPerPage);
  console.log(`\n=== LOW TEXT DENSITY PDFs (<700 chars/page) : ${lowDensity.length} ===`);
  for (const f of lowDensity.slice(0, 15)) {
    console.log(`   ${String(f.averageCharsPerPage).padStart(5)} chars/page  ${String(f.pageCount).padStart(4)}p  ${f.originalFilename.slice(0, 70)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
