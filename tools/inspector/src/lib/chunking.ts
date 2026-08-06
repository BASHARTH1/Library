/**
 * Structure-aware chunking for academic theses.
 *
 * Strategy (in priority order):
 *   1. Never cross a detected section boundary.
 *   2. Never cross a page boundary — every chunk carries one exact page number
 *      so AI citations can be verified and deep-linked in the PDF viewer.
 *   3. Split on paragraph boundaries inside a page; only fall back to sentence
 *      splitting when a single paragraph exceeds the token budget.
 *   4. Overlap consecutive chunks by a sentence-aligned window to preserve context.
 *   5. Drop boilerplate: page numbers, running headers, empty or near-empty text.
 */
import type { DetectedSection } from './rule-extraction.js';
import type { PageText } from './types.js';

export interface ResearchChunk {
  chunkIndex: number;
  text: string;
  pageNumber: number;
  sectionName: string;
  heading: string | null;
  tokenCount: number;
  charCount: number;
  language: 'ar' | 'en' | 'mixed' | 'unknown';
  isOverlap: boolean;
  sourceFilename: string;
}

export interface ChunkingOptions {
  targetTokens: number;
  maxTokens: number;
  minTokens: number;
  overlapTokens: number;
  sourceFilename: string;
}

export const DEFAULT_CHUNKING: Omit<ChunkingOptions, 'sourceFilename'> = {
  targetTokens: 450,
  maxTokens: 700,
  minTokens: 40,
  overlapTokens: 60,
};

/**
 * Token estimate calibrated for Gemini on mixed Arabic/English text.
 * Arabic averages ~2.2 chars/token; Latin averages ~4 chars/token.
 */
export function estimateTokens(text: string): number {
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
  const other = text.length - arabic;
  return Math.ceil(arabic / 2.2 + other / 4);
}

function detectChunkLanguage(text: string): ResearchChunk['language'] {
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = arabic + latin;
  if (total < 15) return 'unknown';
  const ratio = arabic / total;
  if (ratio > 0.85) return 'ar';
  if (ratio < 0.15) return 'en';
  return 'mixed';
}

/** Boilerplate that must never be embedded. */
export function isBoilerplate(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 25) return true;
  // Bare page numbers, roman numerals, or "Page 12 of 130".
  if (/^[-–—\s]*\(?\d{1,4}\)?[-–—\s]*$/.test(trimmed)) return true;
  if (/^[ivxlcdm]{1,7}$/i.test(trimmed)) return true;
  if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(trimmed)) return true;
  if (/^صفحة\s*\d+$/u.test(trimmed)) return true;
  // Dotted table-of-contents leader lines.
  if (/^[^\n]{0,80}\.{5,}\s*\d{1,4}$/.test(trimmed)) return true;
  // Mostly punctuation / separators.
  const letters = (trimmed.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (letters / trimmed.length < 0.35) return true;
  return false;
}

/** Repeated running headers/footers appearing on many pages. */
export function findRunningHeaders(pages: PageText[]): Set<string> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const lines = page.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 8 && l.length < 120);
    for (const line of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      const key = line.replace(/\d+/g, '#').replace(/\s+/g, ' ');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const threshold = Math.max(4, Math.floor(pages.length * 0.25));
  return new Set([...counts.entries()].filter(([, count]) => count >= threshold).map(([key]) => key));
}

function stripRunningHeaders(text: string, headers: Set<string>): string {
  if (headers.size === 0) return text;
  return text
    .split('\n')
    .filter((line) => !headers.has(line.trim().replace(/\d+/g, '#').replace(/\s+/g, ' ')))
    .join('\n');
}

function splitSentences(text: string): string[] {
  // Arabic full stop, question mark, and Latin terminators.
  return text
    .split(/(?<=[.!?؟।])\s+|(?<=۔)\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function sectionForPage(sections: DetectedSection[], pageNumber: number): DetectedSection | null {
  let current: DetectedSection | null = null;
  for (const section of sections) {
    if (pageNumber >= section.startPage && pageNumber <= section.endPage) current = section;
  }
  return current;
}

/** Take the trailing `overlapTokens` worth of sentences from a chunk. */
function tailOverlap(text: string, overlapTokens: number): string {
  const sentences = splitSentences(text);
  const parts: string[] = [];
  let tokens = 0;
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentenceTokens = estimateTokens(sentences[i]);
    if (tokens + sentenceTokens > overlapTokens && parts.length > 0) break;
    parts.unshift(sentences[i]);
    tokens += sentenceTokens;
  }
  return parts.join(' ');
}

export function chunkResearch(
  pages: PageText[],
  sections: DetectedSection[],
  options: ChunkingOptions,
): ResearchChunk[] {
  const { targetTokens, maxTokens, minTokens, overlapTokens, sourceFilename } = options;
  const runningHeaders = findRunningHeaders(pages);
  const chunks: ResearchChunk[] = [];
  const seenTexts = new Set<string>();
  let chunkIndex = 0;

  // References are stored as one section-level chunk set but never sentence-overlapped,
  // because reference entries are independent records.
  const referencesSection = sections.find((s) => s.name === 'references');

  for (const page of pages) {
    const cleaned = stripRunningHeaders(page.text, runningHeaders).trim();
    if (cleaned.length === 0) continue;

    const section = sectionForPage(sections, page.pageNumber);
    const sectionName = section?.name ?? 'body';
    const heading = section?.heading ?? null;
    const inReferences =
      referencesSection !== undefined &&
      page.pageNumber >= referencesSection.startPage &&
      page.pageNumber <= referencesSection.endPage;

    const paragraphs = cleaned
      .split(/\n{2,}/)
      .map((p) => p.replace(/\n/g, ' ').trim())
      .filter((p) => p.length > 0 && !isBoilerplate(p));

    // Accumulate paragraphs up to the target size without crossing the page.
    let buffer = '';
    let carryOverlap = '';

    const flush = (): void => {
      const text = buffer.trim();
      buffer = '';
      if (text.length === 0) return;
      if (isBoilerplate(text)) return;
      if (estimateTokens(text) < minTokens) return;
      const dedupeKey = text.slice(0, 160).replace(/\s+/g, '');
      if (seenTexts.has(dedupeKey)) return;
      seenTexts.add(dedupeKey);

      const finalText = carryOverlap && !inReferences ? `${carryOverlap} ${text}`.trim() : text;
      chunks.push({
        chunkIndex: chunkIndex++,
        text: finalText,
        pageNumber: page.pageNumber,
        sectionName,
        heading,
        tokenCount: estimateTokens(finalText),
        charCount: finalText.length,
        language: detectChunkLanguage(finalText),
        isOverlap: carryOverlap.length > 0 && !inReferences,
        sourceFilename,
      });
      carryOverlap = inReferences ? '' : tailOverlap(text, overlapTokens);
    };

    for (const paragraph of paragraphs) {
      const paragraphTokens = estimateTokens(paragraph);

      if (paragraphTokens > maxTokens) {
        flush();
        // Oversized paragraph: split on sentences.
        let sentenceBuffer = '';
        for (const sentence of splitSentences(paragraph)) {
          if (estimateTokens(`${sentenceBuffer} ${sentence}`) > targetTokens && sentenceBuffer.length > 0) {
            buffer = sentenceBuffer;
            flush();
            sentenceBuffer = sentence;
          } else {
            sentenceBuffer = sentenceBuffer ? `${sentenceBuffer} ${sentence}` : sentence;
          }
        }
        if (sentenceBuffer.length > 0) {
          buffer = sentenceBuffer;
          flush();
        }
        continue;
      }

      if (estimateTokens(`${buffer}\n${paragraph}`) > targetTokens && buffer.length > 0) {
        flush();
      }
      buffer = buffer ? `${buffer}\n${paragraph}` : paragraph;
    }
    flush();
  }

  return chunks;
}

export function summarizeChunks(chunks: ResearchChunk[]): {
  total: number;
  totalTokens: number;
  avgTokens: number;
  minTokens: number;
  maxTokens: number;
  bySection: Record<string, number>;
  byLanguage: Record<string, number>;
  overlapping: number;
} {
  const tokens = chunks.map((c) => c.tokenCount);
  const bySection: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  for (const chunk of chunks) {
    bySection[chunk.sectionName] = (bySection[chunk.sectionName] ?? 0) + 1;
    byLanguage[chunk.language] = (byLanguage[chunk.language] ?? 0) + 1;
  }
  return {
    total: chunks.length,
    totalTokens: tokens.reduce((a, b) => a + b, 0),
    avgTokens: tokens.length > 0 ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : 0,
    minTokens: tokens.length > 0 ? Math.min(...tokens) : 0,
    maxTokens: tokens.length > 0 ? Math.max(...tokens) : 0,
    bySection: Object.fromEntries(Object.entries(bySection).sort((a, b) => b[1] - a[1])),
    byLanguage,
    overlapping: chunks.filter((c) => c.isOverlap).length,
  };
}
