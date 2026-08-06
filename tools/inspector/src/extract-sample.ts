/**
 * Phase 1, steps 3-6: analyze five representative research papers.
 *
 * Pipeline per file:
 *   parse -> detect sections -> rule-based extraction -> decide if AI is needed
 *   -> Gemini structured extraction -> verify every citation against real page text
 *   -> merge with provenance -> chunk -> export JSON + Excel.
 *
 * Originals are opened read-only and never modified.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from './lib/env.js';
import { chunkResearch, DEFAULT_CHUNKING, summarizeChunks } from './lib/chunking.js';
import { extractDocument } from './lib/file-analysis.js';
import {
  extractMetadataWithGemini,
  verifyEvidence,
  type GeminiFieldResult,
  type GeminiMetadataResponse,
} from './lib/gemini-extraction.js';
import {
  detectSections,
  emptyField,
  extractAbstractFromSection,
  extractDegree,
  extractDoi,
  extractEmails,
  extractIsbn,
  extractIssn,
  extractKeywords,
  extractOrcids,
  extractReferences,
  extractSupervisors,
  extractYear,
  field,
  type DetectedSection,
} from './lib/rule-extraction.js';
import { writeJson, writeWorkbook } from './lib/report.js';
import type {
  ExtractedField,
  FileInventoryRecord,
  FolderAnalysisReport,
  ResearchMetadata,
  SampleExtractionResult,
} from './lib/types.js';

/**
 * Deterministic, documented selection of five representative files.
 * Coverage goals: both faculties, all three container formats, both languages,
 * and one member of a PDF/DOCX duplicate pair.
 */
function selectSample(report: FolderAnalysisReport): FileInventoryRecord[] {
  const files = report.files.filter((f) => f.health === 'ok');
  const picked: FileInventoryRecord[] = [];
  const take = (predicate: (f: FileInventoryRecord) => boolean, label: string): void => {
    const candidate = files.find((f) => !picked.includes(f) && predicate(f));
    if (candidate) {
      (candidate as FileInventoryRecord & { selectionReason?: string }).selectionReason = label;
      picked.push(candidate);
    }
  };

  take(
    (f) => f.kind === 'pdf' && f.facultyFolder === 'كلية الإعلام' && f.detectedLanguage === 'ar' && (f.pageCount ?? 0) > 60,
    'Arabic PDF thesis, College of Media — largest faculty/language combination',
  );
  take(
    (f) => f.kind === 'pdf' && f.facultyFolder === 'كلية العلوم الإدارية' && f.detectedLanguage === 'en' && (f.pageCount ?? 0) > 60,
    'English PDF thesis, College of Administrative Sciences — tests English metadata path',
  );
  take(
    (f) => f.kind === 'pdf' && f.detectedLanguage === 'mixed' && (f.pageCount ?? 0) > 60,
    'Mixed Arabic/English PDF — tests bilingual title & abstract separation',
  );
  take((f) => f.kind === 'docx', 'DOCX manuscript — tests the no-page-model path');
  take((f) => f.kind === 'doc', 'Legacy binary .doc — tests the OLE2 extraction path');

  // Backfill if any predicate found nothing.
  for (const file of files) {
    if (picked.length >= 5) break;
    if (!picked.includes(file)) {
      (file as FileInventoryRecord & { selectionReason?: string }).selectionReason = 'Backfill to reach five samples';
      picked.push(file);
    }
  }
  return picked.slice(0, 5);
}

/** Convert a verified Gemini field into our provenance envelope. */
function fromGemini<T>(
  result: GeminiFieldResult | undefined,
  pages: Parameters<typeof verifyEvidence>[0],
  options: { maxConfidence?: number } = {},
): ExtractedField<T> {
  if (!result || result.value === null || result.value === undefined) return emptyField<T>();
  if (Array.isArray(result.value) && result.value.length === 0) return emptyField<T>();

  const verification = verifyEvidence(pages, result.page_number, result.evidence);
  let confidence = Math.min(result.confidence ?? 0, options.maxConfidence ?? 1);
  const notes: string[] = [];

  // Hallucination guard: unverifiable citations are downgraded, never trusted.
  if (!verification.pageExists) {
    confidence = Math.min(confidence, 0.25);
    notes.push('cited page does not exist');
  } else if (!verification.evidenceFound) {
    confidence = Math.min(confidence, 0.35);
    notes.push(`evidence not found on cited page (match ${verification.matchRatio})`);
  }

  return {
    value: result.value as T,
    source: 'gemini',
    extractionMethod: 'gemini_structured',
    pageNumber: verification.pageExists ? result.page_number : null,
    evidence: result.evidence,
    confidence: Number(confidence.toFixed(2)),
    requiresManualReview: confidence < 0.7 || notes.length > 0,
  };
}

/** Rule-based value wins unless it is empty or clearly weaker than the AI value. */
function preferRule<T>(rule: ExtractedField<T>, ai: ExtractedField<T>): ExtractedField<T> {
  if (rule.value !== null && rule.confidence >= 0.8) return rule;
  if (ai.value !== null && ai.confidence > rule.confidence) return ai;
  if (rule.value !== null) return rule;
  return ai;
}

function shouldUseGemini(input: {
  sections: DetectedSection[];
  ruleFields: Record<string, ExtractedField<unknown>>;
  language: string;
}): string[] {
  const reasons: string[] = [];
  const missing = ['titleAr', 'titleEn', 'authors', 'abstractAr', 'abstractEn', 'faculty', 'department'].filter(
    (key) => input.ruleFields[key]?.value === null || input.ruleFields[key] === undefined,
  );
  if (missing.length > 0) reasons.push(`metadata not reliably identified by parsing: ${missing.join(', ')}`);
  if (input.sections.length < 5) reasons.push('document structure difficult to parse (few sections detected)');
  if (input.language === 'mixed') reasons.push('Arabic and English metadata are mixed');
  const lowConfidence = Object.entries(input.ruleFields).filter(
    ([, f]) => f.value !== null && f.confidence > 0 && f.confidence < 0.7,
  );
  if (lowConfidence.length > 0) reasons.push(`low extraction confidence on ${lowConfidence.length} field(s)`);
  return reasons;
}

async function processFile(record: FileInventoryRecord): Promise<SampleExtractionResult> {
  console.log(`\n=== ${record.originalFilename}`);
  const extraction = await extractDocument(record.absolutePath, record.kind);
  const pages = extraction.pages;
  const sections = detectSections(pages);
  console.log(`  pages=${pages.length} chars=${extraction.fullText.length} sections=${sections.length}`);
  console.log(`  sections: ${sections.map((s) => `${s.name}@p${s.startPage}`).join(', ') || '(none)'}`);

  // ---- Rule-based pass -----------------------------------------------------
  const doi = extractDoi(pages);
  const issn = extractIssn(pages);
  const isbn = extractIsbn(pages);
  const emails = extractEmails(pages);
  const orcids = extractOrcids(pages);
  const year = extractYear(pages, record.yearFolder);
  const keywordsAr = extractKeywords(pages, 'ar');
  const keywordsEn = extractKeywords(pages, 'en');
  const abstractArRule = extractAbstractFromSection(pages, sections, 'abstract_ar');
  const abstractEnRule = extractAbstractFromSection(pages, sections, 'abstract_en');
  const references = extractReferences(pages, sections);
  const degree = extractDegree(pages);
  const supervisors = extractSupervisors(pages);

  const titleFromFilename = field(record.filenameTitleGuess, {
    source: 'filename',
    extractionMethod: 'folder_convention',
    confidence: 0.55,
    requiresManualReview: true,
    evidence: `Derived from filename "${record.originalFilename}"`,
  });
  const authorFromFilename = field(record.filenameAuthorGuess ? [record.filenameAuthorGuess] : null, {
    source: 'filename',
    extractionMethod: 'folder_convention',
    confidence: 0.55,
    requiresManualReview: true,
    evidence: `Derived from filename "${record.originalFilename}"`,
  });
  const facultyFromFolder = field(record.facultyFolder, {
    source: 'folder_structure',
    extractionMethod: 'folder_convention',
    confidence: 0.7,
    requiresManualReview: true,
    evidence: `Containing folder "${record.facultyFolder}"`,
  });

  const isArabicTitle = /[؀-ۿ]/.test(record.filenameTitleGuess ?? '');
  const ruleFields: Record<string, ExtractedField<unknown>> = {
    titleAr: isArabicTitle ? titleFromFilename : emptyField<string>(),
    titleEn: isArabicTitle ? emptyField<string>() : titleFromFilename,
    authors: authorFromFilename,
    abstractAr: abstractArRule,
    abstractEn: abstractEnRule,
    faculty: facultyFromFolder,
    department: emptyField<string>(),
    year,
    keywordsAr,
    keywordsEn,
  };

  // ---- Decide whether Gemini is needed ------------------------------------
  const reasons = shouldUseGemini({ sections, ruleFields, language: record.detectedLanguage });
  console.log(`  AI needed: ${reasons.length > 0} ${reasons.length > 0 ? `(${reasons.join('; ')})` : ''}`);

  let ai: GeminiMetadataResponse | null = null;
  let aiMeta = {
    used: false,
    reason: reasons,
    model: null as string | null,
    promptTokens: null as number | null,
    responseTokens: null as number | null,
    totalTokens: null as number | null,
    latencyMs: null as number | null,
    error: null as string | null,
  };

  if (reasons.length > 0 && pages.length > 0) {
    // Front matter + abstract pages carry essentially all bibliographic metadata.
    const candidatePages = new Set<number>();
    for (const page of pages.slice(0, 8)) candidatePages.add(page.pageNumber);
    for (const name of ['abstract_ar', 'abstract_en']) {
      const section = sections.find((s) => s.name === name);
      if (section) {
        candidatePages.add(section.startPage);
        if (pages.some((p) => p.pageNumber === section.startPage + 1)) candidatePages.add(section.startPage + 1);
      }
    }
    const pageNumbers = [...candidatePages].sort((a, b) => a - b).slice(0, 14);
    console.log(`  calling ${env.geminiFastModel} on pages ${pageNumbers.join(',')}`);
    const call = await extractMetadataWithGemini(pages, pageNumbers, {
      model: env.geminiFastModel,
      filename: record.originalFilename,
    });
    ai = call.data;
    aiMeta = {
      used: true,
      reason: reasons,
      model: call.model,
      promptTokens: call.promptTokens,
      responseTokens: call.responseTokens,
      totalTokens: call.totalTokens,
      latencyMs: call.latencyMs,
      error: call.error,
    };
    console.log(
      call.error
        ? `  AI FAILED after ${call.attempts} attempt(s): ${call.error.slice(0, 160)}`
        : `  AI ok: ${call.totalTokens} tokens, ${call.latencyMs}ms`,
    );
  }

  // ---- Merge with provenance ----------------------------------------------
  const g = <K extends keyof GeminiMetadataResponse>(key: K): GeminiFieldResult | undefined => ai?.[key];

  const metadata: ResearchMetadata = {
    titleAr: preferRule(ruleFields.titleAr as ExtractedField<string>, fromGemini<string>(g('title_ar'), pages)),
    titleEn: preferRule(ruleFields.titleEn as ExtractedField<string>, fromGemini<string>(g('title_en'), pages)),
    authors: preferRule(ruleFields.authors as ExtractedField<string[]>, fromGemini<string[]>(g('authors'), pages)),
    authorEmails: emails,
    orcids,
    abstractAr: preferRule(abstractArRule, fromGemini<string>(g('abstract_ar'), pages)),
    abstractEn: preferRule(abstractEnRule, fromGemini<string>(g('abstract_en'), pages)),
    keywordsAr: preferRule(keywordsAr, fromGemini<string[]>(g('keywords_ar'), pages)),
    keywordsEn: preferRule(keywordsEn, fromGemini<string[]>(g('keywords_en'), pages)),
    publicationYear: preferRule(year, fromGemini<number>(g('publication_year'), pages)),
    journalName: fromGemini<string>(g('journal_name'), pages),
    conferenceName: fromGemini<string>(g('conference_name'), pages),
    volume: fromGemini<string>(g('volume'), pages),
    issue: fromGemini<string>(g('issue'), pages),
    pageRange: fromGemini<string>(g('page_range'), pages),
    doi: preferRule(doi, fromGemini<string>(g('doi'), pages)),
    issn: preferRule(issn, fromGemini<string>(g('issn'), pages)),
    isbn: preferRule(isbn, fromGemini<string>(g('isbn'), pages)),
    faculty: preferRule(facultyFromFolder, fromGemini<string>(g('faculty'), pages)),
    department: fromGemini<string>(g('department'), pages),
    researchType: fromGemini<string>(g('research_type'), pages),
    publicationType: fromGemini<string>(g('publication_type'), pages),
    researchLanguage: field(record.detectedLanguage, {
      source: 'derived',
      extractionMethod: 'rule_based',
      confidence: 0.9,
      evidence: 'Computed from Arabic/Latin character ratio across the full text',
    }),
    correspondingAuthor: fromGemini<string>(g('corresponding_author'), pages),
    affiliations: fromGemini<string[]>(g('affiliations'), pages),
    supervisors: preferRule(supervisors, fromGemini<string[]>(g('supervisors'), pages)),
    degree: preferRule(degree, fromGemini<string>(g('degree'), pages)),
    references,
    totalPages: field(record.pageCount, {
      source: record.kind === 'pdf' ? 'pdf_text' : 'docx_text',
      extractionMethod: 'rule_based',
      confidence: record.kind === 'pdf' ? 1 : 0.3,
      requiresManualReview: record.kind !== 'pdf',
      evidence: record.kind === 'pdf' ? 'PDF page count from document catalog' : 'DOC/DOCX has no intrinsic page model',
    }),
    originalFilename: field(record.originalFilename, {
      source: 'filename',
      extractionMethod: 'rule_based',
      confidence: 1,
    }),
  };

  // ---- Chunking -----------------------------------------------------------
  const chunks = chunkResearch(pages, sections, { ...DEFAULT_CHUNKING, sourceFilename: record.originalFilename });
  const chunkStats = summarizeChunks(chunks);
  console.log(`  chunks=${chunkStats.total} avgTokens=${chunkStats.avgTokens} totalTokens=${chunkStats.totalTokens}`);

  const entries = Object.entries(metadata) as Array<[string, ExtractedField<unknown>]>;
  const fieldsMissing = entries.filter(([, f]) => f.value === null).map(([k]) => k);
  const fieldsLowConfidence = entries.filter(([, f]) => f.value !== null && f.confidence < 0.7).map(([k]) => k);

  return {
    fileId: record.id,
    originalFilename: record.originalFilename,
    relativePath: record.relativePath,
    sha256: record.sha256,
    status: fieldsLowConfidence.length > 0 || fieldsMissing.length > 8 ? 'requires_review' : 'extracted',
    metadata,
    fullTextChars: extraction.fullText.length,
    pageCount: pages.length,
    sectionsDetected: sections.map((s) => `${s.name}@${s.startPage}-${s.endPage}`),
    chunkPreview: {
      total: chunks.length,
      sample: [chunkStats, ...chunks.slice(0, 3).map((c) => ({ ...c, text: `${c.text.slice(0, 260)}...` }))],
    },
    ai: aiMeta,
    fieldsMissing,
    fieldsLowConfidence,
    processedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const reportPath = resolve(env.reportsDir, 'folder-analysis.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as FolderAnalysisReport;
  const sample = selectSample(report);

  console.log('=== SELECTED SAMPLE (5 files) ===');
  for (const file of sample) {
    console.log(
      `  ${file.kind.padEnd(5)} ${String(file.pageCount ?? '-').padStart(4)}p ${file.detectedLanguage.padEnd(6)} ${(file as FileInventoryRecord & { selectionReason?: string }).selectionReason}`,
    );
    console.log(`        ${file.originalFilename}`);
  }

  const results: SampleExtractionResult[] = [];
  for (const file of sample) {
    try {
      results.push(await processFile(file));
    } catch (error) {
      console.error(`  FAILED: ${(error as Error).message}`);
      console.error((error as Error).stack);
    }
  }

  const jsonPath = resolve(env.reportsDir, 'sample-extraction.json');
  await writeJson(jsonPath, {
    generatedAt: new Date().toISOString(),
    sampleSelection: sample.map((f) => ({
      filename: f.originalFilename,
      reason: (f as FileInventoryRecord & { selectionReason?: string }).selectionReason,
    })),
    results,
  });

  // Flatten every field into one auditable row per (file, field).
  const fieldRows: Array<Record<string, unknown>> = [];
  for (const result of results) {
    for (const [name, f] of Object.entries(result.metadata) as Array<[string, ExtractedField<unknown>]>) {
      fieldRows.push({
        file: result.originalFilename,
        field: name,
        value: Array.isArray(f.value) ? f.value.join(' | ') : f.value === null ? '' : String(f.value).slice(0, 900),
        found: f.value === null ? 'MISSING' : 'FOUND',
        source: f.source ?? '',
        method: f.extractionMethod,
        page: f.pageNumber ?? '',
        confidence: f.confidence,
        needsReview: f.requiresManualReview ? 'YES' : 'no',
        evidence: (f.evidence ?? '').slice(0, 500),
      });
    }
  }

  const xlsxPath = resolve(env.reportsDir, 'sample-extraction.xlsx');
  await writeWorkbook(xlsxPath, [
    {
      name: 'Fields',
      columns: [
        { header: 'File', key: 'file', width: 55 },
        { header: 'Field', key: 'field', width: 20 },
        { header: 'Value', key: 'value', width: 70 },
        { header: 'Found?', key: 'found', width: 10 },
        { header: 'Source', key: 'source', width: 16 },
        { header: 'Method', key: 'method', width: 18 },
        { header: 'Page', key: 'page', width: 7 },
        { header: 'Confidence', key: 'confidence', width: 11 },
        { header: 'Needs review', key: 'needsReview', width: 13 },
        { header: 'Page evidence', key: 'evidence', width: 80 },
      ],
      rows: fieldRows,
    },
    {
      name: 'Per file',
      columns: [
        { header: 'File', key: 'originalFilename', width: 55 },
        { header: 'Status', key: 'status', width: 16 },
        { header: 'Pages', key: 'pageCount', width: 8 },
        { header: 'Text chars', key: 'fullTextChars', width: 12 },
        { header: 'Chunks', key: 'chunks', width: 9 },
        { header: 'Sections', key: 'sections', width: 60 },
        { header: 'Missing fields', key: 'fieldsMissing', width: 50 },
        { header: 'Low confidence', key: 'fieldsLowConfidence', width: 50 },
        { header: 'AI used', key: 'aiUsed', width: 9 },
        { header: 'AI model', key: 'aiModel', width: 22 },
        { header: 'AI tokens', key: 'aiTokens', width: 11 },
        { header: 'AI ms', key: 'aiMs', width: 9 },
        { header: 'AI error', key: 'aiError', width: 40 },
      ],
      rows: results.map((r) => ({
        originalFilename: r.originalFilename,
        status: r.status,
        pageCount: r.pageCount,
        fullTextChars: r.fullTextChars,
        chunks: r.chunkPreview.total,
        sections: r.sectionsDetected.join(', '),
        fieldsMissing: r.fieldsMissing.join(', '),
        fieldsLowConfidence: r.fieldsLowConfidence.join(', '),
        aiUsed: r.ai.used ? 'yes' : 'no',
        aiModel: r.ai.model ?? '',
        aiTokens: r.ai.totalTokens ?? '',
        aiMs: r.ai.latencyMs ?? '',
        aiError: r.ai.error ?? '',
      })),
    },
  ]);

  console.log('\n=== SUMMARY ===');
  for (const result of results) {
    console.log(
      `${result.status.padEnd(16)} missing=${String(result.fieldsMissing.length).padStart(2)} lowConf=${String(result.fieldsLowConfidence.length).padStart(2)} chunks=${String(result.chunkPreview.total).padStart(4)} tokens=${result.ai.totalTokens ?? '-'}  ${result.originalFilename.slice(0, 55)}`,
    );
  }
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${xlsxPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
