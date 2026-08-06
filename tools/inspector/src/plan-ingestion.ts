/**
 * Produce the concrete ingestion plan: which text source each thesis should use,
 * how many pages need vision OCR, and the resulting AI cost estimate.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from './lib/env.js';
import { writeJson, writeWorkbook } from './lib/report.js';
import type { FileInventoryRecord, FolderAnalysisReport } from './lib/types.js';

interface DiagnosisRow {
  filename: string;
  kind: string;
  severity: 'clean' | 'ligature_only' | 'severe';
  impossiblePrefixRate: number;
  longTokenRate: number;
}

function titleKey(name: string): string {
  return name
    .replace(/\.(pdf|docx?|DOCX?|PDF)$/i, '')
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

// Gemini pricing per 1M tokens (flash-lite tier), USD.
const PRICE_INPUT_PER_M = 0.1;
const PRICE_OUTPUT_PER_M = 0.4;
const OCR_INPUT_TOKENS_PER_PAGE = 1500; // measured: ~1400-1700 including the image
const OCR_OUTPUT_TOKENS_PER_PAGE = 900;

async function main(): Promise<void> {
  const report = JSON.parse(
    await readFile(resolve(env.reportsDir, 'folder-analysis.json'), 'utf8'),
  ) as FolderAnalysisReport;
  const diagnosis = JSON.parse(
    await readFile(resolve(env.reportsDir, 'arabic-diagnosis.json'), 'utf8'),
  ) as { rows: DiagnosisRow[] };

  const severityByFile = new Map(diagnosis.rows.map((r) => [r.filename, r]));

  // Group files into logical theses.
  const theses = new Map<string, FileInventoryRecord[]>();
  for (const file of report.files) {
    const key = titleKey(file.originalFilename);
    theses.set(key, [...(theses.get(key) ?? []), file]);
  }

  const rows: Array<Record<string, unknown>> = [];
  let ocrPages = 0;
  let ocrFiles = 0;

  for (const [key, files] of theses) {
    const pdf = files.find((f) => f.kind === 'pdf');
    const word = files.find((f) => f.kind === 'docx' || f.kind === 'doc');
    const pdfSeverity = pdf ? (severityByFile.get(pdf.originalFilename)?.severity ?? 'clean') : null;
    const wordSeverity = word ? (severityByFile.get(word.originalFilename)?.severity ?? 'clean') : null;

    let textSource: string;
    let needsOcr = false;

    if (pdfSeverity === 'clean' && pdf) {
      textSource = 'pdf_text_layer';
    } else if (word && wordSeverity === 'clean') {
      // Word twin carries clean Arabic — use it for text, PDF for display/citation.
      textSource = 'word_twin_text';
    } else if (pdf) {
      textSource = 'vision_ocr';
      needsOcr = true;
      ocrPages += pdf.pageCount ?? 0;
      ocrFiles += 1;
    } else {
      textSource = 'word_text_layer';
    }

    rows.push({
      thesis: key.slice(0, 60),
      displayFile: pdf?.originalFilename ?? word?.originalFilename ?? '',
      hasPdf: pdf ? 'yes' : 'no',
      hasWord: word ? word.kind : 'no',
      pdfPages: pdf?.pageCount ?? '',
      pdfSeverity: pdfSeverity ?? '',
      wordSeverity: wordSeverity ?? '',
      textSource,
      needsOcr: needsOcr ? 'YES' : 'no',
      faculty: (pdf ?? word)?.facultyFolder ?? '',
      language: (pdf ?? word)?.detectedLanguage ?? '',
    });
  }

  const bySource: Record<string, number> = {};
  for (const row of rows) bySource[row.textSource as string] = (bySource[row.textSource as string] ?? 0) + 1;

  const inputTokens = ocrPages * OCR_INPUT_TOKENS_PER_PAGE;
  const outputTokens = ocrPages * OCR_OUTPUT_TOKENS_PER_PAGE;
  const ocrCost = (inputTokens / 1e6) * PRICE_INPUT_PER_M + (outputTokens / 1e6) * PRICE_OUTPUT_PER_M;

  const totalPages = report.totals.pages;
  const summary = {
    logicalTheses: theses.size,
    physicalFiles: report.files.length,
    bySource,
    ocr: {
      files: ocrFiles,
      pages: ocrPages,
      shareOfCorpusPages: Number((ocrPages / totalPages).toFixed(3)),
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: outputTokens,
      estimatedCostUsd: Number(ocrCost.toFixed(2)),
    },
  };

  console.log('=== INGESTION PLAN ===');
  console.log(JSON.stringify(summary, null, 2));

  await writeJson(resolve(env.reportsDir, 'ingestion-plan.json'), { generatedAt: new Date().toISOString(), summary, rows });
  await writeWorkbook(resolve(env.reportsDir, 'ingestion-plan.xlsx'), [
    {
      name: 'Ingestion plan',
      columns: [
        { header: 'Thesis (normalized)', key: 'thesis', width: 55 },
        { header: 'Display file', key: 'displayFile', width: 65 },
        { header: 'Has PDF', key: 'hasPdf', width: 9 },
        { header: 'Has Word', key: 'hasWord', width: 10 },
        { header: 'PDF pages', key: 'pdfPages', width: 11 },
        { header: 'PDF text quality', key: 'pdfSeverity', width: 17 },
        { header: 'Word text quality', key: 'wordSeverity', width: 17 },
        { header: 'Text source', key: 'textSource', width: 20 },
        { header: 'Needs OCR', key: 'needsOcr', width: 11 },
        { header: 'Faculty', key: 'faculty', width: 24 },
        { header: 'Language', key: 'language', width: 10 },
      ],
      rows,
    },
  ]);
  console.log(`\nWrote ${resolve(env.reportsDir, 'ingestion-plan.xlsx')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
