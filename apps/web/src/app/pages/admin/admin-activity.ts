import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AdminService, type ActivityRow } from '../../core/admin.service';
import { I18nService } from '../../core/i18n.service';

@Component({
  selector: 'app-admin-activity',
  imports: [DatePipe, RouterLink],
  styleUrl: './admin.scss',
  template: `
    <div class="page-head"><h1>{{ i18n.t('adminActivity') }}</h1></div>
    @if (error()) { <p class="notice">{{ i18n.t('loadFailed') }}</p> }
    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ i18n.t('activityWhen') }}</th>
            <th>{{ i18n.t('activityWho') }}</th>
            <th>{{ i18n.t('activityAction') }}</th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.id) {
            <tr>
              <td class="small">{{ row.created_at | date: 'short' }}</td>
              <td class="small" dir="ltr">{{ row.user_email }}</td>
              <td class="small">
                @if (row.entity_type === 'research' && row.entity_id) {
                  <a dir="ltr" [routerLink]="['/admin/theses', row.entity_id]">{{ row.action }}</a>
                } @else {
                  <span dir="ltr">{{ row.action }}</span>
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="3" class="muted">{{ i18n.t('nothingHere') }}</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class AdminActivity {
  readonly i18n = inject(I18nService);
  readonly rows = signal<ActivityRow[]>([]);
  readonly error = signal(false);

  constructor() {
    inject(AdminService).activity().subscribe({
      next: (rows) => this.rows.set(rows),
      error: () => this.error.set(true),
    });
  }
}
