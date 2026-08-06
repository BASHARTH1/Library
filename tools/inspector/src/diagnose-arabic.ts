/**
 * Corpus-wide diagnosis of Arabic text-layer quality.
 * Determines how many files can be ingested from the PDF text layer as-is,
 * how many need deterministic ligature repair, and how many need OCR / vision.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from './lib/env.js';
import { extractDocument } from './lib/file-analysis.js';
import { repairArabic, scoreCorruption } from './lib/arabic-repair.js';
import { writeJson, writeWorkbook } from './lib/report.js';
import type { FolderAnalysisReport } from './lib/types.js';

async function main(): Promise<void> {
  const report = JSON.parse(
    await readFile(resolve(env.reportsDir, 'folder-analysis.json'), 'utf8'),
  ) as FolderAnalysisReport;

  const rows: Array<Record<string, unknown>> = [];
  let index = 0;
  for (const file of report.files) {
    index += 1;
    const extraction = await extractDocument(file.absolutePath, file.kind);
    const score = scoreCorruption(extraction.fullText);
    rows.push({
      filename: file.originalFilename,
      kind: file.kind,
      faculty: file.facultyFolder,
      language: file.detectedLanguage,
      pages: file.pageCount,
      severity: score.severity,
      impossiblePrefixRate: score.impossiblePrefixRate,
      ligatureErrorRate: score.ligatureErrorRate,
      longTokenRate: score.longTokenRate,
      arabicTokenRatio: score.arabicTokenRatio,
      sampleBefore: score.sampleBefore,
      sampleAfter: score.sampleAfter,
    });
    process.stdout.write(
      `[${String(index).padStart(3)}/${report.files.length}] ${score.severity.padEnd(14)} bad=${String(score.impossiblePrefixRate).padStart(7)} long=${String(score.longTokenRate).padStart(6)} ${file.kind.padEnd(5)} ${file.originalFilename.slice(0, 40)}\n`,
    );
  }

  const bySeverity: Record<string, number> = {};
  const byKindSeverity: Record<string, number> = {};
  for (const row of rows) {
    const severity = row.severity as string;
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    const key = `${row.kind}/${severity}`;
    byKindSeverity[key] = (byKindSeverity[key] ?? 0) + 1;
  }

  console.log('\n=== ARABIC TEXT-LAYER DIAGNOSIS ===');
  console.log(JSON.stringify({ bySeverity, byKindSeverity }, null, 2));

  console.log('\n=== REPAIR DEMONSTRATION (ligature_only files) ===');
  for (const row of rows.filter((r) => r.severity === 'ligature_only').slice(0, 4)) {
    console.log(`\n${String(row.filename).slice(0, 70)}`);
    console.log(`  BEFORE: ${row.sampleBefore}`);
    console.log(`  AFTER : ${row.sampleAfter}`);
  }

  console.log('\n=== SEVERE (needs OCR / vision re-read) ===');
  for (const row of rows.filter((r) => r.severity === 'severe')) {
    console.log(`  ${String(row.longTokenRate).padStart(7)} ${String(row.kind).padEnd(5)} ${String(row.filename).slice(0, 75)}`);
    console.log(`      ${String(row.sampleBefore).slice(0, 120)}`);
  }

  await writeJson(resolve(env.reportsDir, 'arabic-diagnosis.json'), { generatedAt: new Date().toISOString(), bySeverity, byKindSeverity, rows });
  await writeWorkbook(resolve(env.reportsDir, 'arabic-diagnosis.xlsx'), [
    {
      name: 'Text quality',
      columns: [
        { header: 'Filename', key: 'filename', width: 65 },
        { header: 'Type', key: 'kind', width: 8 },
        { header: 'Faculty', key: 'faculty', width: 24 },
        { header: 'Language', key: 'language', width: 10 },
        { header: 'Pages', key: 'pages', width: 8 },
        { header: 'Severity', key: 'severity', width: 15 },
        { header: 'Impossible prefix /1k tokens', key: 'impossiblePrefixRate', width: 26 },
        { header: 'Ligature candidates /1k', key: 'ligatureErrorRate', width: 22 },
        { header: 'Long-token rate', key: 'longTokenRate', width: 16 },
        { header: 'Arabic token ratio', key: 'arabicTokenRatio', width: 18 },
        { header: 'Sample (before)', key: 'sampleBefore', width: 70 },
        { header: 'Sample (after repair)', key: 'sampleAfter', width: 70 },
      ],
      rows,
    },
  ]);
  console.log(`\nWrote ${resolve(env.reportsDir, 'arabic-diagnosis.xlsx')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
