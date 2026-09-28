/** Shared types for phase-1 inspection and extraction. */

export type FileKind = 'pdf' | 'docx' | 'doc' | 'unsupported';

export type FileHealth =
  | 'ok'
  | 'scanned'
  | 'partially_scanned'
  | 'encrypted'
  | 'corrupted'
  | 'empty'
  | 'unsupported'
  | 'extension_mismatch';

export interface PageText {
  pageNumber: number;
  text: string;
  charCount: number;
  /** Rough signal that this page has no real text layer (image-only page). */
  likelyScanned: boolean;
}

export interface FileInventoryRecord {
  /** Stable id derived from the checksum; used as the ImportFile key. */
  id: string;
  absolutePath: string;
  relativePath: string;
  originalFilename: string;
  extension: string;
  kind: FileKind;
  sizeBytes: number;
  sizeMb: number;
  createdAt: string;
  modifiedAt: string;
  sha256: string;
  /** Faculty inferred from folder structure (level 1). */
  facultyFolder: string | null;
  /** Year inferred from folder structure (level 2). */
  yearFolder: number | null;
  /**
   * Folder below the year that holds this file, when a thesis was delivered as
   * a folder of parts (chapters, appendices) instead of a single file.
   */
  thesisFolder: string | null;
  /** Title guessed from the "<title>-<author>.ext" filename convention. */
  filenameTitleGuess: string | null;
  filenameAuthorGuess: string | null;
  /** True magic-byte signature check against the declared extension. */
  magicType: string | null;
  extensionMatchesMagic: boolean;
  health: FileHealth;
  isEncrypted: boolean;
  pageCount: number | null;
  totalTextChars: number;
  averageCharsPerPage: number;
  scannedPageCount: number;
  textLayerCoverage: number;
  detectedLanguage: 'ar' | 'en' | 'mixed' | 'unknown';
  errors: string[];
  warnings: string[];
  processedAt: string;
}

export interface DuplicateGroup {
  sha256: string;
  files: string[];
}

export interface FolderAnalysisReport {
  generatedAt: string;
  sourceDirectory: string;
  totals: {
    files: number;
    sizeMb: number;
    pages: number;
    byKind: Record<string, number>;
    byHealth: Record<string, number>;
    byFaculty: Record<string, number>;
    byYear: Record<string, number>;
    byLanguage: Record<string, number>;
  };
  duplicates: DuplicateGroup[];
  needsOcr: string[];
  needsReview: string[];
  files: FileInventoryRecord[];
}

/** Provenance envelope stored for every extracted metadata field. */
export interface ExtractedField<T> {
  value: T | null;
  /** Where the value came from in the document. */
  source: 'pdf_text' | 'docx_text' | 'filename' | 'folder_structure' | 'gemini' | 'derived' | null;
  extractionMethod: 'rule_based' | 'gemini_structured' | 'folder_convention' | 'none';
  pageNumber: number | null;
  /** Verbatim supporting excerpt from the document, when available. */
  evidence: string | null;
  confidence: number;
  requiresManualReview: boolean;
}

export interface ResearchMetadata {
  titleAr: ExtractedField<string>;
  titleEn: ExtractedField<string>;
  authors: ExtractedField<string[]>;
  authorEmails: ExtractedField<string[]>;
  orcids: ExtractedField<string[]>;
  abstractAr: ExtractedField<string>;
  abstractEn: ExtractedField<string>;
  keywordsAr: ExtractedField<string[]>;
  keywordsEn: ExtractedField<string[]>;
  publicationYear: ExtractedField<number>;
  journalName: ExtractedField<string>;
  conferenceName: ExtractedField<string>;
  volume: ExtractedField<string>;
  issue: ExtractedField<string>;
  pageRange: ExtractedField<string>;
  doi: ExtractedField<string>;
  issn: ExtractedField<string>;
  isbn: ExtractedField<string>;
  faculty: ExtractedField<string>;
  department: ExtractedField<string>;
  researchType: ExtractedField<string>;
  publicationType: ExtractedField<string>;
  researchLanguage: ExtractedField<string>;
  correspondingAuthor: ExtractedField<string>;
  affiliations: ExtractedField<string[]>;
  supervisors: ExtractedField<string[]>;
  degree: ExtractedField<string>;
  references: ExtractedField<string[]>;
  totalPages: ExtractedField<number>;
  originalFilename: ExtractedField<string>;
}

export interface SampleExtractionResult {
  fileId: string;
  originalFilename: string;
  relativePath: string;
  sha256: string;
  status: 'extracted' | 'requires_review' | 'failed';
  metadata: ResearchMetadata;
  fullTextChars: number;
  pageCount: number;
  sectionsDetected: string[];
  chunkPreview: { total: number; sample: unknown[] };
  ai: {
    used: boolean;
    reason: string[];
    model: string | null;
    promptTokens: number | null;
    responseTokens: number | null;
    totalTokens: number | null;
    latencyMs: number | null;
    error: string | null;
  };
  fieldsMissing: string[];
  fieldsLowConfidence: string[];
  processedAt: string;
}
