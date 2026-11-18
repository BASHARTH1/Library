import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AdminService } from '../../core/admin.service';
import { I18nService } from '../../core/i18n.service';

@Component({
  selector: 'app-admin-overview',
  imports: [RouterLink],
  styleUrl: './admin.scss',
  template: `
    <div class="page-head">
      <h1>{{ i18n.t('adminOverview') }}</h1>
      <a class="btn" routerLink="/admin/theses/new">{{ i18n.t('addThesis') }}</a>
    </div>

    @if (error()) {
      <p class="notice">{{ i18n.t('loadFailed') }}</p>
    }
    @if (stats(); as s) {
      <div class="stat-grid">
        <a class="stat" routerLink="/admin/theses"><strong>{{ s['total'] }}</strong>{{ i18n.t('statTotal') }}</a>
        <a class="stat" routerLink="/admin/theses" [queryParams]="{ status: 'published' }"><strong>{{ s['published'] }}</strong>{{ i18n.t('statPublished') }}</a>
        <a class="stat" [class.attention]="s['review'] > 0" routerLink="/admin/theses" [queryParams]="{ status: 'requires_review' }"><strong>{{ s['review'] }}</strong>{{ i18n.t('statReview') }}</a>
        <a class="stat" routerLink="/admin/theses" [queryParams]="{ status: 'processing' }"><strong>{{ s['processing'] }}</strong>{{ i18n.t('statProcessing') }}</a>
        <a class="stat" [class.attention]="s['failed'] > 0" routerLink="/admin/theses" [queryParams]="{ status: 'failed' }"><strong>{{ s['failed'] }}</strong>{{ i18n.t('statFailed') }}</a>
        <a class="stat" routerLink="/admin/theses" [queryParams]="{ trash: 'true' }"><strong>{{ s['trash'] }}</strong>{{ i18n.t('statTrash') }}</a>
        <div class="stat"><strong>{{ s['missing_abstract'] }}</strong>{{ i18n.t('statMissingAbstract') }}</div>
        <div class="stat"><strong>{{ s['pending_vectors'] }}</strong>{{ i18n.t('statPendingVectors') }}</div>
        <div class="stat"><strong>{{ s['tokens_today'] }}</strong>{{ i18n.t('statTokensToday') }}</div>
        <a class="stat" routerLink="/admin/faculties"><strong>{{ s['faculties'] }}</strong>{{ i18n.t('statFaculties') }}</a>
        <div class="stat"><strong>{{ s['users'] }}</strong>{{ i18n.t('statUsers') }}</div>
      </div>
    }
  `,
})
export class AdminOverview {
  readonly i18n = inject(I18nService);
  readonly stats = signal<Record<string, number> | null>(null);
  readonly error = signal(false);

  constructor() {
    inject(AdminService).overview().subscribe({
      next: (stats) => this.stats.set(stats),
      error: () => this.error.set(true),
    });
  }
}
