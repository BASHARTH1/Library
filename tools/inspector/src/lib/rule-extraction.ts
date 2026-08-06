/**
 * Deterministic, rule-based extraction. Runs BEFORE Gemini.
 * Anything confidently found here is never sent to the model for re-guessing.
 */
import type { ExtractedField, PageText } from './types.js';

export function field<T>(
  value: T | null,
  options: Partial<Omit<ExtractedField<T>, 'value'>> = {},
): ExtractedField<T> {
  const empty = value === null || (Array.isArray(value) && value.length === 0) || value === '';
  return {
    value: empty ? null : value,
    source: options.source ?? null,
    extractionMethod: options.extractionMethod ?? 'none',
    pageNumber: options.pageNumber ?? null,
    evidence: options.evidence ?? null,
    confidence: empty ? 0 : (options.confidence ?? 0),
    requiresManualReview: empty ? true : (options.requiresManualReview ?? false),
  };
}

export const emptyField = <T>(): ExtractedField<T> => field<T>(null);

/** Find the first page whose text matches a pattern; returns page + matched excerpt. */
function findOnPages(
  pages: PageText[],
  pattern: RegExp,
): { pageNumber: number; match: RegExpMatchArray; evidence: string } | null {
  for (const page of pages) {
    const regex = new RegExp(pattern.source, pattern.flags.replace('g', ''));
    const match = page.text.match(regex);
    if (match) {
      const index = match.index ?? 0;
      return {
        pageNumber: page.pageNumber,
        match,
        evidence: page.text.slice(Math.max(0, index - 90), index + match[0].length + 90).replace(/\s+/g, ' ').trim(),
      };
    }
  }
  return null;
}

function collectAll(pages: PageText[], pattern: RegExp): Array<{ value: string; pageNumber: number; evidence: string }> {
  const results: Array<{ value: string; pageNumber: number; evidence: string }> = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(page.text)) !== null) {
      const value = (match[1] ?? match[0]).trim();
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        value,
        pageNumber: page.pageNumber,
        evidence: page.text.slice(Math.max(0, match.index - 70), match.index + match[0].length + 70).replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return results;
}

export function extractDoi(pages: PageText[]): ExtractedField<string> {
  const hit = findOnPages(pages, /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/);
  if (!hit) return emptyField<string>();
  return field(hit.match[1].replace(/[.,;)]+$/, ''), {
    source: 'pdf_text',
    extractionMethod: 'rule_based',
    pageNumber: hit.pageNumber,
    evidence: hit.evidence,
    confidence: 0.98,
  });
}

export function extractIssn(pages: PageText[]): ExtractedField<string> {
  const hit = findOnPages(pages, /\bISSN[:\s-]*([0-9]{4}-[0-9]{3}[0-9Xx])\b/i);
  if (!hit) return emptyField<string>();
  return field(hit.match[1].toUpperCase(), {
    source: 'pdf_text',
    extractionMethod: 'rule_based',
    pageNumber: hit.pageNumber,
    evidence: hit.evidence,
    confidence: 0.97,
  });
}

export function extractIsbn(pages: PageText[]): ExtractedField<string> {
  const hit = findOnPages(pages, /\bISBN[:\s-]*((?:97[89][-\s]?)?[\d][-\s\d]{8,}[\dXx])\b/i);
  if (!hit) return emptyField<string>();
  const normalized = hit.match[1].replace(/[\s-]/g, '');
  if (normalized.length !== 10 && normalized.length !== 13) return emptyField<string>();
  return field(normalized, {
    source: 'pdf_text',
    extractionMethod: 'rule_based',
    pageNumber: hit.pageNumber,
    evidence: hit.evidence,
    confidence: 0.95,
  });
}

export function extractEmails(pages: PageText[]): ExtractedField<string[]> {
  const hits = collectAll(pages, /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/);
  if (hits.length === 0) return emptyField<string[]>();
  return field(
    hits.map((h) => h.value.toLowerCase()),
    {
      source: 'pdf_text',
      extractionMethod: 'rule_based',
      pageNumber: hits[0].pageNumber,
      evidence: hits[0].evidence,
      confidence: 0.96,
    },
  );
}

export function extractOrcids(pages: PageText[]): ExtractedField<string[]> {
  const hits = collectAll(pages, /\b(\d{4}-\d{4}-\d{4}-\d{3}[\dXx])\b/);
  if (hits.length === 0) return emptyField<string[]>();
  return field(
    hits.map((h) => h.value.toUpperCase()),
    {
      source: 'pdf_text',
      extractionMethod: 'rule_based',
      pageNumber: hits[0].pageNumber,
      evidence: hits[0].evidence,
      confidence: 0.9,
    },
  );
}

/** Gregorian year from the title page area, cross-checked against Hijri when present. */
export function extractYear(pages: PageText[], folderYear: number | null): ExtractedField<number> {
  const frontMatter = pages.slice(0, 6);
  const currentYear = new Date().getFullYear();
  const counts = new Map<number, { count: number; pageNumber: number; evidence: string }>();
  for (const hit of collectAll(frontMatter, /\b(19[89]\d|20[0-4]\d)\b/)) {
    const year = Number(hit.value);
    if (year < 1990 || year > currentYear + 1) continue;
    const existing = counts.get(year);
    counts.set(year, {
      count: (existing?.count ?? 0) + 1,
      pageNumber: existing?.pageNumber ?? hit.pageNumber,
      evidence: existing?.evidence ?? hit.evidence,
    });
  }
  if (counts.size === 0) {
    if (folderYear === null) return emptyField<number>();
    return field(folderYear, {
      source: 'folder_structure',
      extractionMethod: 'folder_convention',
      confidence: 0.4,
      requiresManualReview: true,
      evidence: `Year taken from containing folder "${folderYear}" — no year found on the title page.`,
    });
  }
  const [best] = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || b[0] - a[0]);
  const [year, info] = best;
  const agreesWithFolder = folderYear !== null && Math.abs(year - folderYear) <= 1;
  return field(year, {
    source: 'pdf_text',
    extractionMethod: 'rule_based',
    pageNumber: info.pageNumber,
    evidence: info.evidence,
    confidence: agreesWithFolder ? 0.88 : 0.6,
    requiresManualReview: !agreesWithFolder,
  });
}

/** Section headings common to Arabic and English theses in this corpus. */
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
  { name: 'terminology', pattern: /(?:^|\n)\s*(?:مصطلحات\s*(?:الدراسة|البحث)|التعريفات\s*الإجرائية)\s*(?:\n|:|$)/u },
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

export interface DetectedSection {
  name: string;
  startPage: number;
  endPage: number;
  heading: string;
}

export function detectSections(pages: PageText[]): DetectedSection[] {
  const marks: Array<{ name: string; page: number; heading: string }> = [];
  for (const { name, pattern } of SECTION_PATTERNS) {
    for (const page of pages) {
      const regex = new RegExp(pattern.source, pattern.flags.replace('g', ''));
      const match = page.text.match(regex);
      if (match) {
        marks.push({ name, page: page.pageNumber, heading: match[0].replace(/\s+/g, ' ').trim() });
        break; // first occurrence wins; ToC entries are filtered below
      }
    }
  }

  // Drop headings that only appear inside the table of contents page.
  const toc = marks.find((m) => m.name === 'table_of_contents');
  const filtered = toc
    ? marks.filter((m) => m.name === 'table_of_contents' || m.page !== toc.page)
    : marks;

  const sorted = filtered.sort((a, b) => a.page - b.page);
  const lastPage = pages.at(-1)?.pageNumber ?? 1;
  return sorted.map((mark, index) => ({
    name: mark.name,
    startPage: mark.page,
    endPage: index + 1 < sorted.length ? Math.max(mark.page, sorted[index + 1].page - 1) : lastPage,
    heading: mark.heading,
  }));
}

/** Pull the reference list entries from the references section. */
export function extractReferences(pages: PageText[], sections: DetectedSection[]): ExtractedField<string[]> {
  const section = sections.find((s) => s.name === 'references');
  if (!section) return emptyField<string[]>();
  const text = pages
    .filter((p) => p.pageNumber >= section.startPage && p.pageNumber <= section.endPage)
    .map((p) => p.text)
    .join('\n');

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 40);

  // A reference entry typically contains a 4-digit year in parentheses or a DOI/URL.
  const entries = lines.filter((line) => /\(\s*\d{4}\s*[a-z]?\s*\)|\b(19|20)\d{2}\b.*[.,]|https?:\/\/|10\.\d{4}/.test(line));
  if (entries.length === 0) return emptyField<string[]>();

  return field(entries.slice(0, 400), {
    source: 'pdf_text',
    extractionMethod: 'rule_based',
    pageNumber: section.startPage,
    evidence: entries[0].slice(0, 220),
    confidence: entries.length >= 10 ? 0.75 : 0.5,
    requiresManualReview: entries.length < 10,
  });
}

/** Arabic/English abstract text located via detected sections. */
export function extractAbstractFromSection(
  pages: PageText[],
  sections: DetectedSection[],
  which: 'abstract_ar' | 'abstract_en',
): ExtractedField<string> {
  const section = sections.find((s) => s.name === which);
  if (!section) return emptyField<string>();
  const page = pages.find((p) => p.pageNumber === section.startPage);
  if (!page) return emptyField<string>();

  const index = page.text.indexOf(section.heading);
  const body = (index >= 0 ? page.text.slice(index + section.heading.length) : page.text).trim();
  // Stop at the keywords line, which reliably terminates an abstract.
  const stop = body.search(/(?:الكلمات\s*(?:المفتاحية|الدالة)|KEY\s*WORDS?)\s*[:：]/iu);
  const abstract = (stop > 200 ? body.slice(0, stop) : body).trim();
  if (abstract.length < 150) return emptyField<string>();

  return field(abstract.slice(0, 6000), {
    source: 'pdf_text',
    extractionMethod: 'rule_based',
    pageNumber: section.startPage,
    evidence: abstract.slice(0, 220),
    confidence: 0.72,
    requiresManualReview: true,
  });
}

export function extractKeywords(pages: PageText[], which: 'ar' | 'en'): ExtractedField<string[]> {
  const pattern =
    which === 'ar'
      ? /الكلمات\s*(?:المفتاحية|الدالة)\s*[:：]\s*([^\n]{5,400})/u
      : /KEY\s*WORDS?\s*[:：]\s*([^\n]{5,400})/i;
  const hit = findOnPages(pages.slice(0, 30), pattern);
  if (!hit) return emptyField<string[]>();
  const keywords = hit.match[1]
    .split(/[،,;؛|]/)
    .map((k) => k.replace(/[.\s]+$/, '').trim())
    .filter((k) => k.length >= 2 && k.length <= 80);
  if (keywords.length === 0) return emptyField<string[]>();
  return field(keywords, {
    source: 'pdf_text',
    extractionMethod: 'rule_based',
    pageNumber: hit.pageNumber,
    evidence: hit.evidence,
    confidence: 0.85,
  });
}

/** Degree / thesis type signals — this corpus is master's theses. */
export function extractDegree(pages: PageText[]): ExtractedField<string> {
  const candidates: Array<{ pattern: RegExp; value: string }> = [
    { pattern: /درجة\s*الماجستير|ماجستير\s*(?:في|الآداب|العلوم)|MASTER\s+OF\s+(?:ARTS|SCIENCE|BUSINESS)|MASTER'?S?\s+(?:DEGREE|THESIS)/iu, value: "Master's" },
    { pattern: /درجة\s*الدكتوراه|DOCTOR\s+OF\s+PHILOSOPHY|\bPh\.?D\.?\b/iu, value: 'PhD' },
  ];
  for (const candidate of candidates) {
    const hit = findOnPages(pages.slice(0, 12), candidate.pattern);
    if (hit) {
      return field(candidate.value, {
        source: 'pdf_text',
        extractionMethod: 'rule_based',
        pageNumber: hit.pageNumber,
        evidence: hit.evidence,
        confidence: 0.9,
      });
    }
  }
  return emptyField<string>();
}

export function extractSupervisors(pages: PageText[]): ExtractedField<string[]> {
  const hits = collectAll(
    pages.slice(0, 12),
    /(?:إشراف|المشرف|بإشراف|تحت\s*إشراف|Supervis(?:or|ed\s+by)|Under\s+the\s+supervision\s+of)\s*[:：]?\s*((?:الأستاذ\s*)?(?:الدكتور|الدكتورة|د\.|أ\.د\.|Prof\.|Dr\.)\s*[^\n]{3,80})/iu,
  );
  if (hits.length === 0) return emptyField<string[]>();
  return field(
    hits.map((h) => h.value.replace(/\s+/g, ' ').trim()).slice(0, 5),
    {
      source: 'pdf_text',
      extractionMethod: 'rule_based',
      pageNumber: hits[0].pageNumber,
      evidence: hits[0].evidence,
      confidence: 0.7,
      requiresManualReview: true,
    },
  );
}

/** Locate pages most likely to carry title/author/abstract metadata. */
export function selectMetadataPages(pages: PageText[], sections: DetectedSection[]): number[] {
  const wanted = new Set<number>();
  for (const page of pages.slice(0, 8)) wanted.add(page.pageNumber);
  for (const name of ['abstract_ar', 'abstract_en', 'table_of_contents']) {
    const section = sections.find((s) => s.name === name);
    if (section) {
      wanted.add(section.startPage);
      wanted.add(section.startPage + 1);
    }
  }
  return [...wanted].filter((n) => n >= 1 && n <= (pages.at(-1)?.pageNumber ?? 1)).sort((a, b) => a - b).slice(0, 14);
}
