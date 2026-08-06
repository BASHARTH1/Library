/**
 * Compare PDF text-extraction engines on the corrupted Arabic title pages.
 * Decides which engine the production pipeline should use.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as mupdfjs from 'mupdf';
import { env } from './lib/env.js';
import { normalizeWhitespace } from './lib/file-analysis.js';
import { scoreCorruption } from './lib/arabic-repair.js';
import type { FolderAnalysisReport } from './lib/types.js';

async function pdfjsPage(path: string, pageNumber: number): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(path));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = (content.items as Array<{ str?: string }>).map((i) => i.str ?? '').join(' ');
  await doc.destroy();
  return normalizeWhitespace(text);
}

async function mupdfPage(path: string, pageNumber: number): Promise<string> {
  const buffer = await readFile(path);
  const doc = mupdfjs.Document.openDocument(buffer, 'application/pdf');
  const page = doc.loadPage(pageNumber - 1);
  const structured = page.toStructuredText('preserve-whitespace,preserve-spans');
  const json = JSON.parse(structured.asJSON()) as {
    blocks?: Array<{ lines?: Array<{ text?: string }> }>;
  };
  const text = (json.blocks ?? [])
    .flatMap((block) => (block.lines ?? []).map((line) => line.text ?? ''))
    .join('\n');
  return normalizeWhitespace(text);
}

async function main(): Promise<void> {
  const report = JSON.parse(
    await readFile(resolve(env.reportsDir, 'folder-analysis.json'), 'utf8'),
  ) as FolderAnalysisReport;

  const targets = report.files
    .filter((f) => f.kind === 'pdf' && f.detectedLanguage !== 'en')
    .slice(0, 6);

  for (const file of targets) {
    console.log(`\n${'='.repeat(95)}`);
    console.log(file.originalFilename.slice(0, 90));
    for (const pageNumber of [1]) {
      const viaPdfjs = await pdfjsPage(file.absolutePath, pageNumber);
      const viaMupdf = await mupdfPage(file.absolutePath, pageNumber);
      const scorePdfjs = scoreCorruption(viaPdfjs.repeat(6));
      const scoreMupdf = scoreCorruption(viaMupdf.repeat(6));
      console.log(`  pdfjs  lig=${String(scorePdfjs.ligatureErrorRate).padStart(6)} : ${viaPdfjs.replace(/\s+/g, ' ').slice(0, 130)}`);
      console.log(`  mupdf  lig=${String(scoreMupdf.ligatureErrorRate).padStart(6)} : ${viaMupdf.replace(/\s+/g, ' ').slice(0, 130)}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
