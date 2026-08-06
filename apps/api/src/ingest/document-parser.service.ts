import { readFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import type { TextSourceKind } from '../database/entities';

export interface ParsedPage {
  pageNumber: number;
  text: string;
  charCount: number;
  likelyScanned: boolean;
}

export interface ParsedDocument {
  pages: ParsedPage[];
  fullText: string;
  pageCount: number;
  isEncrypted: boolean;
  textSource: TextSourceKind;
  errors: string[];
}

const SCANNED_PAGE_CHAR_THRESHOLD = 120;

@Injectable()
export class DocumentParserService {
  private readonly logger = new Logger(DocumentParserService.name);

  async parse(path: string, kind: string): Promise<ParsedDocument> {
    switch (kind) {
      case 'pdf':
        return this.parsePdf(path);
      case 'docx':
        return this.parseDocx(path);
      case 'doc':
        return this.parseDoc(path);
      default:
        return {
          pages: [], fullText: '', pageCount: 0, isEncrypted: false,
          textSource: 'manual', errors: [`Unsupported file kind: ${kind}`],
        };
    }
  }

  /** Per-page PDF text via pdfjs, hardened against malicious documents. */
  private async parsePdf(path: string): Promise<ParsedDocument> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await readFile(path));

    let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
    try {
      doc = await pdfjs.getDocument({
        data,
        isEvalSupported: false,
        useSystemFonts: false,
        disableFontFace: true,
        enableXfa: false,
        verbosity: 0,
      }).promise;
    } catch (error) {
      const err = error as { name?: string; message?: string };
      const encrypted = err.name === 'PasswordException' || /password/i.test(err.message ?? '');
      return {
        pages: [], fullText: '', pageCount: 0, isEncrypted: encrypted,
        textSource: 'pdf_text_layer',
        errors: [encrypted ? 'PDF is password protected' : `Failed to open PDF: ${err.message}`],
      };
    }

    const pages: ParsedPage[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      try {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        let text = '';
        let lastY: number | null = null;
        for (const item of content.items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>) {
          if (typeof item.str !== 'string') continue;
          const y = item.transform ? item.transform[5] : null;
          if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) text += '\n';
          else if (text.length > 0 && !text.endsWith(' ') && !text.endsWith('\n')) text += ' ';
          text += item.str;
          if (item.hasEOL) text += '\n';
          lastY = y;
        }
        page.cleanup();
        const cleaned = normalizeWhitespace(text);
        pages.push({
          pageNumber, text: cleaned, charCount: cleaned.length,
          likelyScanned: cleaned.length < SCANNED_PAGE_CHAR_THRESHOLD,
        });
      } catch (error) {
        this.logger.warn(`Page ${pageNumber} failed: ${(error as Error).message}`);
        pages.push({ pageNumber, text: '', charCount: 0, likelyScanned: true });
      }
    }
    await doc.destroy();

    return {
      pages,
      fullText: pages.map((p) => p.text).join('\n\n'),
      pageCount: pages.length,
      isEncrypted: false,
      textSource: 'pdf_text_layer',
      errors: [],
    };
  }

  private async parseDocx(path: string): Promise<ParsedDocument> {
    try {
      const result = await mammoth.extractRawText({ path });
      const fullText = normalizeWhitespace(result.value);
      const parts = fullText.split(/\f/).filter((p) => p.trim().length > 0);
      const chunks = parts.length > 0 ? parts : [fullText];
      const pages = chunks.map((text, i) => ({
        pageNumber: i + 1, text, charCount: text.length,
        likelyScanned: text.length < SCANNED_PAGE_CHAR_THRESHOLD,
      }));
      return { pages, fullText, pageCount: pages.length, isEncrypted: false, textSource: 'word_text_layer', errors: [] };
    } catch (error) {
      return {
        pages: [], fullText: '', pageCount: 0, isEncrypted: false,
        textSource: 'word_text_layer', errors: [`Failed to read DOCX: ${(error as Error).message}`],
      };
    }
  }

  private async parseDoc(path: string): Promise<ParsedDocument> {
    try {
      const extractor = new WordExtractor();
      const document = await extractor.extract(path);
      const fullText = normalizeWhitespace(document.getBody());
      return {
        pages: [{ pageNumber: 1, text: fullText, charCount: fullText.length, likelyScanned: false }],
        fullText, pageCount: 1, isEncrypted: false, textSource: 'word_text_layer', errors: [],
      };
    } catch (error) {
      return {
        pages: [], fullText: '', pageCount: 0, isEncrypted: false,
        textSource: 'word_text_layer', errors: [`Failed to read DOC: ${(error as Error).message}`],
      };
    }
  }
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/ /g, ' ')
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
  const ratio = arabic / total;
  if (ratio > 0.85) return 'ar';
  if (ratio < 0.15) return 'en';
  return 'mixed';
}
