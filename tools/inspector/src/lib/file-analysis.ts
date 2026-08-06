/**
 * Read-only analysis of research files.
 *
 * Hard rule: this module opens files with read-only handles and never writes,
 * renames, moves or deletes anything under the source directory.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { basename, extname, relative, sep } from 'node:path';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import type { FileHealth, FileKind, PageText } from './types.js';

/** Pages with fewer real characters than this are treated as image-only. */
const SCANNED_PAGE_CHAR_THRESHOLD = 120;

export function classifyExtension(ext: string): FileKind {
  switch (ext.toLowerCase()) {
    case '.pdf':
      return 'pdf';
    case '.docx':
      return 'docx';
    case '.doc':
      return 'doc';
    default:
      return 'unsupported';
  }
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/** Identify the real container format from magic bytes, ignoring the extension. */
export async function detectMagicType(path: string): Promise<string | null> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buffer, 0, 8, 0);
    if (bytesRead < 4) return null;
    if (buffer.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
    // ZIP container — DOCX/XLSX/PPTX/ODT all share this signature.
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)) {
      return 'zip';
    }
    // OLE2 compound file — legacy .doc/.xls/.ppt.
    if (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
      return 'ole2';
    }
    if (buffer.subarray(0, 4).toString('latin1') === '{\\rt') return 'rtf';
    return 'unknown';
  } finally {
    await handle.close();
  }
}

export function magicMatchesKind(kind: FileKind, magic: string | null): boolean {
  if (magic === null || magic === 'unknown') return false;
  if (kind === 'pdf') return magic === 'pdf';
  if (kind === 'docx') return magic === 'zip';
  if (kind === 'doc') return magic === 'ole2' || magic === 'zip' || magic === 'rtf';
  return false;
}

export interface DocumentTextResult {
  pages: PageText[];
  fullText: string;
  pageCount: number;
  isEncrypted: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Extract per-page text from a PDF using pdfjs-dist.
 * Text items are joined with position-aware spacing so Arabic RTL runs stay readable.
 */
export async function extractPdf(path: string): Promise<DocumentTextResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const pages: PageText[] = [];

  // pdfjs-dist ships an ESM legacy build suitable for Node.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const data = new Uint8Array(await readFile(path));
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data,
      // Security hardening: no eval, no remote font/CMap fetching, no XFA scripting.
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      enableXfa: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    const err = error as { name?: string; message?: string };
    const isPassword = err.name === 'PasswordException' || /password/i.test(err.message ?? '');
    return {
      pages: [],
      fullText: '',
      pageCount: 0,
      isEncrypted: isPassword,
      errors: [isPassword ? 'PDF is password protected' : `Failed to open PDF: ${err.message ?? String(error)}`],
      warnings,
    };
  }

  const pageCount = doc.numPages;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    try {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = '';
      let lastY: number | null = null;
      for (const item of content.items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>) {
        if (typeof item.str !== 'string') continue;
        const y = item.transform ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
          text += '\n';
        } else if (text.length > 0 && !text.endsWith(' ') && !text.endsWith('\n')) {
          text += ' ';
        }
        text += item.str;
        if (item.hasEOL) text += '\n';
        lastY = y;
      }
      page.cleanup();
      const cleaned = normalizeWhitespace(text);
      pages.push({
        pageNumber,
        text: cleaned,
        charCount: cleaned.length,
        likelyScanned: cleaned.length < SCANNED_PAGE_CHAR_THRESHOLD,
      });
    } catch (error) {
      const message = (error as Error).message;
      warnings.push(`Page ${pageNumber} text extraction failed: ${message}`);
      pages.push({ pageNumber, text: '', charCount: 0, likelyScanned: true });
    }
  }

  await doc.destroy();

  return {
    pages,
    fullText: pages.map((p) => p.text).join('\n\n'),
    pageCount,
    isEncrypted: false,
    errors,
    warnings,
  };
}

/**
 * DOCX has no intrinsic page model. We extract the full text and split on explicit
 * page breaks when present, otherwise treat the document as a single logical page.
 */
export async function extractDocx(path: string): Promise<DocumentTextResult> {
  try {
    const result = await mammoth.extractRawText({ path });
    const fullText = normalizeWhitespace(result.value);
    const parts = fullText.split(/\f/).filter((p) => p.trim().length > 0);
    const chunks = parts.length > 0 ? parts : [fullText];
    const pages: PageText[] = chunks.map((text, index) => ({
      pageNumber: index + 1,
      text,
      charCount: text.length,
      likelyScanned: text.length < SCANNED_PAGE_CHAR_THRESHOLD,
    }));
    return {
      pages,
      fullText,
      pageCount: pages.length,
      isEncrypted: false,
      errors: [],
      warnings: result.messages
        .filter((m) => m.type === 'error')
        .map((m) => m.message)
        .slice(0, 5),
    };
  } catch (error) {
    return {
      pages: [],
      fullText: '',
      pageCount: 0,
      isEncrypted: false,
      errors: [`Failed to read DOCX: ${(error as Error).message}`],
      warnings: [],
    };
  }
}

/** Legacy binary .doc (OLE2) via word-extractor. */
export async function extractDoc(path: string): Promise<DocumentTextResult> {
  try {
    const extractor = new WordExtractor();
    const document = await extractor.extract(path);
    const fullText = normalizeWhitespace(document.getBody());
    return {
      pages: [{ pageNumber: 1, text: fullText, charCount: fullText.length, likelyScanned: fullText.length < SCANNED_PAGE_CHAR_THRESHOLD }],
      fullText,
      pageCount: 1,
      isEncrypted: false,
      errors: [],
      warnings: ['Legacy .doc has no page model; page numbers are approximate.'],
    };
  } catch (error) {
    return {
      pages: [],
      fullText: '',
      pageCount: 0,
      isEncrypted: false,
      errors: [`Failed to read DOC: ${(error as Error).message}`],
      warnings: [],
    };
  }
}

export async function extractDocument(path: string, kind: FileKind): Promise<DocumentTextResult> {
  switch (kind) {
    case 'pdf':
      return extractPdf(path);
    case 'docx':
      return extractDocx(path);
    case 'doc':
      return extractDoc(path);
    default:
      return {
        pages: [],
        fullText: '',
        pageCount: 0,
        isEncrypted: false,
        errors: ['Unsupported file type'],
        warnings: [],
      };
  }
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/ /g, ' ')
    // Strip zero-width and bidi control characters that break Arabic matching.
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function detectLanguage(text: string): 'ar' | 'en' | 'mixed' | 'unknown' {
  const sample = text.slice(0, 20000);
  const arabic = (sample.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  const total = arabic + latin;
  if (total < 50) return 'unknown';
  const arabicRatio = arabic / total;
  if (arabicRatio > 0.85) return 'ar';
  if (arabicRatio < 0.15) return 'en';
  return 'mixed';
}

export function determineHealth(input: {
  kind: FileKind;
  extensionMatchesMagic: boolean;
  isEncrypted: boolean;
  errors: string[];
  pageCount: number;
  totalTextChars: number;
  scannedPageCount: number;
}): FileHealth {
  if (input.kind === 'unsupported') return 'unsupported';
  if (input.isEncrypted) return 'encrypted';
  if (input.errors.length > 0) return 'corrupted';
  if (!input.extensionMatchesMagic) return 'extension_mismatch';
  if (input.totalTextChars === 0) return input.pageCount > 0 ? 'scanned' : 'empty';
  if (input.pageCount > 0) {
    const scannedRatio = input.scannedPageCount / input.pageCount;
    if (scannedRatio >= 0.8) return 'scanned';
    if (scannedRatio >= 0.2) return 'partially_scanned';
  }
  return 'ok';
}

/** Filenames follow "<Arabic title>-<Author name>.ext" in this corpus. */
export function parseFilename(filename: string): { title: string | null; author: string | null } {
  const stem = basename(filename, extname(filename)).trim();
  // Split on the LAST hyphen-like separator; titles frequently contain hyphens.
  const match = stem.match(/^(.*?)[\s]*[-‐-―ـ]+[\s]*([^\-‐-―]+)$/u);
  if (!match) return { title: stem.length > 0 ? stem : null, author: null };
  const title = match[1].trim();
  const author = match[2].trim();
  // An "author" segment with many words or digits is probably still part of the title.
  const looksLikeName = author.split(/\s+/).length <= 6 && !/\d/.test(author) && author.length >= 4;
  return looksLikeName ? { title: title || null, author } : { title: stem, author: null };
}

export function parsePathContext(sourceDir: string, absolutePath: string): {
  relativePath: string;
  facultyFolder: string | null;
  yearFolder: number | null;
} {
  const relativePath = relative(sourceDir, absolutePath);
  const segments = relativePath.split(sep);
  const facultyFolder = segments.length > 1 ? segments[0] : null;
  let yearFolder: number | null = null;
  for (const segment of segments.slice(0, -1)) {
    const year = Number(segment);
    if (Number.isInteger(year) && year >= 1970 && year <= 2100) yearFolder = year;
  }
  return { relativePath, facultyFolder, yearFolder };
}

export async function fileTimestamps(path: string): Promise<{ createdAt: string; modifiedAt: string; sizeBytes: number }> {
  const info = await stat(path);
  return {
    createdAt: info.birthtime.toISOString(),
    modifiedAt: info.mtime.toISOString(),
    sizeBytes: info.size,
  };
}
