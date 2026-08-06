import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GeminiService } from '../gemini/gemini.service';
import { queryVariants, relaxedTsQuery } from './arabic-query';
import type { AccessLevel } from '../database/entities';

/**
 * Minimum cosine similarity for a document to qualify on semantics alone.
 * Gemini embeddings put unrelated Arabic academic prose around 0.65, so a low
 * floor makes every query return the entire corpus.
 */
const SEMANTIC_MATCH_FLOOR = 0.78;

export interface SearchFilters {
  year?: number;
  yearFrom?: number;
  yearTo?: number;
  facultyId?: string;
  departmentId?: string;
  authorId?: string;
  language?: string;
  publicationType?: string;
  researchType?: string;
  keyword?: string;
  accessLevel?: string;
}

export interface SearchHit {
  id: string;
  titleAr: string | null;
  titleEn: string | null;
  abstractAr: string | null;
  abstractEn: string | null;
  publicationYear: number | null;
  facultyName: string | null;
  departmentName: string | null;
  authors: string[];
  language: string;
  accessLevel: string;
  viewCount: number;
  totalPages: number | null;
  scores: {
    exactTitle: number;
    author: number;
    keyword: number;
    abstract: number;
    semantic: number;
    fullText: number;
    recency: number;
    total: number;
  };
  matchedChunk: {
    text: string;
    pageNumber: number;
    sectionName: string | null;
    /** true = passage literally contains the query; false = vector-only match. */
    isLexical: boolean;
  } | null;
}

/**
 * Access levels a viewer may see at all. Restricted/confidential require an
 * explicit grant, which the anonymous/public tier never has.
 */
const PUBLIC_VISIBLE: AccessLevel[] = ['public', 'abstract_only', 'view_only', 'download_disabled'];

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  /** The embedding model whose vectors this instance is allowed to compare. */
  private readonly embeddingModel = process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-001';

  constructor(
    private readonly dataSource: DataSource,
    private readonly gemini: GeminiService,
  ) {}

  /** Access levels visible to this viewer. Applied BEFORE any retrieval. */
  visibleAccessLevels(isUniversityMember: boolean, isAdmin: boolean): AccessLevel[] {
    if (isAdmin) {
      return ['public', 'university_only', 'abstract_only', 'view_only', 'download_disabled', 'restricted', 'confidential', 'embargoed'];
    }
    if (isUniversityMember) return [...PUBLIC_VISIBLE, 'university_only'];
    return PUBLIC_VISIBLE;
  }

  /**
   * Hybrid search: full-text + vector similarity + exact metadata filters +
   * fuzzy author matching + DOI exact match, combined with weighted ranking
   * in the order required by spec §5.
   */
  async search(input: {
    query: string;
    filters?: SearchFilters;
    limit?: number;
    offset?: number;
    isUniversityMember?: boolean;
    isAdmin?: boolean;
    semantic?: boolean;
    /** Internal: OR-relax the terms after a strict pass found nothing. */
    relaxed?: boolean;
  }): Promise<{ hits: SearchHit[]; total: number; usedSemantic: boolean; relaxed: boolean; latencyMs: number }> {
    const started = Date.now();
    const query = input.query.trim();
    const limit = Math.min(input.limit ?? 20, 100);
    const offset = input.offset ?? 0;
    const levels = this.visibleAccessLevels(input.isUniversityMember ?? false, input.isAdmin ?? false);
    const useSemantic = (input.semantic ?? true) && query.length > 0;

    // DOI exact match short-circuits everything.
    const doiMatch = query.match(/\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/);

    let queryVector: string | null = null;
    if (useSemantic) {
      try {
        const vector = await this.gemini.embedOne(query, 'RETRIEVAL_QUERY');
        queryVector = `[${vector.join(',')}]`;
      } catch (error) {
        this.logger.warn(`Semantic search unavailable, falling back to lexical: ${(error as Error).message}`);
      }
    }

    const filters = input.filters ?? {};
    const params: unknown[] = [levels];
    const where: string[] = [`r.deleted_at IS NULL`, `r.status = 'published'`, `r.access_level = ANY($1::access_level[])`];

    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (filters.year) where.push(`r.publication_year = ${push(filters.year)}`);
    if (filters.yearFrom) where.push(`r.publication_year >= ${push(filters.yearFrom)}`);
    if (filters.yearTo) where.push(`r.publication_year <= ${push(filters.yearTo)}`);
    if (filters.facultyId) where.push(`r.faculty_id = ${push(filters.facultyId)}::uuid`);
    if (filters.departmentId) where.push(`r.department_id = ${push(filters.departmentId)}::uuid`);
    if (filters.language) where.push(`r.language = ${push(filters.language)}`);
    if (filters.publicationType) where.push(`r.publication_type = ${push(filters.publicationType)}`);
    if (filters.researchType) where.push(`r.research_type = ${push(filters.researchType)}`);
    if (filters.authorId) {
      where.push(`EXISTS (SELECT 1 FROM research_authors ra WHERE ra.research_id = r.id AND ra.author_id = ${push(filters.authorId)}::uuid)`);
    }
    if (filters.keyword) {
      where.push(`EXISTS (SELECT 1 FROM research_keywords rk JOIN keywords k ON k.id = rk.keyword_id
                          WHERE rk.research_id = r.id AND k.normalized ILIKE ${push(`%${filters.keyword}%`)})`);
    }

    const q = push(query);
    // Corrupted-ligature twin of the query, so correctly spelled Arabic still
    // matches text extracted from the broken PDF fonts. See arabic-query.ts.
    const variants = queryVariants(query);
    const corrupted = variants.length > 1 ? variants[1] : query;
    const qc = push(corrupted);
    const vectorParam = queryVector ? push(queryVector) : null;
    const doiParam = doiMatch ? push(doiMatch[1]) : null;
    const limitParam = push(limit);
    const offsetParam = push(offset);

    // Match either spelling in both full-text and substring comparisons.
    // In relaxed mode every term is OR-ed instead of AND-ed.
    const relaxedQuery = input.relaxed ? relaxedTsQuery(query) : null;
    const tsq = relaxedQuery
      ? `to_tsquery('research_ar', ${push(relaxedQuery)})`
      : `(websearch_to_tsquery('research_ar', ${q}) || websearch_to_tsquery('research_ar', ${qc}))`;
    const ilikeAny = (column: string): string =>
      `(${column} ILIKE '%' || ${q} || '%' OR ${column} ILIKE '%' || ${qc} || '%')`;

    // Weighted ranking. Component order mirrors spec §5's priority list.
    const sql = `
      WITH scoped AS (
        SELECT r.* FROM research r WHERE ${where.join(' AND ')}
      ),
      lexical AS (
        SELECT s.id, ts_rank(s.search_vector, ${tsq}) AS fts_rank
        FROM scoped s
        WHERE ${q} <> '' AND s.search_vector @@ ${tsq}
      ),
      -- The passage that actually contains the query terms. Without this the UI
      -- would show the best-embedding chunk, which often has nothing to do with
      -- the words the user typed.
      lexical_chunk AS (
        SELECT DISTINCT ON (c.research_id)
               c.research_id AS id, c.text, c.page_number, c.section_name,
               ts_rank(c.search_vector, ${tsq}) AS chunk_rank
        FROM research_chunks c
        WHERE ${q} <> ''
          AND c.research_id IN (SELECT id FROM scoped)
          AND c.search_vector @@ ${tsq}
        ORDER BY c.research_id, ts_rank(c.search_vector, ${tsq}) DESC
      ),
      semantic AS (
        ${vectorParam ? `
        SELECT e.research_id AS id,
               MAX(1 - (e.embedding <=> ${vectorParam}::vector)) AS similarity,
               (ARRAY_AGG(c.text      ORDER BY e.embedding <=> ${vectorParam}::vector))[1] AS chunk_text,
               (ARRAY_AGG(c.page_number ORDER BY e.embedding <=> ${vectorParam}::vector))[1] AS chunk_page,
               (ARRAY_AGG(c.section_name ORDER BY e.embedding <=> ${vectorParam}::vector))[1] AS chunk_section
        FROM research_embeddings e
        JOIN research_chunks c ON c.id = e.chunk_id
        -- Vectors from different models occupy different spaces and must never
        -- be compared. Only the currently configured model is queried.
        WHERE e.model = ${push(this.embeddingModel)}
          AND e.research_id IN (SELECT id FROM scoped)
        GROUP BY e.research_id
        ` : `SELECT NULL::uuid AS id, 0::float AS similarity, NULL::text AS chunk_text,
                    NULL::int AS chunk_page, NULL::text AS chunk_section WHERE false`}
      ),
      -- Author names and aliases are unioned first, then aggregated once:
      -- aggregating a GREATEST() over another aggregate is not valid SQL.
      author_candidates AS (
        SELECT ra.research_id, similarity(a.normalized_name, lower(${q})) AS sim
        FROM research_authors ra
        JOIN authors a ON a.id = ra.author_id
        WHERE ra.research_id IN (SELECT id FROM scoped) AND ${q} <> ''
        UNION ALL
        SELECT ra.research_id, similarity(al.normalized_alias, lower(${q})) AS sim
        FROM research_authors ra
        JOIN author_aliases al ON al.author_id = ra.author_id
        WHERE ra.research_id IN (SELECT id FROM scoped) AND ${q} <> ''
      ),
      author_match AS (
        SELECT research_id AS id, MAX(sim) AS author_sim
        FROM author_candidates GROUP BY research_id
      ),
      keyword_match AS (
        SELECT rk.research_id AS id, MAX(similarity(k.normalized, lower(${q}))) AS keyword_sim
        FROM research_keywords rk
        JOIN keywords k ON k.id = rk.keyword_id
        WHERE rk.research_id IN (SELECT id FROM scoped) AND ${q} <> ''
        GROUP BY rk.research_id
      )
      SELECT
        s.id, s.title_ar, s.title_en, s.abstract_ar, s.abstract_en, s.publication_year,
        s.language, s.access_level, s.view_count, s.total_pages,
        f.name_ar AS faculty_name, d.name_ar AS department_name,
        COALESCE(ARRAY(
          SELECT COALESCE(a.full_name_ar, a.full_name_en)
          FROM research_authors ra JOIN authors a ON a.id = ra.author_id
          WHERE ra.research_id = s.id AND ra.role = 'author'
          ORDER BY ra.author_order
        ), '{}') AS authors,
        -- 1. exact title match
        CASE WHEN ${q} <> '' AND (lower(COALESCE(s.title_ar,'')) = lower(${q})
                               OR lower(COALESCE(s.title_en,'')) = lower(${q})) THEN 1.0
             WHEN ${q} <> '' AND (${ilikeAny(`COALESCE(s.title_ar,'')`)}
                               OR ${ilikeAny(`COALESCE(s.title_en,'')`)}) THEN 0.75
             ELSE 0 END AS exact_title_score,
        COALESCE(am.author_sim, 0)   AS author_score,
        COALESCE(km.keyword_sim, 0)  AS keyword_score,
        CASE WHEN ${q} <> '' AND (${ilikeAny(`COALESCE(s.abstract_ar,'')`)}
                               OR ${ilikeAny(`COALESCE(s.abstract_en,'')`)}) THEN 0.6 ELSE 0 END AS abstract_score,
        COALESCE(sem.similarity, 0)  AS semantic_score,
        COALESCE(lx.fts_rank, 0)     AS fulltext_score,
        -- recency: linear decay over 10 years
        CASE WHEN s.publication_year IS NULL THEN 0
             ELSE GREATEST(0, 1 - (EXTRACT(YEAR FROM now())::int - s.publication_year) / 10.0) END AS recency_score,
        ${doiParam ? `CASE WHEN lower(COALESCE(s.doi,'')) = lower(${doiParam}) THEN 1 ELSE 0 END` : '0'} AS doi_score,
        -- Prefer the passage containing the query terms; fall back to the
        -- nearest-embedding passage only when there is no lexical match.
        COALESCE(lc.text, sem.chunk_text)                AS chunk_text,
        COALESCE(lc.page_number, sem.chunk_page)         AS chunk_page,
        COALESCE(lc.section_name, sem.chunk_section)     AS chunk_section,
        (lc.id IS NOT NULL)                              AS chunk_is_lexical,
        COUNT(*) OVER() AS total_count
      FROM scoped s
      LEFT JOIN faculties   f  ON f.id = s.faculty_id
      LEFT JOIN departments d  ON d.id = s.department_id
      LEFT JOIN lexical     lx ON lx.id = s.id
      LEFT JOIN lexical_chunk lc ON lc.id = s.id
      LEFT JOIN semantic    sem ON sem.id = s.id
      LEFT JOIN author_match am ON am.id = s.id
      LEFT JOIN keyword_match km ON km.id = s.id
      WHERE ${q} = '' OR (
            lx.id IS NOT NULL
         OR lc.id IS NOT NULL
         -- Unrelated Arabic academic text still scores ~0.65 cosine, so a low
         -- threshold here returns the whole corpus. Only a genuinely strong
         -- vector match qualifies a document on semantics alone.
         OR sem.similarity > ${SEMANTIC_MATCH_FLOOR}
         OR am.author_sim  > 0.30
         OR km.keyword_sim > 0.30
         OR ${ilikeAny(`COALESCE(s.title_ar,'')`)}
         OR ${ilikeAny(`COALESCE(s.title_en,'')`)}
         OR ${ilikeAny(`COALESCE(s.abstract_ar,'')`)}
         OR ${ilikeAny(`COALESCE(s.abstract_en,'')`)}
         ${doiParam ? `OR lower(COALESCE(s.doi,'')) = lower(${doiParam})` : ''}
      )
      ORDER BY (
          ${doiParam ? `CASE WHEN lower(COALESCE(s.doi,'')) = lower(${doiParam}) THEN 100 ELSE 0 END +` : ''}
          CASE WHEN ${q} <> '' AND (lower(COALESCE(s.title_ar,'')) = lower(${q})
                                 OR lower(COALESCE(s.title_en,'')) = lower(${q})) THEN 10.0
               WHEN ${q} <> '' AND (${ilikeAny(`COALESCE(s.title_ar,'')`)}
                                 OR ${ilikeAny(`COALESCE(s.title_en,'')`)}) THEN 4.0
               ELSE 0 END
        + COALESCE(am.author_sim, 0)  * 3.0
        + COALESCE(km.keyword_sim, 0) * 2.5
        + CASE WHEN ${q} <> '' AND (${ilikeAny(`COALESCE(s.abstract_ar,'')`)}
                                 OR ${ilikeAny(`COALESCE(s.abstract_en,'')`)}) THEN 2.0 ELSE 0 END
        + COALESCE(sem.similarity, 0) * 2.0
        + COALESCE(lx.fts_rank, 0)    * 1.5
        -- a passage literally containing the query outranks a vector-only match
        + CASE WHEN lc.id IS NOT NULL THEN 3.0 ELSE 0 END
        + CASE WHEN s.publication_year IS NULL THEN 0
               ELSE GREATEST(0, 1 - (EXTRACT(YEAR FROM now())::int - s.publication_year) / 10.0) END * 0.5
      ) DESC, s.publication_year DESC NULLS LAST
      LIMIT ${limitParam} OFFSET ${offsetParam}`;

    const rows = await this.dataSource.query<Array<Record<string, unknown>>>(sql, params);

    const hits: SearchHit[] = rows.map((row) => {
      const exactTitle = Number(row.exact_title_score ?? 0);
      const author = Number(row.author_score ?? 0);
      const keyword = Number(row.keyword_score ?? 0);
      const abstract = Number(row.abstract_score ?? 0);
      const semantic = Number(row.semantic_score ?? 0);
      const fullText = Number(row.fulltext_score ?? 0);
      const recency = Number(row.recency_score ?? 0);
      return {
        id: String(row.id),
        titleAr: (row.title_ar as string) ?? null,
        titleEn: (row.title_en as string) ?? null,
        abstractAr: (row.abstract_ar as string) ?? null,
        abstractEn: (row.abstract_en as string) ?? null,
        publicationYear: row.publication_year ? Number(row.publication_year) : null,
        facultyName: (row.faculty_name as string) ?? null,
        departmentName: (row.department_name as string) ?? null,
        authors: ((row.authors as string[]) ?? []).filter(Boolean),
        language: String(row.language),
        accessLevel: String(row.access_level),
        viewCount: Number(row.view_count ?? 0),
        totalPages: row.total_pages ? Number(row.total_pages) : null,
        scores: {
          exactTitle, author, keyword, abstract, semantic, fullText, recency,
          // Mirrors the SQL ORDER BY exactly, including the term-match bonus,
          // so the score shown to users explains the order they see.
          total: Number(
            (
              exactTitle * 10 +
              author * 3 +
              keyword * 2.5 +
              abstract * 2 +
              semantic * 2 +
              fullText * 1.5 +
              recency * 0.5 +
              (row.chunk_is_lexical ? 3 : 0)
            ).toFixed(4),
          ),
        },
        matchedChunk: row.chunk_text
          ? {
              text: String(row.chunk_text).slice(0, 400),
              pageNumber: Number(row.chunk_page),
              sectionName: (row.chunk_section as string) ?? null,
              isLexical: Boolean(row.chunk_is_lexical),
            }
          : null,
      };
    });

    // A strict all-terms query that finds nothing is retried with OR semantics,
    // so a single rare word cannot turn a reasonable search into "no results".
    if (hits.length === 0 && query !== '' && !input.relaxed) {
      const fallback = await this.search({ ...input, relaxed: true });
      if (fallback.hits.length > 0) {
        return { ...fallback, relaxed: true, latencyMs: Date.now() - started };
      }
    }

    return {
      hits,
      total: rows.length > 0 ? Number(rows[0].total_count) : 0,
      usedSemantic: queryVector !== null,
      relaxed: input.relaxed ?? false,
      latencyMs: Date.now() - started,
    };
  }

  /** Similar-research recommendations with an explanation for each (spec §13). */
  async similar(researchId: string, limit = 6, isUniversityMember = false, isAdmin = false): Promise<Array<{
    id: string; titleAr: string | null; titleEn: string | null; publicationYear: number | null;
    similarity: number; reasons: string[];
  }>> {
    const levels = this.visibleAccessLevels(isUniversityMember, isAdmin);
    const rows = await this.dataSource.query<Array<Record<string, unknown>>>(
      `WITH source AS (SELECT id, faculty_id, department_id, research_type, abstract_embedding FROM research WHERE id = $1),
            candidate AS (
              SELECT r.id, r.title_ar, r.title_en, r.publication_year, r.faculty_id, r.department_id, r.research_type,
                     1 - (r.abstract_embedding <=> (SELECT abstract_embedding FROM source)) AS similarity
              FROM research r, source s
              WHERE r.id <> s.id AND r.deleted_at IS NULL AND r.status = 'published'
                AND r.access_level = ANY($2::access_level[])
                AND r.abstract_embedding IS NOT NULL
                AND (SELECT abstract_embedding FROM source) IS NOT NULL
            )
       SELECT c.*, s.faculty_id AS src_faculty, s.department_id AS src_department, s.research_type AS src_type,
              (SELECT COUNT(*) FROM research_keywords rk1
                JOIN research_keywords rk2 ON rk1.keyword_id = rk2.keyword_id
                WHERE rk1.research_id = c.id AND rk2.research_id = $1) AS shared_keywords
       FROM candidate c, source s
       ORDER BY c.similarity DESC LIMIT $3`,
      [researchId, levels, limit],
    );

    return rows.map((row) => {
      const reasons: string[] = [];
      if (Number(row.similarity) > 0.75) reasons.push('Similar topic');
      if (Number(row.shared_keywords) > 0) reasons.push(`${row.shared_keywords} shared keyword(s)`);
      if (row.faculty_id === row.src_faculty) reasons.push('Same faculty');
      if (row.department_id && row.department_id === row.src_department) reasons.push('Same department');
      if (row.research_type && row.research_type === row.src_type) reasons.push('Same research type');
      if (reasons.length === 0) reasons.push('Related content');
      return {
        id: String(row.id),
        titleAr: (row.title_ar as string) ?? null,
        titleEn: (row.title_en as string) ?? null,
        publicationYear: row.publication_year ? Number(row.publication_year) : null,
        similarity: Number(Number(row.similarity).toFixed(4)),
        reasons,
      };
    });
  }

  /** Retrieve top chunks for RAG, access-filtered before retrieval. */
  async retrieveChunks(input: {
    query: string;
    researchId?: string;
    limit?: number;
    isUniversityMember?: boolean;
    isAdmin?: boolean;
    /** Cap chunks taken from any one paper so a single document cannot dominate. */
    maxPerResearch?: number;
  }): Promise<Array<{
    chunkId: string; researchId: string; researchTitle: string; pageNumber: number;
    sectionName: string | null; text: string; similarity: number;
    authors: string[]; publicationYear: number | null; facultyName: string | null;
    retrieval: 'semantic' | 'lexical';
  }>> {
    const levels = this.visibleAccessLevels(input.isUniversityMember ?? false, input.isAdmin ?? false);
    const limit = Math.min(input.limit ?? 12, 40);
    // Repository-wide answers should span papers, not quote one paper 12 times.
    const perResearch = input.maxPerResearch ?? (input.researchId ? limit : 3);

    // Embedding the query can fail (quota) or return nothing useful when the
    // corpus is not yet vectorised. RAG must still work, so fall back to
    // full-text chunk retrieval rather than returning no context at all.
    let vector: number[] | null = null;
    try {
      vector = await this.gemini.embedOne(input.query, 'RETRIEVAL_QUERY');
    } catch (error) {
      this.logger.warn(`Query embedding unavailable, using lexical retrieval: ${(error as Error).message.slice(0, 120)}`);
    }

    if (vector === null) {
      return this.retrieveChunksLexical({ ...input, levels, limit, perResearch });
    }

    const params: unknown[] = [`[${vector.join(',')}]`, levels, limit, this.embeddingModel, perResearch];
    if (input.researchId) params.push(input.researchId);

    const rows = await this.dataSource.query<Array<Record<string, unknown>>>(
      `WITH ranked AS (
         SELECT c.id AS chunk_id, c.research_id, c.page_number, c.section_name, c.text,
                1 - (e.embedding <=> $1::vector) AS similarity,
                ROW_NUMBER() OVER (
                  PARTITION BY e.research_id ORDER BY e.embedding <=> $1::vector
                ) AS rank_in_research
         FROM research_embeddings e
         JOIN research_chunks c ON c.id = e.chunk_id
         JOIN research r ON r.id = e.research_id
         WHERE r.deleted_at IS NULL
           AND r.status = 'published'
           AND r.access_level = ANY($2::access_level[])
           AND e.model = $4
           ${input.researchId ? 'AND e.research_id = $6::uuid' : ''}
       )
       SELECT k.chunk_id, k.research_id, k.page_number, k.section_name, k.text, k.similarity,
              COALESCE(r.title_ar, r.title_en) AS research_title,
              r.publication_year, f.name_ar AS faculty_name,
              COALESCE(ARRAY(
                SELECT COALESCE(a.full_name_ar, a.full_name_en)
                FROM research_authors ra JOIN authors a ON a.id = ra.author_id
                WHERE ra.research_id = k.research_id AND ra.role = 'author'
                ORDER BY ra.author_order
              ), '{}') AS authors
       FROM ranked k
       JOIN research r ON r.id = k.research_id
       LEFT JOIN faculties f ON f.id = r.faculty_id
       WHERE k.rank_in_research <= $5
       ORDER BY k.similarity DESC
       LIMIT $3`,
      params,
    );

    return rows.map((row) => ({
      chunkId: String(row.chunk_id),
      researchId: String(row.research_id),
      researchTitle: String(row.research_title ?? ''),
      pageNumber: Number(row.page_number),
      sectionName: (row.section_name as string) ?? null,
      text: String(row.text),
      similarity: Number(Number(row.similarity).toFixed(5)),
      authors: ((row.authors as string[]) ?? []).filter(Boolean),
      publicationYear: row.publication_year ? Number(row.publication_year) : null,
      facultyName: (row.faculty_name as string) ?? null,
      retrieval: 'semantic' as const,
    }));
  }

  /**
   * Full-text chunk retrieval, used when vectors are unavailable.
   *
   * Retrieval quality is lower than semantic search — it matches words, not
   * meaning — but it keeps grounded answers possible across the whole corpus,
   * and `similarity` is reported on the same 0-1 scale so callers need no
   * special handling. Strict all-terms matching is relaxed to OR when it finds
   * nothing, mirroring document search.
   */
  private async retrieveChunksLexical(input: {
    query: string;
    researchId?: string;
    levels: AccessLevel[];
    limit: number;
    perResearch: number;
  }): Promise<Array<{
    chunkId: string; researchId: string; researchTitle: string; pageNumber: number;
    sectionName: string | null; text: string; similarity: number;
    authors: string[]; publicationYear: number | null; facultyName: string | null;
    retrieval: 'semantic' | 'lexical';
  }>> {
    const variants = queryVariants(input.query);
    const corrupted = variants.length > 1 ? variants[1] : input.query;

    const run = async (tsqSql: string, extra: unknown[]): Promise<Array<Record<string, unknown>>> => {
      const params: unknown[] = [input.levels, input.limit, input.perResearch, ...extra];
      const researchParam = input.researchId ? `$${params.length + 1}::uuid` : null;
      if (input.researchId) params.push(input.researchId);

      return this.dataSource.query<Array<Record<string, unknown>>>(
        `WITH ranked AS (
           SELECT c.id AS chunk_id, c.research_id, c.page_number, c.section_name, c.text,
                  ts_rank(c.search_vector, ${tsqSql}) AS rank,
                  ROW_NUMBER() OVER (
                    PARTITION BY c.research_id ORDER BY ts_rank(c.search_vector, ${tsqSql}) DESC
                  ) AS rank_in_research
           FROM research_chunks c
           JOIN research r ON r.id = c.research_id
           WHERE r.deleted_at IS NULL
             AND r.status = 'published'
             AND r.access_level = ANY($1::access_level[])
             AND c.search_vector @@ ${tsqSql}
             ${researchParam ? `AND c.research_id = ${researchParam}` : ''}
         )
         SELECT k.chunk_id, k.research_id, k.page_number, k.section_name, k.text, k.rank,
                COALESCE(r.title_ar, r.title_en) AS research_title,
                r.publication_year, f.name_ar AS faculty_name,
                COALESCE(ARRAY(
                  SELECT COALESCE(a.full_name_ar, a.full_name_en)
                  FROM research_authors ra JOIN authors a ON a.id = ra.author_id
                  WHERE ra.research_id = k.research_id AND ra.role = 'author'
                  ORDER BY ra.author_order
                ), '{}') AS authors
         FROM ranked k
         JOIN research r ON r.id = k.research_id
         LEFT JOIN faculties f ON f.id = r.faculty_id
         WHERE k.rank_in_research <= $3
         ORDER BY k.rank DESC
         LIMIT $2`,
        params,
      );
    };

    // Strict pass: every term must appear (either spelling).
    let rows = await run(
      `(websearch_to_tsquery('research_ar', $4) || websearch_to_tsquery('research_ar', $5))`,
      [input.query, corrupted],
    );

    // Relaxed pass: any term.
    if (rows.length === 0) {
      const relaxed = relaxedTsQuery(input.query);
      if (relaxed) rows = await run(`to_tsquery('research_ar', $4)`, [relaxed]);
    }

    // ts_rank is unbounded; squash to 0-1 so downstream confidence scoring holds.
    const maxRank = rows.reduce((max, r) => Math.max(max, Number(r.rank ?? 0)), 0) || 1;

    return rows.map((row) => ({
      chunkId: String(row.chunk_id),
      researchId: String(row.research_id),
      researchTitle: String(row.research_title ?? ''),
      pageNumber: Number(row.page_number),
      sectionName: (row.section_name as string) ?? null,
      text: String(row.text),
      similarity: Number(Math.min(1, Number(row.rank ?? 0) / maxRank).toFixed(5)),
      authors: ((row.authors as string[]) ?? []).filter(Boolean),
      publicationYear: row.publication_year ? Number(row.publication_year) : null,
      facultyName: (row.faculty_name as string) ?? null,
      retrieval: 'lexical' as const,
    }));
  }
}
