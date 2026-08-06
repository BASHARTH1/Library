import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, type Facets, type SearchHit, type SearchResponse, type Stats } from '../../core/api.service';
import { I18nService } from '../../core/i18n.service';

@Component({
  selector: 'app-search',
  imports: [FormsModule, RouterLink],
  templateUrl: './search.html',
  styleUrl: './search.scss',
})
export class SearchPage {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly i18n = inject(I18nService);

  readonly query = signal('');
  readonly facultyId = signal('');
  readonly year = signal('');
  readonly language = signal('');
  readonly response = signal<SearchResponse | null>(null);
  readonly facets = signal<Facets | null>(null);
  readonly stats = signal<Stats | null>(null);
  readonly loading = signal(false);

  /** True while part of the corpus still lacks vectors. */
  readonly semanticPartial = computed(() => {
    const s = this.stats();
    return s !== null && s.semantic_ready_count < s.research_count;
  });

  constructor() {
    this.api.facets().subscribe({ next: (f) => this.facets.set(f) });
    this.api.stats().subscribe({ next: (s) => this.stats.set(s) });
    this.route.queryParamMap.subscribe((params) => {
      this.query.set(params.get('q') ?? '');
      this.facultyId.set(params.get('facultyId') ?? '');
      this.year.set(params.get('year') ?? '');
      this.language.set(params.get('language') ?? '');
      this.run();
    });
  }

  private run(): void {
    this.loading.set(true);
    this.api
      .search(this.query(), {
        facultyId: this.facultyId(),
        year: this.year(),
        language: this.language(),
      })
      .subscribe({
        next: (r) => { this.response.set(r); this.loading.set(false); },
        error: () => this.loading.set(false),
      });
  }

  apply(): void {
    void this.router.navigate(['/search'], {
      queryParams: {
        q: this.query() || null,
        facultyId: this.facultyId() || null,
        year: this.year() || null,
        language: this.language() || null,
      },
    });
  }

  title(hit: SearchHit): string {
    return this.i18n.title(hit);
  }

  abstract(hit: SearchHit): string {
    const text = this.i18n.locale() === 'ar'
      ? (hit.abstractAr ?? hit.abstractEn)
      : (hit.abstractEn ?? hit.abstractAr);
    return (text ?? '').slice(0, 260);
  }
}
