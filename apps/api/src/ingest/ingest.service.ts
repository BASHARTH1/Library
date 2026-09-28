import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GeminiService } from '../gemini/gemini.service';
import { DocumentParserService, detectLanguage, type ParsedDocument } from './document-parser.service';
import { StructureService } from './structure.service';

export interface IngestInput {
  absolutePath: string;
  facultyNameAr: string | null;
  /** Metadata already validated in phase 1; nulls are filled by the pipeline. */
  metadata: {
    titleAr: string | null;
    titleEn: string | null;
    authors: string[];
    supervisors: string[];
    abstractAr: string | null;
    abstractEn: string | null;
    keywordsAr: string[];
    keywordsEn: string[];
    publicationYear: number | null;
    faculty: string | null;
    department: string | null;
    degree: string | null;
    researchType: string | null;
    publicationType: string | null;
    doi: string | null;
  };
  accessLevel?: string;
}

export interface IngestOptions {
  /** Generate embeddings after the content transaction commits. */
  embed?: boolean;
  /** Extra files (e.g. a Word twin) stored alongside the canonical file. */
  additionalFiles?: string[];
  /** File whose text is used for chunking, when it differs from the display file. */
  textSourcePath?: string;
  /**
   * Ordered parts (front matter, chapters, references, appendices) of a thesis
   * delivered as a folder of files. Their text is joined into one document.
   * Takes precedence over textSourcePath.
   */
  textSourceParts?: string[];
}

export interface IngestResult {
  researchId: string;
  title: string;
  pages: number;
  sections: number;
  chunks: number;
  embedded: number;
  pendingEmbeddings: number;
  tokensEmbedded: number;
  embeddingError: string | null;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function kindOf(path: string): string {
  const ext = extname(path).toLowerCase();
  return ext === '.pdf' ? 'pdf' : ext === '.docx' ? 'docx' : ext === '.doc' ? 'doc' : 'unknown';
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
};

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly parser: DocumentParserService,
    private readonly structure: StructureService,
    private readonly gemini: GeminiService,
  ) {}

  /**
   * Match on the normalized slug, not the raw name: the same faculty appears with
   * and without diacritics across documents ("كلية الاتّصال" vs "كلية الاتصال"),
   * and slug is the unique key.
   */
  private async upsertFaculty(nameAr: string): Promise<string> {
    const slug = normalizeName(nameAr).replace(/\s+/g, '-').slice(0, 60);
    const existing = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM faculties WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`, [slug]);
    if (existing.length > 0) return existing[0].id;
    const inserted = await this.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO faculties (name_ar, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name_ar = faculties.name_ar RETURNING id`, [nameAr, slug]);
    return inserted[0].id;
  }

  private async upsertDepartment(facultyId: string, nameAr: string): Promise<string> {
    const slug = normalizeName(nameAr).replace(/\s+/g, '-').slice(0, 60);
    const existing = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM departments WHERE faculty_id = $1 AND slug = $2 LIMIT 1`, [facultyId, slug]);
    if (existing.length > 0) return existing[0].id;
    const inserted = await this.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO departments (faculty_id, name_ar, slug) VALUES ($1, $2, $3) RETURNING id`,
      [facultyId, nameAr, slug]);
    return inserted[0].id;
  }

  private async upsertAuthor(name: string, facultyId: string | null): Promise<string> {
    const normalized = normalizeName(name);
    const isArabic = /[؀-ۿ]/.test(name);
    const existing = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM authors WHERE normalized_name = $1 AND deleted_at IS NULL LIMIT 1`, [normalized]);
    if (existing.length > 0) return existing[0].id;
    const inserted = await this.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO authors (full_name_ar, full_name_en, normalized_name, faculty_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [isArabic ? name : null, isArabic ? null : name, normalized, facultyId]);
    return inserted[0].id;
  }

  /**
   * True when this exact file is already fully ingested (every chunk embedded).
   * Makes the import resumable: a re-run skips completed files instead of
   * re-spending embedding quota on them (spec §3).
   */
  async isFullyIngested(absolutePath: string): Promise<boolean> {
    const sha256 = createHash('sha256').update(await readFile(absolutePath)).digest('hex');
    const rows = await this.dataSource.query<Array<{ chunks: string; embeddings: string }>>(
      `SELECT
         (SELECT count(*) FROM research_chunks c WHERE c.research_id = f.research_id)     AS chunks,
         (SELECT count(*) FROM research_embeddings e WHERE e.research_id = f.research_id) AS embeddings
       FROM research_files f
       WHERE f.sha256 = $1 AND f.deleted_at IS NULL
       LIMIT 1`,
      [sha256],
    );
    if (rows.length === 0) return false;
    const chunks = Number(rows[0].chunks);
    const embeddings = Number(rows[0].embeddings);
    return chunks > 0 && chunks === embeddings;
  }

  /**
   * Parse each part of a multi-file thesis and join them in the given order,
   * renumbering pages so they stay sequential across parts. A part that fails
   * to parse is skipped with a warning; only a thesis where every part fails
   * is an error.
   */
  private async parseParts(paths: string[]): Promise<ParsedDocument> {
    const pages: ParsedDocument['pages'] = [];
    const failures: string[] = [];
    let textSource: ParsedDocument['textSource'] | null = null;

    for (const partPath of paths) {
      const part = await this.parser.parse(partPath, kindOf(partPath));
      if (part.errors.length > 0 || part.pages.length === 0) {
        failures.push(`${basename(partPath)}: ${part.errors.join('; ') || 'no text'}`);
        continue;
      }
      textSource ??= part.textSource;
      for (const page of part.pages) pages.push({ ...page, pageNumber: pages.length + 1 });
    }

    if (failures.length > 0) this.logger.warn(`Skipped ${failures.length} unreadable part(s): ${failures.join(' | ').slice(0, 300)}`);
    if (pages.length === 0) {
      return { pages: [], fullText: '', pageCount: 0, isEncrypted: false, textSource: 'word_text_layer', errors: failures };
    }
    return {
      pages,
      fullText: pages.map((p) => p.text).join('\n\n'),
      pageCount: pages.length,
      isEncrypted: false,
      textSource: textSource ?? 'word_text_layer',
      errors: [],
    };
  }

  /** Full pipeline for one file: parse → sections → chunks → embeddings → indexed. */
  async ingestFile(input: IngestInput, options: IngestOptions = {}): Promise<IngestResult> {
    const path = input.absolutePath;
    const kind = kindOf(path);
    const filename = basename(path);
    this.logger.log(`Ingesting ${filename}`);

    // Text may come from a cleaner twin (e.g. the Word source of a corrupted PDF)
    // while the PDF remains the file shown in the viewer.
    const parsed = options.textSourceParts?.length
      ? await this.parseParts(options.textSourceParts)
      : await this.parser.parse(options.textSourcePath ?? path, kindOf(options.textSourcePath ?? path));
    if (parsed.errors.length > 0) throw new Error(parsed.errors.join('; '));

    const info = await stat(path);
    const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');

    const facultyName = input.metadata.faculty ?? input.facultyNameAr;
    const facultyId = facultyName ? await this.upsertFaculty(facultyName) : null;
    const departmentId =
      facultyId && input.metadata.department ? await this.upsertDepartment(facultyId, input.metadata.department) : null;

    const language = detectLanguage(parsed.fullText);
    const title = input.metadata.titleAr ?? input.metadata.titleEn ?? filename;

    const content = await this.dataSource.transaction(async (manager) => {
      // Idempotency: re-ingesting the same file replaces its derived data.
      const existing = await manager.query<Array<{ research_id: string }>>(
        `SELECT research_id FROM research_files WHERE sha256 = $1 AND deleted_at IS NULL LIMIT 1`, [sha256]);
      if (existing.length > 0) {
        await manager.query(`DELETE FROM research WHERE id = $1`, [existing[0].research_id]);
      }

      const [research] = await manager.query<Array<{ id: string }>>(
        `INSERT INTO research (
           title_ar, title_en, abstract_ar, abstract_en, publication_year,
           faculty_id, department_id, doi, research_type, publication_type,
           language, degree, total_pages, full_text, text_source,
           status, access_level, published_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'published',$16, now())
         RETURNING id`,
        [
          input.metadata.titleAr, input.metadata.titleEn,
          input.metadata.abstractAr, input.metadata.abstractEn,
          input.metadata.publicationYear, facultyId, departmentId,
          input.metadata.doi, input.metadata.researchType, input.metadata.publicationType,
          language, input.metadata.degree, parsed.pageCount, parsed.fullText, parsed.textSource,
          input.accessLevel ?? 'public',
        ],
      );
      const researchId = research.id;

      // Authors and supervisors
      let order = 1;
      for (const name of input.metadata.authors) {
        const authorId = await this.upsertAuthor(name, facultyId);
        await manager.query(
          `INSERT INTO research_authors (research_id, author_id, author_order, role, is_corresponding)
           VALUES ($1,$2,$3,'author',$4) ON CONFLICT DO NOTHING`,
          [researchId, authorId, order, order === 1]);
        order += 1;
      }
      for (const name of input.metadata.supervisors) {
        const authorId = await this.upsertAuthor(name, facultyId);
        await manager.query(
          `INSERT INTO research_authors (research_id, author_id, author_order, role)
           VALUES ($1,$2,1,'supervisor') ON CONFLICT DO NOTHING`, [researchId, authorId]);
      }

      // Keywords
      for (const [terms, lang] of [[input.metadata.keywordsAr, 'ar'], [input.metadata.keywordsEn, 'en']] as const) {
        for (const term of terms) {
          const normalized = normalizeName(term);
          if (normalized.length < 2) continue;
          const [keyword] = await manager.query<Array<{ id: string }>>(
            `INSERT INTO keywords (term, normalized, language) VALUES ($1,$2,$3)
             ON CONFLICT (normalized, language) DO UPDATE SET term = EXCLUDED.term RETURNING id`,
            [term, normalized, lang]);
          await manager.query(
            `INSERT INTO research_keywords (research_id, keyword_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [researchId, keyword.id]);
        }
      }

      const [file] = await manager.query<Array<{ id: string }>>(
        `INSERT INTO research_files
           (research_id, original_filename, stored_path, mime_type, file_kind, size_bytes, sha256, page_count, is_canonical)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING id`,
        [researchId, filename, path, MIME[kind] ?? 'application/octet-stream', kind, info.size, sha256, parsed.pageCount]);

      for (const page of parsed.pages) {
        await manager.query(
          `INSERT INTO research_pages (research_id, file_id, page_number, text, char_count, text_source)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [researchId, file.id, page.pageNumber, page.text, page.charCount, parsed.textSource]);
      }

      const sections = this.structure.detectSections(parsed.pages);
      const sectionIds = new Map<string, string>();
      let sectionOrder = 0;
      for (const section of sections) {
        const [row] = await manager.query<Array<{ id: string }>>(
          `INSERT INTO research_sections (research_id, name, heading, start_page, end_page, section_order)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [researchId, section.name, section.heading, section.startPage, section.endPage, sectionOrder++]);
        sectionIds.set(section.name, row.id);
      }

      const chunks = this.structure.chunk(parsed.pages, sections);
      const chunkIds: string[] = [];
      for (const chunk of chunks) {
        const [row] = await manager.query<Array<{ id: string }>>(
          `INSERT INTO research_chunks
             (research_id, file_id, section_id, chunk_index, text, page_number, section_name,
              heading, token_count, char_count, language, is_overlap, source_filename, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [researchId, file.id, sectionIds.get(chunk.sectionName) ?? null, chunk.chunkIndex, chunk.text,
           chunk.pageNumber, chunk.sectionName, chunk.heading, chunk.tokenCount, chunk.charCount,
           chunk.language, chunk.isOverlap, filename, chunk.contentHash]);
        chunkIds.push(row.id);
      }

      // Any additional files (e.g. the Word twin of a PDF) are recorded as
      // non-canonical so the thesis stays a single research record.
      for (const extra of options.additionalFiles ?? []) {
        const extraKind = kindOf(extra);
        const extraInfo = await stat(extra);
        const extraSha = createHash('sha256').update(await readFile(extra)).digest('hex');
        await manager.query(
          `INSERT INTO research_files
             (research_id, original_filename, stored_path, mime_type, file_kind, size_bytes, sha256, is_canonical)
           VALUES ($1,$2,$3,$4,$5,$6,$7,false)
           ON CONFLICT (sha256) WHERE deleted_at IS NULL DO NOTHING`,
          [researchId, basename(extra), extra, MIME[extraKind] ?? 'application/octet-stream',
           extraKind, extraInfo.size, extraSha]);
      }

      return {
        researchId,
        title,
        pages: parsed.pageCount,
        sections: sections.length,
        chunkCount: chunks.length,
        chunkIds,
        chunkTexts: chunks.map((c) => ({ text: c.text, tokens: c.tokenCount })),
      };
    });

    // ---- Embeddings run AFTER the content transaction commits -------------
    // Keeping them inside would mean a quota failure discards the parsed text,
    // pages and chunks too. Ingestion must survive an exhausted AI quota.
    let embedded = 0;
    let tokensEmbedded = 0;
    let embeddingError: string | null = null;

    if (options.embed !== false) {
      try {
        const result = await this.embedResearch(content.researchId, input.metadata);
        embedded = result.embedded;
        tokensEmbedded = result.tokens;
      } catch (error) {
        embeddingError = (error as Error).message;
        this.logger.warn(`Embeddings deferred for "${content.title.slice(0, 40)}": ${embeddingError.slice(0, 140)}`);
      }
    }

    return {
      researchId: content.researchId,
      title: content.title,
      pages: content.pages,
      sections: content.sections,
      chunks: content.chunkCount,
      embedded,
      pendingEmbeddings: content.chunkCount - embedded,
      tokensEmbedded,
      embeddingError,
    };
  }

  /**
   * Embed any chunks of a research that do not yet have a vector.
   * Idempotent and resumable: safe to call repeatedly after a quota reset.
   */
  async embedResearch(
    researchId: string,
    metadata?: Partial<IngestInput['metadata']>,
  ): Promise<{ embedded: number; tokens: number }> {
    const model = process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-001';

    const pending = await this.dataSource.query<Array<{ id: string; text: string; token_count: number }>>(
      `SELECT c.id, c.text, c.token_count
       FROM research_chunks c
       WHERE c.research_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM research_embeddings e WHERE e.chunk_id = c.id AND e.model = $2
         )
       ORDER BY c.chunk_index`,
      [researchId, model],
    );

    let embedded = 0;
    let tokens = 0;
    const started = Date.now();
    const BATCH = Number(process.env.GEMINI_EMBED_BATCH ?? 16);

    for (let i = 0; i < pending.length; i += BATCH) {
      const slice = pending.slice(i, i + BATCH);
      const vectors = await this.gemini.embed(slice.map((c) => c.text), 'RETRIEVAL_DOCUMENT');

      // One multi-row INSERT per batch. Inserting row-by-row made a full-corpus
      // backfill round-trip to Postgres once per vector, which dominated the
      // wall-clock time once API rate limits were no longer the bottleneck.
      const values: string[] = [];
      const params: unknown[] = [researchId, model];
      for (let j = 0; j < slice.length; j += 1) {
        const base = params.length;
        values.push(`($${base + 1}, $1, $${base + 2}::vector, $2, $${base + 3})`);
        params.push(slice[j].id, `[${vectors[j].join(',')}]`, vectors[j].length);
        tokens += slice[j].token_count;
      }

      await this.dataSource.query(
        `INSERT INTO research_embeddings (chunk_id, research_id, embedding, model, dimensions)
         VALUES ${values.join(', ')}
         ON CONFLICT (chunk_id, model) DO NOTHING`,
        params,
      );
      embedded += slice.length;

      if (pending.length > BATCH) {
        this.logger.log(`  embedded ${Math.min(i + BATCH, pending.length)}/${pending.length}`);
      }
    }

    // Document-level vectors used by title/abstract ranking and recommendations.
    //
    // A backfill run (embed-pending) has no metadata to hand — the paper was
    // ingested long ago — so fall back to the stored row. Without this the two
    // blocks below silently no-op and the vectors are only ever written during
    // a full ingestion, which is how they came to be missing for most papers.
    const stored = metadata
      ? null
      : (
          await this.dataSource.query<
            Array<{ title_ar: string | null; title_en: string | null; abstract_ar: string | null; abstract_en: string | null }>
          >(`SELECT title_ar, title_en, abstract_ar, abstract_en FROM research WHERE id = $1`, [researchId])
        )[0] ?? null;

    const titleText = [metadata?.titleAr ?? stored?.title_ar, metadata?.titleEn ?? stored?.title_en]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (titleText.length > 0) {
      const [vector] = await this.gemini.embed([titleText], 'RETRIEVAL_DOCUMENT');
      await this.dataSource.query(`UPDATE research SET title_embedding = $1::vector WHERE id = $2`,
        [`[${vector.join(',')}]`, researchId]);
    }
    const abstractText = [metadata?.abstractAr ?? stored?.abstract_ar, metadata?.abstractEn ?? stored?.abstract_en]
      .filter(Boolean)
      .join('\n')
      .trim();
    if (abstractText.length > 0) {
      const [vector] = await this.gemini.embed([abstractText.slice(0, 8000)], 'RETRIEVAL_DOCUMENT');
      await this.dataSource.query(`UPDATE research SET abstract_embedding = $1::vector WHERE id = $2`,
        [`[${vector.join(',')}]`, researchId]);
    }

    // Record spend. Without this, embedding and OCR cost is invisible and can
    // only be reconstructed after the fact from row counts.
    if (embedded > 0) {
      await this.dataSource.query(
        `INSERT INTO ai_usage_logs (research_id, operation, model, prompt_tokens, total_tokens, latency_ms, succeeded)
         VALUES ($1,'embedding',$2,$3,$3,$4,true)`,
        [researchId, model, tokens, Date.now() - started],
      );
    }

    return { embedded, tokens };
  }
}
