import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, type Facets, type ResearchSummary, type Stats } from '../../core/api.service';
import { I18nService } from '../../core/i18n.service';

@Component({
  selector: 'app-home',
  imports: [FormsModule, RouterLink],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class HomePage {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  readonly i18n = inject(I18nService);

  readonly query = signal('');
  readonly stats = signal<Stats | null>(null);
  readonly facets = signal<Facets | null>(null);
  readonly latest = signal<ResearchSummary[]>([]);
  readonly mostViewed = signal<ResearchSummary[]>([]);
  readonly loading = signal(true);

  constructor() {
    this.api.stats().subscribe({ next: (s) => this.stats.set(s) });
    this.api.facets().subscribe({ next: (f) => this.facets.set(f) });
    this.api.mostViewed(5).subscribe({ next: (r) => this.mostViewed.set(r) });
    this.api.latest(6).subscribe({
      next: (r) => { this.latest.set(r); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  submit(): void {
    void this.router.navigate(['/search'], { queryParams: { q: this.query() } });
  }

  title(item: ResearchSummary): string {
    return this.i18n.title(item);
  }
}
