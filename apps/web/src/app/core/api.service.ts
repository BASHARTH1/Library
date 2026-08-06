import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export interface ResearchSummary {
  id: string;
  title_ar: string | null;
  title_en: string | null;
  publication_year: number | null;
  language: string;
  total_pages: number | null;
  view_count: number | string;
  faculty_name: string | null;
  authors?: string[];
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
    exactTitle: number; author: number; keyword: number; abstract: number;
    semantic: number; fullText: number; recency: number; total: number;
  };
  matchedChunk: {
    text: string;
    pageNumber: number;
    sectionName: string | null;
    isLexical: boolean;
  } | null;
}

export interface SearchResponse {
  hits: SearchHit[];
  total: number;
  usedSemantic: boolean;
  /** true = strict all-terms search found nothing, so terms were OR-ed. */
  relaxed: boolean;
  latencyMs: number;
}

export interface ResearchDetail {
  id: string;
  title_ar: string | null;
  title_en: string | null;
  abstract_ar: string | null;
  abstract_en: string | null;
  publication_year: number | null;
  faculty_name: string | null;
  department_name: string | null;
  language: string;
  degree: string | null;
  doi: string | null;
  research_type: string | null;
  publication_type: string | null;
  total_pages: number | null;
  access_level: string;
  view_count: string;
  download_count: string;
  text_source: string | null;
  authors: Array<{ id: string; name: string; role: string; author_order: number }>;
  keywords: Array<{ term: string; language: string }>;
  sections: Array<{ name: string; heading: string | null; start_page: number; end_page: number }>;
  files: Array<{ id: string; original_filename: string; file_kind: string; page_count: number | null; is_canonical: boolean; is_downloadable: boolean }>;
}

export interface SimilarResearch {
  id: string;
  titleAr: string | null;
  titleEn: string | null;
  publicationYear: number | null;
  similarity: number;
  reasons: string[];
}

export interface AnswerSource {
  chunkId: string;
  researchId: string;
  researchTitle: string;
  pageNumber: number;
  sectionName: string | null;
  excerpt: string;
  similarity: number;
  wasCited: boolean;
  authors: string[];
  publicationYear: number | null;
  facultyName: string | null;
}

export interface FindResponse {
  query: string;
  interpretation: string;
  papers: Array<{
    id: string;
    title: string;
    authors: string[];
    year: number | null;
    faculty: string | null;
    pages: number | null;
    relevance: string;
    score: number;
    matchedPage: number | null;
  }>;
  totalFound: number;
  usedSemantic: boolean;
  relaxed: boolean;
  latencyMs: number;
}

export interface Stats {
  research_count: number;
  author_count: number;
  faculty_count: number;
  chunk_count: number;
  embedding_count: number;
  /** Research reachable by semantic search (has at least one vector). */
  semantic_ready_count: number;
  pending_embedding_count: number;
  page_count: number;
  view_count: number;
}

export interface Facets {
  faculties: Array<{ id: string; name: string; count: number }>;
  years: Array<{ year: number; count: number }>;
  languages: Array<{ language: string; count: number }>;
  departments: Array<{ id: string; name: string; count: number }>;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  readonly base = '/api';

  stats(): Observable<Stats> {
    return this.http.get<Stats>(`${this.base}/stats`);
  }

  facets(): Observable<Facets> {
    return this.http.get<Facets>(`${this.base}/facets`);
  }

  latest(limit = 8): Observable<ResearchSummary[]> {
    return this.http.get<ResearchSummary[]>(`${this.base}/research/latest`, { params: { limit } });
  }

  mostViewed(limit = 6): Observable<ResearchSummary[]> {
    return this.http.get<ResearchSummary[]>(`${this.base}/research/most-viewed`, { params: { limit } });
  }

  search(query: string, filters: Record<string, string | number> = {}): Observable<SearchResponse> {
    let params = new HttpParams().set('q', query);
    for (const [key, value] of Object.entries(filters)) {
      if (value !== '' && value !== undefined && value !== null) params = params.set(key, String(value));
    }
    return this.http.get<SearchResponse>(`${this.base}/search`, { params });
  }

  research(id: string): Observable<ResearchDetail> {
    return this.http.get<ResearchDetail>(`${this.base}/research/${id}`);
  }

  similar(id: string): Observable<SimilarResearch[]> {
    return this.http.get<SimilarResearch[]>(`${this.base}/research/${id}/similar`);
  }

  suggestedQuestions(id: string): Observable<string[]> {
    return this.http.get<string[]>(`${this.base}/research/${id}/suggested-questions`);
  }

  /** Search assistant: papers found by the database, explained by the model. */
  find(query: string, limit = 8): Observable<FindResponse> {
    return this.http.post<FindResponse>(`${this.base}/chat/find`, { query, limit });
  }

  fileUrl(id: string): string {
    return `${this.base}/research/${id}/file`;
  }
}
