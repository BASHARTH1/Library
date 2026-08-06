import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SearchService } from '../search/search.service';

@Injectable()
export class ResearchService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly search: SearchService,
  ) {}

  async stats(): Promise<Record<string, unknown>> {
    const [row] = await this.dataSource.query<Array<Record<string, unknown>>>(
      `SELECT
         (SELECT count(*) FROM research WHERE deleted_at IS NULL AND status='published') AS research_count,
         (SELECT count(*) FROM authors  WHERE deleted_at IS NULL) AS author_count,
         (SELECT count(*) FROM faculties WHERE deleted_at IS NULL) AS faculty_count,
         (SELECT count(*) FROM research_chunks) AS chunk_count,
         (SELECT count(*) FROM research_embeddings) AS embedding_count,
         -- research that has at least one vector, i.e. reachable by semantic search
         (SELECT count(DISTINCT research_id) FROM research_embeddings
            WHERE model = $1) AS semantic_ready_count,
         (SELECT count(*) FROM research_chunks c
            WHERE NOT EXISTS (
              SELECT 1 FROM research_embeddings e WHERE e.chunk_id = c.id AND e.model = $1)
         ) AS pending_embedding_count,
         (SELECT COALESCE(sum(total_pages),0) FROM research WHERE deleted_at IS NULL) AS page_count,
         (SELECT COALESCE(sum(view_count),0) FROM research WHERE deleted_at IS NULL) AS view_count`,
      [process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-001'],
    );
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
  }

  async facets(): Promise<Record<string, unknown>> {
    const [faculties, years, languages, departments] = await Promise.all([
      this.dataSource.query(
        `SELECT f.id, f.name_ar AS name, count(r.id)::int AS count
         FROM faculties f LEFT JOIN research r ON r.faculty_id = f.id AND r.deleted_at IS NULL
         WHERE f.deleted_at IS NULL GROUP BY f.id, f.name_ar ORDER BY count DESC`),
      this.dataSource.query(
        `SELECT publication_year AS year, count(*)::int AS count FROM research
         WHERE deleted_at IS NULL AND publication_year IS NOT NULL
         GROUP BY publication_year ORDER BY publication_year DESC`),
      this.dataSource.query(
        `SELECT language, count(*)::int AS count FROM research
         WHERE deleted_at IS NULL GROUP BY language ORDER BY count DESC`),
      this.dataSource.query(
        `SELECT d.id, d.name_ar AS name, count(r.id)::int AS count
         FROM departments d LEFT JOIN research r ON r.department_id = d.id AND r.deleted_at IS NULL
         WHERE d.deleted_at IS NULL GROUP BY d.id, d.name_ar ORDER BY count DESC`),
    ]);
    return { faculties, years, languages, departments };
  }

  async latest(limit = 8): Promise<unknown[]> {
    return this.dataSource.query(
      `SELECT r.id, r.title_ar, r.title_en, r.publication_year, r.language, r.total_pages,
              r.view_count, f.name_ar AS faculty_name,
              COALESCE(ARRAY(SELECT COALESCE(a.full_name_ar, a.full_name_en)
                             FROM research_authors ra JOIN authors a ON a.id = ra.author_id
                             WHERE ra.research_id = r.id AND ra.role='author' ORDER BY ra.author_order), '{}') AS authors
       FROM research r LEFT JOIN faculties f ON f.id = r.faculty_id
       WHERE r.deleted_at IS NULL AND r.status='published'
       ORDER BY r.published_at DESC NULLS LAST, r.created_at DESC LIMIT $1`, [limit]);
  }

  async mostViewed(limit = 8): Promise<unknown[]> {
    return this.dataSource.query(
      `SELECT r.id, r.title_ar, r.title_en, r.publication_year, r.view_count, f.name_ar AS faculty_name
       FROM research r LEFT JOIN faculties f ON f.id = r.faculty_id
       WHERE r.deleted_at IS NULL AND r.status='published'
       ORDER BY r.view_count DESC LIMIT $1`, [limit]);
  }

  async findOne(id: string, options: { countView?: boolean } = {}): Promise<Record<string, unknown>> {
    const [research] = await this.dataSource.query<Array<Record<string, unknown>>>(
      `SELECT r.*, f.name_ar AS faculty_name, d.name_ar AS department_name
       FROM research r
       LEFT JOIN faculties f ON f.id = r.faculty_id
       LEFT JOIN departments d ON d.id = r.department_id
       WHERE r.id = $1 AND r.deleted_at IS NULL`, [id]);
    if (!research) throw new NotFoundException(`Research ${id} not found`);

    const [authors, keywords, sections, files] = await Promise.all([
      this.dataSource.query(
        `SELECT a.id, COALESCE(a.full_name_ar, a.full_name_en) AS name, ra.role, ra.author_order
         FROM research_authors ra JOIN authors a ON a.id = ra.author_id
         WHERE ra.research_id = $1 ORDER BY ra.role, ra.author_order`, [id]),
      this.dataSource.query(
        `SELECT k.term, k.language FROM research_keywords rk JOIN keywords k ON k.id = rk.keyword_id
         WHERE rk.research_id = $1`, [id]),
      this.dataSource.query(
        `SELECT name, heading, start_page, end_page FROM research_sections
         WHERE research_id = $1 ORDER BY section_order`, [id]),
      this.dataSource.query(
        `SELECT id, original_filename, file_kind, page_count, is_canonical, is_downloadable, size_bytes
         FROM research_files WHERE research_id = $1 AND deleted_at IS NULL`, [id]),
    ]);

    if (options.countView) {
      await this.dataSource.query(`UPDATE research SET view_count = view_count + 1 WHERE id = $1`, [id]);
      await this.dataSource.query(`INSERT INTO views (research_id) VALUES ($1)`, [id]);
    }

    // full_text is large and not needed by the details page.
    delete research.full_text;
    delete research.search_vector;
    delete research.title_embedding;
    delete research.abstract_embedding;
    delete research.keywords_embedding;

    return { ...research, authors, keywords, sections, files };
  }

  async page(researchId: string, pageNumber: number): Promise<{ pageNumber: number; text: string }> {
    const [row] = await this.dataSource.query<Array<{ page_number: number; text: string }>>(
      `SELECT page_number, text FROM research_pages WHERE research_id = $1 AND page_number = $2 LIMIT 1`,
      [researchId, pageNumber]);
    if (!row) throw new NotFoundException(`Page ${pageNumber} not found`);
    return { pageNumber: row.page_number, text: row.text };
  }

  async similar(id: string, isUniversityMember: boolean, isAdmin: boolean): Promise<unknown[]> {
    return this.search.similar(id, 6, isUniversityMember, isAdmin);
  }

  async canonicalFile(id: string): Promise<{ storedPath: string; originalFilename: string; mimeType: string } | null> {
    const [row] = await this.dataSource.query<Array<{ stored_path: string; original_filename: string; mime_type: string }>>(
      `SELECT stored_path, original_filename, mime_type FROM research_files
       WHERE research_id = $1 AND is_canonical = true AND deleted_at IS NULL LIMIT 1`, [id]);
    return row ? { storedPath: row.stored_path, originalFilename: row.original_filename, mimeType: row.mime_type } : null;
  }
}
