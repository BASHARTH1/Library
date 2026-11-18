import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AdminService, type ThesisRow } from '../../core/admin.service';
import { I18nService, type StringKey } from '../../core/i18n.service';

const PAGE_SIZE = 25;
const STATUSES = ['published', 'requires_review', 'processing', 'failed'] as const;

@Component({
  selector: 'app-admin-theses',
  imports: [DatePipe, FormsModule, RouterLink],
  styleUrl: './admin.scss',
  template: `
    <div class="page-head">
      <h1>{{ i18n.t('adminTheses') }}</h1>
      <a class="btn" routerLink="/admin/theses/new">{{ i18n.t('addThesis') }}</a>
    </div>

    <form class="toolbar" (ngSubmit)="load(0)">
      <input class="input" name="q" [placeholder]="i18n.t('searchTheses')"
             [ngModel]="q()" (ngModelChange)="q.set($event)" />
      <select class="select" name="status" [disabled]="trash()"
              [ngModel]="status()" (ngModelChange)="status.set($event); load(0)">
        <option value="">{{ i18n.t('allStatuses') }}</option>
        @for (s of statuses; track s) {
          <option [value]="s">{{ statusLabel(s) }}</option>
        }
      </select>
      <button class="btn btn-ghost" type="submit">{{ i18n.t('search') }}</button>
      <label class="small">
        <input type="checkbox" name="trash" [ngModel]="trash()" (ngModelChange)="trash.set($event); load(0)" />
        {{ i18n.t('showTrash') }}
      </label>
    </form>

    @if (error()) { <p class="notice">{{ i18n.t('loadFailed') }}</p> }

    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ i18n.t('thesisTitle') }}</th>
            <th>{{ i18n.t('faculty') }}</th>
            <th>{{ i18n.t('publicationYear') }}</th>
            <th>{{ i18n.t('thesisStatus') }}</th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.id) {
            <tr>
              <td>
                <a [routerLink]="['/admin/theses', row.id]">{{ i18n.title(row) || row.filename || i18n.t('untitled') }}</a>
                @if (row.authors.length) { <div class="small muted">{{ row.authors.join('، ') }}</div> }
              </td>
              <td class="small">{{ row.faculty_name }}</td>
              <td class="small">{{ row.publication_year }}</td>
              <td>
                <span class="status" [class]="row.status">{{ statusLabel(row.status) }}</span>
                @if (row.deleted_at) { <div class="small muted">{{ row.deleted_at | date: 'shortDate' }}</div> }
              </td>
            </tr>
          } @empty {
            @if (!loading()) { <tr><td colspan="4" class="muted">{{ i18n.t('nothingHere') }}</td></tr> }
          }
        </tbody>
      </table>
    </div>

    @if (total() > pageSize) {
      <div class="pager small">
        <button class="btn btn-ghost btn-sm" type="button" [disabled]="offset() === 0" (click)="load(offset() - pageSize)">{{ i18n.t('previous') }}</button>
        <span class="muted">{{ offset() + 1 }}–{{ offset() + rows().length }} / {{ total() }}</span>
        <button class="btn btn-ghost btn-sm" type="button" [disabled]="offset() + pageSize >= total()" (click)="load(offset() + pageSize)">{{ i18n.t('next') }}</button>
      </div>
    }
  `,
})
export class AdminTheses {
  readonly i18n = inject(I18nService);
  private readonly admin = inject(AdminService);

  readonly statuses = STATUSES;
  readonly pageSize = PAGE_SIZE;
  readonly q = signal('');
  readonly status = signal('');
  readonly trash = signal(false);
  readonly rows = signal<ThesisRow[]>([]);
  readonly total = signal(0);
  readonly offset = signal(0);
  readonly loading = signal(true);
  readonly error = signal(false);

  constructor() {
    const params = inject(ActivatedRoute).snapshot.queryParamMap;
    this.status.set(params.get('status') ?? '');
    this.trash.set(params.get('trash') === 'true');
    this.load(0);
  }

  statusLabel(status: string): string {
    return this.i18n.t(`status_${status}` as StringKey);
  }

  load(offset: number): void {
    this.loading.set(true);
    this.error.set(false);
    this.admin
      .theses({
        q: this.q().trim(),
        status: this.trash() ? '' : this.status(),
        trash: this.trash(),
        limit: PAGE_SIZE,
        offset,
      })
      .subscribe({
        next: ({ items, total }) => {
          this.rows.set(items);
          this.total.set(total);
          this.offset.set(offset);
          this.loading.set(false);
        },
        error: () => {
          this.error.set(true);
          this.loading.set(false);
        },
      });
  }
}
