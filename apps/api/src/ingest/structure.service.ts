import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ParsedPage } from './document-parser.service';
import type { ResearchLanguage } from '../database/entities';

export interface DetectedSection {
  name: string;
  heading: string;
  startPage: number;
  endPage: number;
}

export interface BuiltChunk {
  chunkIndex: number;
  text: string;
  pageNumber: number;
  sectionName: string;
  heading: string | null;
  tokenCount: number;
  charCount: number;
  language: ResearchLanguage;
  isOverlap: boolean;
  contentHash: string;
}

const SECTION_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'abstract_ar', pattern: /(?:^|\n)\s*(?:مستخلص\s*الدراسة|المستخلص|ملخص\s*الدراسة|الملخص)\s*(?:\n|:|$)/u },
  { name: 'abstract_en', pattern: /(?:^|\n)\s*ABSTRACT\s*(?:\n|:|$)/i },
  { name: 'acknowledgements', pattern: /(?:^|\n)\s*(?:شكر\s*وتقدير|الشكر\s*والتقدير|ACKNOWLEDG(?:E)?MENTS?)\s*(?:\n|$)/iu },
  { name: 'table_of_contents', pattern: /(?:^|\n)\s*(?:فهرس\s*(?:المحتويات|الموضوعات)|المحتويات|TABLE\s+OF\s+CONTENTS)\s*(?:\n|$)/iu },
  { name: 'introduction', pattern: /(?:^|\n)\s*(?:المقدمة|مقدمة\s*الدراسة|INTRODUCTION)\s*(?:\n|:|$)/iu },
  { name: 'problem_statement', pattern: /(?:^|\n)\s*(?:مشكلة\s*(?:الدراسة|البحث)|PROBLEM\s+STATEMENT|STATEMENT\s+OF\s+THE\s+PROBLEM)\s*(?:\n|:|$)/iu },
  { name: 'questions', pattern: /(?:^|\n)\s*(?:أسئلة\s*(?:الدراسة|البحث)|تساؤلات\s*الدراسة|RESEARCH\s+QUESTIONS)\s*(?:\n|:|$)/iu },
  { name: 'objectives', pattern: /(?:^|\n)\s*(?:أهداف\s*(?:الدراسة|البحث)|RESEARCH\s+OBJECTIVES|OBJECTIVES\s+OF\s+THE\s+STUDY)\s*(?:\n|:|$)/iu },
  { name: 'hypotheses', pattern: /(?:^|\n)\s*(?:فرضيات\s*(?:الدراسة|البحث)|فروض\s*الدراسة|HYPOTHES[EI]S)\s*(?:\n|:|$)/iu },
  { name: 'significance', pattern: /(?:^|\n)\s*(?:أهمية\s*(?:الدراسة|البحث)|SIGNIFICANCE\s+OF\s+THE\s+STUDY)\s*(?:\n|:|$)/iu },
  { name: 'limitations', pattern: /(?:^|\n)\s*(?:حدود\s*(?:الدراسة|البحث)|محددات\s*الدراسة|LIMITATIONS)\s*(?:\n|:|$)/iu },
  { name: 'literature_review', pattern: /(?:^|\n)\s*(?:الدراسات\s*السابقة|الإطار\s*النظري|أدبيات\s*(?:الدراسة|البحث)|LITERATURE\s+REVIEW|THEORETICAL\s+FRAMEWORK)\s*(?:\n|:|$)/iu },
  { name: 'methodology', pattern: /(?:^|\n)\s*(?:منهجية\s*(?:الدراسة|البحث)|منهج\s*(?:الدراسة|البحث)|الطريقة\s*والإجراءات|إجراءات\s*الدراسة|METHODOLOGY|RESEARCH\s+METHOD(?:S|OLOGY)?)\s*(?:\n|:|$)/iu },
  { name: 'population_sample', pattern: /(?:^|\n)\s*(?:مجتمع\s*(?:وعينة\s*)?(?:الدراسة|البحث)|عينة\s*الدراسة|POPULATION\s+AND\s+SAMPLE|STUDY\s+SAMPLE)\s*(?:\n|:|$)/iu },
  { name: 'instrument', pattern: /(?:^|\n)\s*(?:أداة\s*(?:الدراسة|البحث)|أدوات\s*الدراسة|RESEARCH\s+INSTRUMENT)\s*(?:\n|:|$)/iu },
  { name: 'results', pattern: /(?:^|\n)\s*(?:نتائج\s*(?:الدراسة|البحث)|النتائج|تحليل\s*(?:البيانات|النتائج)|RESULTS|FINDINGS|DATA\s+ANALYSIS)\s*(?:\n|:|$)/iu },
  { name: 'discussion', pattern: /(?:^|\n)\s*(?:مناقشة\s*(?:النتائج|الدراسة)|المناقشة|DISCUSSION)\s*(?:\n|:|$)/iu },
  { name: 'conclusion', pattern: /(?:^|\n)\s*(?:الخاتمة|الخلاصة|CONCLUSIONS?)\s*(?:\n|:|$)/iu },
  { name: 'recommendations', pattern: /(?:^|\n)\s*(?:التوصيات|توصيات\s*(?:الدراسة|البحث)|RECOMMENDATIONS)\s*(?:\n|:|$)/iu },
  { name: 'future_research', pattern: /(?:^|\n)\s*(?:الدراسات\s*المقترحة|البحوث\s*المستقبلية|FUTURE\s+(?:RESEARCH|STUDIES|WORK))\s*(?:\n|:|$)/iu },
  { name: 'references', pattern: /(?:^|\n)\s*(?:قائمة\s*(?:المراجع|المصادر)|المراجع|المصادر\s*والمراجع|REFERENCES|BIBLIOGRAPHY)\s*(?:\n|:|$)/iu },
  { name: 'appendices', pattern: /(?:^|\n)\s*(?:الملاحق|ملحق\s*رقم|APPENDI(?:X|CES))\s*(?:\n|:|$)/iu },
];

const CHUNKING = { targetTokens: 450, maxTokens: 700, minTokens: 40, overlapTokens: 60 };

@Injectable()
export class StructureService {
  detectSections(pages: ParsedPage[]): DetectedSection[] {
    const marks: Array<{ name: string; page: number; heading: string }> = [];
    for (const { name, pattern } of SECTION_PATTERNS) {
      for (const page of pages) {
        const match = page.text.match(new RegExp(pattern.source, pattern.flags.replace('g', '')));
        if (match) {
          marks.push({ name, page: page.pageNumber, heading: match[0].replace(/\s+/g, ' ').trim() });
          break;
        }
      }
    }
    const toc = marks.find((m) => m.name === 'table_of_contents');
    const filtered = toc ? marks.filter((m) => m.name === 'table_of_contents' || m.page !== toc.page) : marks;
    const sorted = filtered.sort((a, b) => a.page - b.page);
    const lastPage = pages.at(-1)?.pageNumber ?? 1;
    return sorted.map((mark, i) => ({
      name: mark.name,
      heading: mark.heading,
      startPage: mark.page,
      endPage: i + 1 < sorted.length ? Math.max(mark.page, sorted[i + 1].page - 1) : lastPage,
    }));
  }

  /**
   * Structure-aware chunking. Chunks never cross a page or section boundary, so
   * every chunk carries one exact page number that AI citations can be checked against.
   */
  chunk(pages: ParsedPage[], sections: DetectedSection[]): BuiltChunk[] {
    const runningHeaders = findRunningHeaders(pages);
    const chunks: BuiltChunk[] = [];
    const seen = new Set<string>();
    let chunkIndex = 0;

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

      let buffer = '';
      let carryOverlap = '';

      const flush = (): void => {
        const text = buffer.trim();
        buffer = '';
        if (text.length === 0 || isBoilerplate(text)) return;
        if (estimateTokens(text) < CHUNKING.minTokens) return;
        const dedupeKey = text.slice(0, 160).replace(/\s+/g, '');
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);

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
          contentHash: createHash('sha256').update(finalText).digest('hex'),
        });
        carryOverlap = inReferences ? '' : tailOverlap(text, CHUNKING.overlapTokens);
      };

      for (const paragraph of paragraphs) {
        if (estimateTokens(paragraph) > CHUNKING.maxTokens) {
          flush();
          let sentenceBuffer = '';
          for (const sentence of splitSentences(paragraph)) {
            if (estimateTokens(`${sentenceBuffer} ${sentence}`) > CHUNKING.targetTokens && sentenceBuffer.length > 0) {
              buffer = sentenceBuffer;
              flush();
              sentenceBuffer = sentence;
            } else {
              sentenceBuffer = sentenceBuffer ? `${sentenceBuffer} ${sentence}` : sentence;
            }
          }
          if (sentenceBuffer.length > 0) { buffer = sentenceBuffer; flush(); }
          continue;
        }
        if (estimateTokens(`${buffer}\n${paragraph}`) > CHUNKING.targetTokens && buffer.length > 0) flush();
        buffer = buffer ? `${buffer}\n${paragraph}` : paragraph;
      }
      flush();
    }

    return chunks;
  }
}

export function estimateTokens(text: string): number {
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
  return Math.ceil(arabic / 2.2 + (text.length - arabic) / 4);
}

function detectChunkLanguage(text: string): ResearchLanguage {
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = arabic + latin;
  if (total < 15) return 'unknown';
  const ratio = arabic / total;
  if (ratio > 0.85) return 'ar';
  if (ratio < 0.15) return 'en';
  return 'mixed';
}

export function isBoilerplate(text: string): boolean {
  const t = text.trim();
  if (t.length < 25) return true;
  if (/^[-–—\s]*\(?\d{1,4}\)?[-–—\s]*$/.test(t)) return true;
  if (/^[ivxlcdm]{1,7}$/i.test(t)) return true;
  if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(t)) return true;
  if (/^صفحة\s*\d+$/u.test(t)) return true;
  if (/^[^\n]{0,80}\.{5,}\s*\d{1,4}$/.test(t)) return true;
  const letters = (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return letters / t.length < 0.35;
}

function findRunningHeaders(pages: ParsedPage[]): Set<string> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const lines = page.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 8 && l.length < 120);
    for (const line of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      const key = line.replace(/\d+/g, '#').replace(/\s+/g, ' ');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const threshold = Math.max(4, Math.floor(pages.length * 0.25));
  return new Set([...counts.entries()].filter(([, c]) => c >= threshold).map(([k]) => k));
}

function stripRunningHeaders(text: string, headers: Set<string>): string {
  if (headers.size === 0) return text;
  return text.split('\n')
    .filter((line) => !headers.has(line.trim().replace(/\d+/g, '#').replace(/\s+/g, ' ')))
    .join('\n');
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?؟۔])\s+/u).map((s) => s.trim()).filter((s) => s.length > 0);
}

function sectionForPage(sections: DetectedSection[], pageNumber: number): DetectedSection | null {
  let current: DetectedSection | null = null;
  for (const s of sections) if (pageNumber >= s.startPage && pageNumber <= s.endPage) current = s;
  return current;
}

function tailOverlap(text: string, overlapTokens: number): string {
  const sentences = splitSentences(text);
  const parts: string[] = [];
  let tokens = 0;
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const t = estimateTokens(sentences[i]);
    if (tokens + t > overlapTokens && parts.length > 0) break;
    parts.unshift(sentences[i]);
    tokens += t;
  }
  return parts.join(' ');
}
