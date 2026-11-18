import { HttpClient, HttpErrorResponse, HttpEventType, HttpHeaders, HttpParams, HttpRequest } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';

export type ThesisStatus =
  | 'pending' | 'processing' | 'extracted' | 'requires_review'
  | 'approved' | 'published' | 'failed' | 'rejected';

export const ACCESS_LEVELS = [
  'public', 'university_only', 'abstract_only', 'view_only',
  'download_disabled', 'restricted', 'confidential', 'embargoed',
] as const;

export const ASSIGNABLE_ROLES = ['super_admin', 'admin', 'librarian', 'researcher', 'staff', 'student'] as const;

export interface PipelineState {
  researchId: string;
  researchStatus: ThesisStatus;
  stage: string | null;
  nextStep: 'parse' | 'ocr' | 'index' | 'metadata' | 'embed' | null;
  failed: boolean;
  busy: boolean;
  error: string | null;
  warnings: string[];
  totalPages: number;
  ocrCursor: number;
  chunks: number;
  vectors: number;
  indexed: boolean;
}

export interface ThesisRow {
  id: string;
  title_ar: string | null;
  title_en: string | null;
  status: ThesisStatus;
  access_level: string;
  publication_year: number | null;
  total_pages: number | null;
  faculty_name: string | null;
  filename: string | null;
  authors: string[];
  created_at: string;
  deleted_at: string | null;
}

export interface ThesisDetail {
  id: string;
  title_ar: string | null;
  title_en: string | null;
  abstract_ar: string | null;
  abstract_en: string | null;
  publication_year: number | null;
  faculty_id: string | null;
  department_id: string | null;
  degree: string | null;
  doi: string | null;
  access_level: string;
  embargo_until: string | null;
  status: ThesisStatus;
  total_pages: number | null;
  deleted_at: string | null;
  has_title_vector: boolean;
  has_abstract_vector: boolean;
  authors: string[];
  supervisors: string[];
  keywords_ar: string[];
  keywords_en: string[];
  files: Array<{ id: string; original_filename: string; file_kind: string; size_bytes: string | null; is_canonical: boolean }>;
  pipeline: PipelineState;
}

export interface ThesisDetails {
  titleAr?: string | null;
  titleEn?: string | null;
  abstractAr?: string | null;
  abstractEn?: string | null;
  publicationYear?: number | null;
  facultyId?: string | null;
  departmentId?: string | null;
  degree?: string | null;
  doi?: string | null;
  accessLevel?: string;
  embargoUntil?: string | null;
  authors?: string[];
  supervisors?: string[];
  keywordsAr?: string[];
  keywordsEn?: string[];
}

export interface DepartmentRow { id: string; name_ar: string; name_en: string | null; thesis_count: number }
export interface FacultyRow { id: string; name_ar: string; name_en: string | null; thesis_count: number; departments: DepartmentRow[] }

export interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
  is_university_member: boolean;
  last_login_at: string | null;
  roles: string[];
}

export interface ActivityRow {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: string;
  user_email: string | null;
}

export interface FileDescriptor { filename: string; size: number; sha256: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The server's reason for a failure, for showing to the person who caused it. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    const message = (error.error as { message?: string | string[] } | null)?.message;
    if (Array.isArray(message)) return message.join(' · ');
    if (typeof message === 'string') return message;
  }
  return fallback;
}

@Injectable({ providedIn: 'root' })
export class AdminService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/admin';

  overview(): Observable<Record<string, number>> {
    return this.http.get<Record<string, number>>(`${this.base}/overview`);
  }

  activity(): Observable<ActivityRow[]> {
    return this.http.get<ActivityRow[]>(`${this.base}/activity`);
  }

  theses(filters: { q?: string; status?: string; trash?: boolean; limit: number; offset: number }): Observable<{ items: ThesisRow[]; total: number }> {
    let params = new HttpParams().set('limit', filters.limit).set('offset', filters.offset);
    if (filters.q) params = params.set('q', filters.q);
    if (filters.status) params = params.set('status', filters.status);
    if (filters.trash) params = params.set('trash', 'true');
    return this.http.get<{ items: ThesisRow[]; total: number }>(`${this.base}/research`, { params });
  }

  thesis(id: string): Observable<ThesisDetail> {
    return this.http.get<ThesisDetail>(`${this.base}/research/${id}`);
  }

  update(id: string, details: ThesisDetails): Observable<{ vectorWarning: boolean }> {
    return this.http.patch<{ vectorWarning: boolean }>(`${this.base}/research/${id}`, details);
  }

  action(id: string, action: 'publish' | 'unpublish' | 'restore'): Observable<unknown> {
    return this.http.post(`${this.base}/research/${id}/${action}`, {});
  }

  remove(id: string): Observable<unknown> {
    return this.http.delete(`${this.base}/research/${id}`);
  }

  advance(id: string): Observable<PipelineState> {
    return this.http.post<PipelineState>(`${this.base}/research/${id}/process`, {});
  }

  retry(id: string): Observable<PipelineState> {
    return this.http.post<PipelineState>(`${this.base}/research/${id}/retry`, {});
  }

  embedMissing(id: string): Observable<PipelineState> {
    return this.http.post<PipelineState>(`${this.base}/research/${id}/embed-missing`, {});
  }

  /** Fetched with the session token, which a plain link could not send. */
  async openFile(id: string): Promise<void> {
    const blob = await firstValueFrom(this.http.get(`${this.base}/research/${id}/file`, { responseType: 'blob' }));
    window.open(URL.createObjectURL(blob), '_blank');
  }

  /** Hash, then upload. Throws the server's 409 when the file already exists. */
  async uploadFile(file: File, replacing: string | null, onProgress: (percent: number) => void): Promise<FileDescriptor> {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const descriptor: FileDescriptor = { filename: file.name, size: file.size, sha256 };

    const path = replacing ? `research/${replacing}/replace-file/upload-url` : 'research/upload-url';
    const target = await firstValueFrom(
      this.http.post<{ url: string; headers: Record<string, string> }>(`${this.base}/${path}`, descriptor),
    );

    const request = new HttpRequest('PUT', target.url, file, {
      headers: new HttpHeaders(target.headers),
      reportProgress: true,
    });
    await new Promise<void>((resolve, reject) => {
      this.http.request(request).subscribe({
        next: (event) => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        },
        error: reject,
        complete: resolve,
      });
    });
    return descriptor;
  }

  create(file: FileDescriptor, details: ThesisDetails): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/research`, { ...details, file });
  }

  replace(id: string, file: FileDescriptor): Observable<unknown> {
    return this.http.post(`${this.base}/research/${id}/replace-file`, file);
  }

  /**
   * Drives a thesis through its processing steps. Each call runs one bounded step
   * on the server and every step is resumable, so a dropped connection or a function
   * timeout is simply tried again. isCancelled lets a page stop when it is left.
   */
  async process(id: string, onState: (state: PipelineState) => void, isCancelled: () => boolean): Promise<PipelineState | null> {
    let transientFailures = 0;
    for (;;) {
      if (isCancelled()) return null;
      try {
        const state = await firstValueFrom(this.advance(id));
        transientFailures = 0;
        onState(state);
        if (state.failed || state.nextStep === null) return state;
        if (state.busy) await sleep(5000);
      } catch (error) {
        const status = error instanceof HttpErrorResponse ? error.status : 0;
        const transient = status === 0 || status >= 500;
        transientFailures += 1;
        if (!transient || transientFailures > 5) throw error;
        await sleep(3000 * transientFailures);
      }
    }
  }

  faculties(): Observable<FacultyRow[]> {
    return this.http.get<FacultyRow[]>(`${this.base}/faculties`);
  }

  createFaculty(body: { nameAr: string; nameEn?: string | null }): Observable<unknown> {
    return this.http.post(`${this.base}/faculties`, body);
  }

  updateFaculty(id: string, body: { nameAr: string; nameEn?: string | null }): Observable<unknown> {
    return this.http.patch(`${this.base}/faculties/${id}`, body);
  }

  removeFaculty(id: string): Observable<unknown> {
    return this.http.delete(`${this.base}/faculties/${id}`);
  }

  createDepartment(facultyId: string, body: { nameAr: string; nameEn?: string | null }): Observable<unknown> {
    return this.http.post(`${this.base}/faculties/${facultyId}/departments`, body);
  }

  updateDepartment(id: string, body: { nameAr: string; nameEn?: string | null }): Observable<unknown> {
    return this.http.patch(`${this.base}/departments/${id}`, body);
  }

  removeDepartment(id: string): Observable<unknown> {
    return this.http.delete(`${this.base}/departments/${id}`);
  }

  users(q: string): Observable<UserRow[]> {
    return this.http.get<UserRow[]>(`${this.base}/users`, { params: q ? { q } : {} });
  }

  createUser(body: { email: string; password: string; fullName?: string; roles: string[] }): Observable<unknown> {
    return this.http.post(`${this.base}/users`, body);
  }

  updateUser(id: string, body: { isActive?: boolean; isUniversityMember?: boolean; roles?: string[]; password?: string }): Observable<unknown> {
    return this.http.patch(`${this.base}/users/${id}`, body);
  }
}
