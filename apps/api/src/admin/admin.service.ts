import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { DataSource, type EntityManager } from 'typeorm';
import type { RoleCode } from '../auth/auth.types';
import type { AppConfig } from '../config/configuration';
import { R2_SCHEME, isR2Configured, presignR2Put } from '../files/r2';
import { IngestService, MIME, kindOf, normalizeName } from '../ingest/ingest.service';
import type {
  CreateThesisDto,
  CreateUserDto,
  FacultyDto,
  ThesisDetailsDto,
  ThesisFileDto,
  UpdateUserDto,
} from './admin.dto';
import { ThesisPipelineService, placeholderTitle } from './thesis-pipeline.service';

const UPLOADABLE_KINDS = ['pdf', 'docx', 'doc'];

/** The Postgres error for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

/** Column for each editable scalar detail. Lists are stored in their own tables. */
const DETAIL_COLUMNS: Record<string, string> = {
  titleAr: 'title_ar',
  titleEn: 'title_en',
  abstractAr: 'abstract_ar',
  abstractEn: 'abstract_en',
  publicationYear: 'publication_year',
  facultyId: 'faculty_id',
  departmentId: 'department_id',
  degree: 'degree',
  researchType: 'research_type',
  publicationType: 'publication_type',
  doi: 'doi',
  accessLevel: 'access_level',
  embargoUntil: 'embargo_until',
  isFeatured: 'is_featured',
};

/** Empty inputs from a form mean "no value", not an empty string in the record. */
function blankToNull<T>(value: T): T | null {
  return typeof value === 'string' && value.trim() === '' ? null : value;
}

function uniqueNames(names: string[] | undefined): string[] {
  return [...new Set((names ?? []).map((n) => n.trim()).filter(Boolean))];
}

@Injectable()
export class AdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly ingest: IngestService,
    private readonly pipeline: ThesisPipelineService,
  ) {}

  private audit(
    userId: string, action: string, entityType: string, entityId: string | null,
    before: unknown = null, after: unknown = null,
  ): Promise<unknown> {
    return this.dataSource.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, before_value, after_value)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, action, entityType, entityId,
       before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)],
    );
  }

  // ---- overview ------------------------------------------------------------

  async overview(): Promise<Record<string, unknown>> {
    const [counts] = await this.dataSource.query<Array<Record<string, string>>>(
      `SELECT
         count(*) FILTER (WHERE deleted_at IS NULL) AS total,
         count(*) FILTER (WHERE deleted_at IS NULL AND status='published') AS published,
         count(*) FILTER (WHERE deleted_at IS NULL AND status='requires_review') AS review,
         count(*) FILTER (WHERE deleted_at IS NULL AND status='processing') AS processing,
         count(*) FILTER (WHERE deleted_at IS NULL AND status='failed') AS failed,
         count(*) FILTER (WHERE deleted_at IS NOT NULL) AS trash,
         count(*) FILTER (WHERE deleted_at IS NULL AND status='published'
           AND COALESCE(NULLIF(btrim(abstract_ar), ''), NULLIF(btrim(abstract_en), '')) IS NULL) AS missing_abstract
       FROM research`,
    );
    const [other] = await this.dataSource.query<Array<Record<string, string>>>(
      `SELECT
         (SELECT count(*) FROM users WHERE deleted_at IS NULL) AS users,
         (SELECT count(*) FROM faculties WHERE deleted_at IS NULL) AS faculties,
         (SELECT count(*) FROM research_chunks c
            JOIN research r ON r.id = c.research_id AND r.deleted_at IS NULL
            WHERE NOT EXISTS (SELECT 1 FROM research_embeddings e WHERE e.chunk_id = c.id)) AS pending_vectors,
         (SELECT COALESCE(sum(total_tokens),0) FROM ai_usage_logs
            WHERE created_at >= date_trunc('day', now())) AS tokens_today`,
    );
    return Object.fromEntries(Object.entries({ ...counts, ...other }).map(([k, v]) => [k, Number(v)]));
  }

  async activity(limit = 50): Promise<unknown[]> {
    return this.dataSource.query(
      `SELECT l.id, l.action, l.entity_type, l.entity_id, l.after_value, l.created_at, u.email AS user_email
       FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
       ORDER BY l.created_at DESC LIMIT $1`,
      [Math.min(limit, 200)],
    );
  }

  // ---- thesis list and detail ----------------------------------------------

  async listTheses(options: { q?: string; status?: string; trash?: boolean; limit: number; offset: number }): Promise<{
    items: unknown[]; total: number;
  }> {
    const params: unknown[] = [];
    const where = [options.trash ? 'r.deleted_at IS NOT NULL' : 'r.deleted_at IS NULL'];
    if (options.status) {
      params.push(options.status);
      where.push(`r.status = $${params.length}::research_status`);
    }
    if (options.q?.trim()) {
      params.push(`%${options.q.trim()}%`);
      const like = `$${params.length}`;
      where.push(`(r.title_ar ILIKE ${like} OR r.title_en ILIKE ${like} OR EXISTS (
        SELECT 1 FROM research_authors ra JOIN authors a ON a.id = ra.author_id
        WHERE ra.research_id = r.id AND (a.full_name_ar ILIKE ${like} OR a.full_name_en ILIKE ${like})))`);
    }
    const clause = where.join(' AND ');

    const [{ total }] = await this.dataSource.query<Array<{ total: string }>>(
      `SELECT count(*) AS total FROM research r WHERE ${clause}`, params);

    const items = await this.dataSource.query(
      `SELECT r.id, r.title_ar, r.title_en, r.status, r.access_level, r.publication_year, r.total_pages,
              r.created_at, r.deleted_at, f.name_ar AS faculty_name,
              (SELECT original_filename FROM research_files rf
                 WHERE rf.research_id = r.id AND rf.is_canonical ORDER BY rf.created_at DESC LIMIT 1) AS filename,
              COALESCE(ARRAY(SELECT COALESCE(a.full_name_ar, a.full_name_en)
                             FROM research_authors ra JOIN authors a ON a.id = ra.author_id
                             WHERE ra.research_id = r.id AND ra.role='author' ORDER BY ra.author_order), '{}') AS authors
       FROM research r LEFT JOIN faculties f ON f.id = r.faculty_id
       WHERE ${clause}
       ORDER BY r.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, Math.min(options.limit, 100), options.offset],
    );
    return { items, total: Number(total) };
  }

  async thesis(id: string): Promise<Record<string, unknown>> {
    const [row] = await this.dataSource.query<Array<Record<string, unknown>>>(
      `SELECT r.id, r.title_ar, r.title_en, r.abstract_ar, r.abstract_en, r.publication_year, r.faculty_id,
              r.department_id, r.degree, r.research_type, r.publication_type, r.doi, r.access_level,
              r.embargo_until, r.is_featured, r.status, r.language, r.total_pages, r.text_source,
              r.view_count, r.published_at, r.created_at, r.deleted_at,
              (r.title_embedding IS NOT NULL) AS has_title_vector,
              (r.abstract_embedding IS NOT NULL) AS has_abstract_vector
       FROM research r WHERE r.id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('Thesis not found');

    const [contributors, keywords, files, pipeline] = await Promise.all([
      this.dataSource.query<Array<{ name: string; role: string }>>(
        `SELECT COALESCE(a.full_name_ar, a.full_name_en) AS name, ra.role
         FROM research_authors ra JOIN authors a ON a.id = ra.author_id
         WHERE ra.research_id = $1 ORDER BY ra.author_order`, [id]),
      this.dataSource.query<Array<{ term: string; language: string }>>(
        `SELECT k.term, k.language FROM research_keywords rk JOIN keywords k ON k.id = rk.keyword_id
         WHERE rk.research_id = $1 ORDER BY k.term`, [id]),
      this.dataSource.query(
        `SELECT id, original_filename, file_kind, size_bytes, page_count, is_canonical
         FROM research_files WHERE research_id = $1 AND deleted_at IS NULL
         ORDER BY is_canonical DESC, created_at`, [id]),
      this.pipeline.state(id),
    ]);

    return {
      ...row,
      authors: contributors.filter((c) => c.role === 'author').map((c) => c.name),
      supervisors: contributors.filter((c) => c.role === 'supervisor').map((c) => c.name),
      keywords_ar: keywords.filter((k) => k.language === 'ar').map((k) => k.term),
      keywords_en: keywords.filter((k) => k.language === 'en').map((k) => k.term),
      files,
      pipeline,
    };
  }

  /** The canonical file of any thesis, whatever its status. */
  async thesisFile(id: string): Promise<{ storedPath: string; originalFilename: string; mimeType: string }> {
    const [row] = await this.dataSource.query<Array<{ stored_path: string; original_filename: string; mime_type: string }>>(
      `SELECT stored_path, original_filename, mime_type FROM research_files
       WHERE research_id = $1 AND is_canonical AND deleted_at IS NULL LIMIT 1`, [id]);
    if (!row) throw new NotFoundException('File not available');
    return { storedPath: row.stored_path, originalFilename: row.original_filename, mimeType: row.mime_type };
  }

  // ---- uploading -----------------------------------------------------------

  private validateFile(file: ThesisFileDto): { kind: string; mime: string; key: string; storedPath: string } {
    const kind = kindOf(file.filename);
    if (!UPLOADABLE_KINDS.includes(kind)) {
      throw new BadRequestException('Only PDF, DOCX and DOC files can be uploaded');
    }
    const maxMb = this.config.get('storage', { infer: true }).maxUploadSizeMb;
    if (file.size > maxMb * 1024 * 1024) {
      throw new BadRequestException(`The file is larger than the ${maxMb} MB limit`);
    }
    // Content-addressed like upload-files-to-r2, so identical files share a key.
    // The name is built here, never taken from the client.
    const name = `${file.sha256.slice(0, 16)}.${kind}`;
    return {
      kind,
      mime: MIME[kind],
      key: name,
      storedPath: isR2Configured() ? `${R2_SCHEME}research/${name}` : this.localUploadPath(name),
    };
  }

  /** Development only: without R2, uploads land in the local storage folder. */
  localUploadPath(name: string): string {
    const directory = this.config.get('storage', { infer: true }).path;
    mkdirSync(directory, { recursive: true });
    return resolve(directory, name);
  }

  /** A file already attached to a live thesis must never be silently taken over. */
  private async assertNotDuplicate(sha256: string, ignoreResearchId?: string): Promise<void> {
    const [existing] = await this.dataSource.query<Array<{ research_id: string; title: string | null; status: string }>>(
      `SELECT f.research_id, COALESCE(r.title_ar, r.title_en) AS title, r.status
       FROM research_files f JOIN research r ON r.id = f.research_id
       WHERE f.sha256 = $1 AND f.deleted_at IS NULL AND ($2::uuid IS NULL OR f.research_id <> $2) LIMIT 1`,
      [sha256, ignoreResearchId ?? null],
    );
    if (existing) {
      throw new ConflictException({
        message: 'This file is already in the repository',
        code: 'duplicate_file',
        existingId: existing.research_id,
        existingTitle: existing.title,
      });
    }
  }

  /** Where the browser should send the file. */
  async prepareUpload(file: ThesisFileDto, replacing?: string): Promise<{ url: string; headers: Record<string, string> }> {
    const { mime, key } = this.validateFile(file);
    await this.assertNotDuplicate(file.sha256, replacing);
    const url = isR2Configured()
      ? await presignR2Put(`research/${key}`, mime)
      : `/api/admin/uploads/${key}`;
    return { url, headers: { 'Content-Type': mime } };
  }

  async createThesis(dto: CreateThesisDto, userId: string): Promise<{ id: string }> {
    const { file, ...details } = dto;
    const { kind, mime, storedPath } = this.validateFile(file);
    await this.assertNotDuplicate(file.sha256);
    await this.assertDepartmentInFaculty(details.facultyId ?? null, details.departmentId ?? null);
    this.assertEmbargo(details.accessLevel, details.embargoUntil);

    const placeholder = placeholderTitle(file.filename);
    const id = await this.dataSource.transaction(async (manager) => {
      const [research] = await manager.query<Array<{ id: string }>>(
        `INSERT INTO research (title_ar, title_en, status, access_level, research_type, publication_type)
         VALUES ($1, $2, 'processing', 'public', 'thesis', 'master_thesis') RETURNING id`,
        // A title is required from the first moment, so the file name stands in
        // until the admin or the metadata step supplies the real one.
        /[؀-ۿ]/.test(placeholder) ? [placeholder, null] : [null, placeholder],
      );
      await this.applyDetails(manager, research.id, {
        ...details,
        // Absent or blank means keep the stand-in, unless the other title was given.
        titleAr: details.titleAr?.trim() || (details.titleEn?.trim() ? null : undefined),
        titleEn: details.titleEn?.trim() || (details.titleAr?.trim() ? null : undefined),
      });
      await manager.query(
        `INSERT INTO research_files
           (research_id, original_filename, stored_path, mime_type, file_kind, size_bytes, sha256, is_canonical)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
        [research.id, file.filename, storedPath, mime, kind, file.size, file.sha256],
      );
      return research.id;
    });

    await this.pipeline.createJob(id, userId, storedPath, file.filename, null);
    await this.audit(userId, 'thesis.create', 'research', id, null, { filename: file.filename });
    return { id };
  }

  /** Swaps the file and rebuilds everything derived from it. Details are kept. */
  async replaceFile(id: string, file: ThesisFileDto, userId: string): Promise<void> {
    const { kind, mime, storedPath } = this.validateFile(file);
    await this.liveThesis(id);
    await this.assertNotDuplicate(file.sha256, id);

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE research_files SET deleted_at = now(), is_canonical = false
         WHERE research_id = $1 AND is_canonical AND deleted_at IS NULL`, [id]);
      // The new file may already be attached as a non-canonical twin, and sha256 is unique.
      await manager.query(
        `UPDATE research_files SET deleted_at = now()
         WHERE research_id = $1 AND sha256 = $2 AND deleted_at IS NULL`, [id, file.sha256]);
      await manager.query(
        `INSERT INTO research_files
           (research_id, original_filename, stored_path, mime_type, file_kind, size_bytes, sha256, is_canonical)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,
        [id, file.filename, storedPath, mime, kind, file.size, file.sha256],
      );
      // Unlisted until rebuilt: old passages must not be cited against a new file.
      await manager.query(`UPDATE research SET status='processing', published_at=NULL WHERE id=$1`, [id]);
    });

    await this.pipeline.createJob(id, userId, storedPath, file.filename, null);
    await this.audit(userId, 'thesis.replace_file', 'research', id, null, { filename: file.filename });
  }

  // ---- editing -------------------------------------------------------------

  private async liveThesis(id: string): Promise<{ status: string }> {
    const [row] = await this.dataSource.query<Array<{ status: string }>>(
      `SELECT status FROM research WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('Thesis not found');
    return row;
  }

  private async assertDepartmentInFaculty(facultyId: string | null, departmentId: string | null): Promise<void> {
    if (!departmentId) return;
    const [row] = await this.dataSource.query(
      `SELECT 1 FROM departments WHERE id = $1 AND faculty_id = $2 AND deleted_at IS NULL`,
      [departmentId, facultyId],
    );
    if (!row) throw new BadRequestException('The department does not belong to the selected faculty');
  }

  private assertEmbargo(accessLevel?: string, embargoUntil?: string | null): void {
    if (accessLevel === 'embargoed' && !embargoUntil) {
      throw new BadRequestException('An embargoed thesis needs an embargo end date');
    }
  }

  private async applyDetails(manager: EntityManager, id: string, details: ThesisDetailsDto): Promise<void> {
    const assignments: string[] = [];
    const params: unknown[] = [id];
    for (const [field, column] of Object.entries(DETAIL_COLUMNS)) {
      const value = (details as Record<string, unknown>)[field];
      if (value === undefined) continue;
      params.push(blankToNull(value));
      assignments.push(`${column} = $${params.length}`);
    }
    if (assignments.length > 0) {
      try {
        await manager.query(`UPDATE research SET ${assignments.join(', ')} WHERE id = $1`, params);
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ConflictException('Another thesis already has this DOI');
        }
        if ((error as { constraint?: string }).constraint === 'research_has_a_title') {
          throw new BadRequestException('A thesis needs at least one title');
        }
        throw error;
      }
    }

    const facultyId = details.facultyId ?? null;
    for (const [role, names] of [['author', details.authors], ['supervisor', details.supervisors]] as const) {
      if (names === undefined) continue;
      await manager.query(`DELETE FROM research_authors WHERE research_id = $1 AND role = $2`, [id, role]);
      let order = 1;
      for (const name of uniqueNames(names)) {
        const authorId = await this.ingest.upsertAuthor(name, facultyId);
        await manager.query(
          `INSERT INTO research_authors (research_id, author_id, author_order, role, is_corresponding)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [id, authorId, order, role, role === 'author' && order === 1],
        );
        order += 1;
      }
    }

    for (const [terms, language] of [[details.keywordsAr, 'ar'], [details.keywordsEn, 'en']] as const) {
      if (terms === undefined) continue;
      await manager.query(
        `DELETE FROM research_keywords WHERE research_id = $1
           AND keyword_id IN (SELECT id FROM keywords WHERE language = $2)`,
        [id, language],
      );
      for (const term of uniqueNames(terms)) {
        const normalized = normalizeName(term);
        if (normalized.length < 2) continue;
        const [keyword] = await manager.query<Array<{ id: string }>>(
          `INSERT INTO keywords (term, normalized, language) VALUES ($1,$2,$3)
           ON CONFLICT (normalized, language) DO UPDATE SET term = EXCLUDED.term RETURNING id`,
          [term, normalized, language],
        );
        await manager.query(
          `INSERT INTO research_keywords (research_id, keyword_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [id, keyword.id],
        );
      }
    }
  }

  /**
   * Saves details and keeps retrieval in step with them. The search vector follows
   * by trigger; the title and abstract vectors are refreshed here. If that fails
   * the stale vectors are dropped, so `npm run api:embed` picks them up, instead of
   * ranking the thesis on text it no longer has.
   */
  async updateThesis(id: string, details: ThesisDetailsDto, userId: string): Promise<{ vectorWarning: boolean }> {
    await this.liveThesis(id);
    const [before] = await this.dataSource.query<Array<{
      title_ar: string | null; title_en: string | null; abstract_ar: string | null; abstract_en: string | null;
      faculty_id: string | null; department_id: string | null; access_level: string; embargo_until: string | null;
    }>>(
      `SELECT title_ar, title_en, abstract_ar, abstract_en, faculty_id, department_id, access_level, embargo_until
       FROM research WHERE id = $1`, [id]);

    await this.assertDepartmentInFaculty(
      details.facultyId !== undefined ? details.facultyId : before.faculty_id,
      details.departmentId !== undefined ? details.departmentId : before.department_id,
    );
    this.assertEmbargo(
      details.accessLevel ?? before.access_level,
      details.embargoUntil !== undefined ? details.embargoUntil : before.embargo_until,
    );

    await this.dataSource.transaction((manager) => this.applyDetails(manager, id, details));

    const [after] = await this.dataSource.query<Array<{
      title_ar: string | null; title_en: string | null; abstract_ar: string | null; abstract_en: string | null;
    }>>(`SELECT title_ar, title_en, abstract_ar, abstract_en FROM research WHERE id = $1`, [id]);

    const titleChanged = before.title_ar !== after.title_ar || before.title_en !== after.title_en;
    const abstractChanged = before.abstract_ar !== after.abstract_ar || before.abstract_en !== after.abstract_en;

    let vectorWarning = false;
    if (titleChanged || abstractChanged) {
      // A value that was cleared leaves no text to embed, so its vector goes too.
      await this.dataSource.query(
        `UPDATE research SET
           title_embedding = CASE WHEN $2 THEN NULL ELSE title_embedding END,
           abstract_embedding = CASE WHEN $3 THEN NULL ELSE abstract_embedding END
         WHERE id = $1`,
        [id, titleChanged, abstractChanged],
      );
      try {
        await this.ingest.embedDocumentVectors(id);
      } catch {
        vectorWarning = true;
      }
    }

    await this.audit(userId, 'thesis.update', 'research', id, null, { fields: Object.keys(details) });
    return { vectorWarning };
  }

  async publish(id: string, userId: string): Promise<void> {
    await this.liveThesis(id);
    const state = await this.pipeline.state(id);
    if (!state.indexed) throw new ConflictException('This thesis has not finished processing');

    await this.dataSource.query(
      `UPDATE research SET status='published', published_at=COALESCE(published_at, now()) WHERE id=$1`, [id]);
    await this.audit(userId, 'thesis.publish', 'research', id);
  }

  async unpublish(id: string, userId: string): Promise<void> {
    await this.liveThesis(id);
    await this.dataSource.query(`UPDATE research SET status='requires_review' WHERE id=$1 AND status='published'`, [id]);
    await this.audit(userId, 'thesis.unpublish', 'research', id);
  }

  /** Reversible. The files go too, or the same file could never be uploaded again. */
  async deleteThesis(id: string, userId: string): Promise<void> {
    await this.liveThesis(id);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE research SET deleted_at=now() WHERE id=$1`, [id]);
      await manager.query(`UPDATE research_files SET deleted_at=now() WHERE research_id=$1 AND deleted_at IS NULL`, [id]);
    });
    await this.audit(userId, 'thesis.delete', 'research', id);
  }

  /** Comes back unlisted, so restoring never republishes anything by accident. */
  async restoreThesis(id: string, userId: string): Promise<void> {
    const [row] = await this.dataSource.query<Array<{ deleted_at: Date | null }>>(
      `SELECT deleted_at FROM research WHERE id = $1`, [id]);
    if (!row?.deleted_at) throw new NotFoundException('Thesis not found in the trash');

    const [file] = await this.dataSource.query<Array<{ id: string; sha256: string }>>(
      `SELECT id, sha256 FROM research_files WHERE research_id=$1 AND is_canonical ORDER BY created_at DESC LIMIT 1`, [id]);
    if (file) await this.assertNotDuplicate(file.sha256, id);

    await this.dataSource.transaction(async (manager) => {
      if (file) await manager.query(`UPDATE research_files SET deleted_at=NULL WHERE id=$1`, [file.id]);
      await manager.query(
        `UPDATE research SET deleted_at=NULL,
           status = CASE WHEN status='published' THEN 'requires_review'::research_status ELSE status END
         WHERE id=$1`, [id]);
    });
    await this.audit(userId, 'thesis.restore', 'research', id);
  }

  /** Queues the missing vectors of a thesis that is otherwise finished. */
  async queueMissingVectors(id: string, userId: string): Promise<void> {
    await this.liveThesis(id);
    const state = await this.pipeline.state(id);
    if (state.nextStep) return; // Its job is still open and will write them itself.
    const file = await this.thesisFile(id);
    await this.pipeline.createJob(id, userId, file.storedPath, file.originalFilename, 'metadata');
  }

  // ---- faculties and departments -------------------------------------------

  async faculties(): Promise<unknown[]> {
    return this.dataSource.query(
      `SELECT f.id, f.name_ar, f.name_en,
              (SELECT count(*)::int FROM research r WHERE r.faculty_id = f.id AND r.deleted_at IS NULL) AS thesis_count,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'id', d.id, 'name_ar', d.name_ar, 'name_en', d.name_en,
                  'thesis_count', (SELECT count(*) FROM research r WHERE r.department_id = d.id AND r.deleted_at IS NULL)
                ) ORDER BY d.name_ar)
                FROM departments d WHERE d.faculty_id = f.id AND d.deleted_at IS NULL
              ), '[]'::json) AS departments
       FROM faculties f WHERE f.deleted_at IS NULL ORDER BY f.name_ar`,
    );
  }

  private slugOf(name: string): string {
    return normalizeName(name).replace(/\s+/g, '-').slice(0, 60);
  }

  async createFaculty(dto: FacultyDto, userId: string): Promise<{ id: string }> {
    const slug = this.slugOf(dto.nameAr);
    // slug stays unique across soft-deleted rows, so a removed faculty is revived.
    const [row] = await this.dataSource.query<Array<{ id: string; deleted_at: Date | null }>>(
      `SELECT id, deleted_at FROM faculties WHERE slug = $1`, [slug]);
    if (row && !row.deleted_at) throw new ConflictException('This faculty already exists');

    let id: string;
    if (row) {
      await this.dataSource.query(
        `UPDATE faculties SET deleted_at=NULL, name_ar=$2, name_en=$3 WHERE id=$1`,
        [row.id, dto.nameAr.trim(), blankToNull(dto.nameEn ?? null)]);
      id = row.id;
    } else {
      const [created] = await this.dataSource.query<Array<{ id: string }>>(
        `INSERT INTO faculties (name_ar, name_en, slug) VALUES ($1,$2,$3) RETURNING id`,
        [dto.nameAr.trim(), blankToNull(dto.nameEn ?? null), slug]);
      id = created.id;
    }
    await this.audit(userId, 'faculty.create', 'faculty', id, null, { name: dto.nameAr });
    return { id };
  }

  async updateFaculty(id: string, dto: FacultyDto, userId: string): Promise<void> {
    await this.renameOrgUnit('faculties', id, dto);
    await this.audit(userId, 'faculty.update', 'faculty', id, null, { name: dto.nameAr });
  }

  private async renameOrgUnit(table: 'faculties' | 'departments', id: string, dto: FacultyDto): Promise<void> {
    try {
      // TypeORM resolves an UPDATE to [rows, affectedCount].
      const [rows] = await this.dataSource.query<[unknown[], number]>(
        `UPDATE ${table} SET name_ar=$2, name_en=$3 WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
        [id, dto.nameAr.trim(), blankToNull(dto.nameEn ?? null)],
      );
      if (rows.length === 0) throw new NotFoundException('Not found');
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new ConflictException('This name is already in use');
      throw error;
    }
  }

  async deleteFaculty(id: string, userId: string): Promise<void> {
    const [{ theses, departments }] = await this.dataSource.query<Array<{ theses: string; departments: string }>>(
      `SELECT (SELECT count(*) FROM research WHERE faculty_id=$1 AND deleted_at IS NULL) AS theses,
              (SELECT count(*) FROM departments WHERE faculty_id=$1 AND deleted_at IS NULL) AS departments`, [id]);
    if (Number(theses) > 0 || Number(departments) > 0) {
      throw new ConflictException('Move its theses and remove its departments first');
    }
    await this.dataSource.query(`UPDATE faculties SET deleted_at=now() WHERE id=$1`, [id]);
    await this.audit(userId, 'faculty.delete', 'faculty', id);
  }

  async createDepartment(facultyId: string, dto: FacultyDto, userId: string): Promise<{ id: string }> {
    const slug = this.slugOf(dto.nameAr);
    const [faculty] = await this.dataSource.query(
      `SELECT 1 FROM faculties WHERE id=$1 AND deleted_at IS NULL`, [facultyId]);
    if (!faculty) throw new NotFoundException('Faculty not found');

    const [row] = await this.dataSource.query<Array<{ id: string; deleted_at: Date | null }>>(
      `SELECT id, deleted_at FROM departments WHERE faculty_id=$1 AND slug=$2`, [facultyId, slug]);
    if (row && !row.deleted_at) throw new ConflictException('This department already exists');

    let id: string;
    if (row) {
      await this.dataSource.query(
        `UPDATE departments SET deleted_at=NULL, name_ar=$2, name_en=$3 WHERE id=$1`,
        [row.id, dto.nameAr.trim(), blankToNull(dto.nameEn ?? null)]);
      id = row.id;
    } else {
      const [created] = await this.dataSource.query<Array<{ id: string }>>(
        `INSERT INTO departments (faculty_id, name_ar, name_en, slug) VALUES ($1,$2,$3,$4) RETURNING id`,
        [facultyId, dto.nameAr.trim(), blankToNull(dto.nameEn ?? null), slug]);
      id = created.id;
    }
    await this.audit(userId, 'department.create', 'department', id, null, { name: dto.nameAr });
    return { id };
  }

  async updateDepartment(id: string, dto: FacultyDto, userId: string): Promise<void> {
    await this.renameOrgUnit('departments', id, dto);
    await this.audit(userId, 'department.update', 'department', id, null, { name: dto.nameAr });
  }

  async deleteDepartment(id: string, userId: string): Promise<void> {
    const [{ theses }] = await this.dataSource.query<Array<{ theses: string }>>(
      `SELECT count(*) AS theses FROM research WHERE department_id=$1 AND deleted_at IS NULL`, [id]);
    if (Number(theses) > 0) throw new ConflictException('Move its theses to another department first');
    await this.dataSource.query(`UPDATE departments SET deleted_at=now() WHERE id=$1`, [id]);
    await this.audit(userId, 'department.delete', 'department', id);
  }

  // ---- users ---------------------------------------------------------------

  async users(q?: string): Promise<unknown[]> {
    const params: unknown[] = [];
    let filter = '';
    if (q?.trim()) {
      params.push(`%${q.trim()}%`);
      filter = `AND (u.email ILIKE $1 OR u.full_name_en ILIKE $1 OR u.full_name_ar ILIKE $1)`;
    }
    return this.dataSource.query(
      `SELECT u.id, u.email, COALESCE(u.full_name_en, u.full_name_ar) AS full_name, u.is_active,
              u.is_university_member, u.last_login_at, u.created_at,
              COALESCE(ARRAY(SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                             WHERE ur.user_id = u.id ORDER BY r.code), '{}') AS roles
       FROM users u WHERE u.deleted_at IS NULL ${filter}
       ORDER BY u.created_at DESC LIMIT 200`,
      params,
    );
  }

  private async setRoles(manager: EntityManager, userId: string, roles: RoleCode[], grantedBy: string): Promise<void> {
    await manager.query(`DELETE FROM user_roles WHERE user_id=$1`, [userId]);
    for (const role of new Set(roles)) {
      await manager.query(
        `INSERT INTO user_roles (user_id, role_id, granted_by)
         SELECT $1, id, $3 FROM roles WHERE code=$2 ON CONFLICT DO NOTHING`,
        [userId, role, grantedBy],
      );
    }
  }

  async createUser(dto: CreateUserDto, actorId: string): Promise<{ id: string }> {
    const email = dto.email.trim().toLowerCase();
    const [existing] = await this.dataSource.query(
      `SELECT 1 FROM users WHERE lower(email)=$1 AND deleted_at IS NULL`, [email]);
    if (existing) throw new ConflictException('An account with this email already exists');

    const hash = await bcrypt.hash(dto.password, 12);
    const id = await this.dataSource.transaction(async (manager) => {
      const [user] = await manager.query<Array<{ id: string }>>(
        `INSERT INTO users (email, password_hash, full_name_en, is_university_member)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        // Derived from the domain, as in self-registration.
        [email, hash, dto.fullName?.trim() || null, email.endsWith('@gulfuniversity.edu.bh')],
      );
      await this.setRoles(manager, user.id, dto.roles, actorId);
      return user.id;
    });
    await this.audit(actorId, 'user.create', 'user', id, null, { email, roles: dto.roles });
    return { id };
  }

  async updateUser(id: string, dto: UpdateUserDto, actorId: string): Promise<void> {
    // Otherwise the last administrator can lock everyone out of this page.
    if (id === actorId) {
      if (dto.isActive === false) throw new ForbiddenException('You cannot deactivate your own account');
      if (dto.roles && !dto.roles.includes('super_admin')) {
        const [current] = await this.dataSource.query(
          `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id=$1 AND r.code='super_admin'`, [id]);
        if (current) throw new ForbiddenException('You cannot remove your own super administrator role');
      }
    }
    const [user] = await this.dataSource.query(`SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!user) throw new NotFoundException('User not found');

    const hash = dto.password ? await bcrypt.hash(dto.password, 12) : null;
    await this.dataSource.transaction(async (manager) => {
      if (dto.fullName !== undefined) {
        await manager.query(`UPDATE users SET full_name_en=$2 WHERE id=$1`, [id, dto.fullName?.trim() || null]);
      }
      if (dto.isActive !== undefined) await manager.query(`UPDATE users SET is_active=$2 WHERE id=$1`, [id, dto.isActive]);
      if (dto.isUniversityMember !== undefined) {
        await manager.query(`UPDATE users SET is_university_member=$2 WHERE id=$1`, [id, dto.isUniversityMember]);
      }
      if (hash) await manager.query(`UPDATE users SET password_hash=$2 WHERE id=$1`, [id, hash]);
      if (dto.roles) await this.setRoles(manager, id, dto.roles, actorId);
    });

    // The password itself is never logged, only that it changed.
    const { password, ...logged } = dto;
    await this.audit(actorId, 'user.update', 'user', id, null, { ...logged, passwordChanged: Boolean(password) });
  }

  /** Validates a development upload's name, which arrives in the URL. */
  assertLocalUploadName(name: string): void {
    if (!/^[a-f0-9]{16}\.(pdf|docx|doc)$/.test(name)) {
      throw new BadRequestException('Invalid upload name');
    }
  }
}
