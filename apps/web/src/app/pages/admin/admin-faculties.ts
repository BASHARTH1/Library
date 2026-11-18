import { NgTemplateOutlet } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { AdminService, type DepartmentRow, type FacultyRow, errorMessage } from '../../core/admin.service';
import { I18nService } from '../../core/i18n.service';

interface Editing {
  /** 'new-faculty', 'new-dept:<facultyId>', 'faculty:<id>' or 'dept:<id>'. */
  key: string;
  nameAr: string;
  nameEn: string;
}

@Component({
  selector: 'app-admin-faculties',
  imports: [FormsModule, NgTemplateOutlet],
  styleUrl: './admin.scss',
  template: `
    <div class="page-head">
      <h1>{{ i18n.t('adminFaculties') }}</h1>
      <button class="btn" type="button" (click)="start('new-faculty')">{{ i18n.t('addFaculty') }}</button>
    </div>

    @if (error()) { <p class="notice small section" role="alert">{{ error() }}</p> }

    <ng-template #editor>
      <form class="inline-form" (ngSubmit)="commit()">
        <input class="input" name="nameAr" dir="rtl" required [placeholder]="i18n.t('nameAr')"
               [ngModel]="editing()?.nameAr" (ngModelChange)="field('nameAr', $event)" />
        <input class="input" name="nameEn" dir="ltr" [placeholder]="i18n.t('nameEn')"
               [ngModel]="editing()?.nameEn" (ngModelChange)="field('nameEn', $event)" />
        <button class="btn btn-sm" type="submit" [disabled]="busy()">{{ i18n.t('save') }}</button>
        <button class="btn btn-ghost btn-sm" type="button" (click)="editing.set(null)">{{ i18n.t('cancel') }}</button>
      </form>
    </ng-template>

    @if (editing()?.key === 'new-faculty') {
      <div class="card section"><ng-container *ngTemplateOutlet="editor" /></div>
    }

    @for (f of faculties(); track f.id) {
      <section class="card section">
        <div class="faculty-row">
          <div>
            <strong>{{ f.name_ar }}</strong>
            @if (f.name_en) { <span class="muted small"> · {{ f.name_en }}</span> }
            <span class="muted small"> · {{ i18n.tf('thesesCount', f.thesis_count) }}</span>
          </div>
          <div class="actions" style="margin: 0">
            <button class="btn btn-ghost btn-sm" type="button" (click)="start('new-dept:' + f.id)">{{ i18n.t('addDepartment') }}</button>
            <button class="btn btn-ghost btn-sm" type="button" (click)="start('faculty:' + f.id, f)">{{ i18n.t('edit') }}</button>
            <button class="btn btn-danger btn-sm" type="button" (click)="removeFaculty(f)">{{ i18n.t('remove') }}</button>
          </div>
        </div>
        @if (editing()?.key === 'faculty:' + f.id || editing()?.key === 'new-dept:' + f.id) {
          <ng-container *ngTemplateOutlet="editor" />
        }
        @if (f.departments.length) {
          <ul class="dept-list">
            @for (d of f.departments; track d.id) {
              <li>
                <div class="faculty-row">
                  <span class="small">
                    {{ d.name_ar }}
                    @if (d.name_en) { <span class="muted"> · {{ d.name_en }}</span> }
                    <span class="muted"> · {{ i18n.tf('thesesCount', d.thesis_count) }}</span>
                  </span>
                  <div class="actions" style="margin: 0">
                    <button class="btn btn-ghost btn-sm" type="button" (click)="start('dept:' + d.id, d)">{{ i18n.t('edit') }}</button>
                    <button class="btn btn-danger btn-sm" type="button" (click)="removeDepartment(d)">{{ i18n.t('remove') }}</button>
                  </div>
                </div>
                @if (editing()?.key === 'dept:' + d.id) { <ng-container *ngTemplateOutlet="editor" /> }
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
})
export class AdminFaculties {
  readonly i18n = inject(I18nService);
  private readonly admin = inject(AdminService);

  readonly faculties = signal<FacultyRow[]>([]);
  readonly editing = signal<Editing | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');

  constructor() {
    this.load();
  }

  private load(): void {
    this.admin.faculties().subscribe({
      next: (rows) => this.faculties.set(rows),
      error: () => this.error.set(this.i18n.t('loadFailed')),
    });
  }

  start(key: string, row?: { name_ar: string; name_en: string | null }): void {
    this.error.set('');
    this.editing.set({ key, nameAr: row?.name_ar ?? '', nameEn: row?.name_en ?? '' });
  }

  field(name: 'nameAr' | 'nameEn', value: string): void {
    this.editing.update((current) => (current ? { ...current, [name]: value } : current));
  }

  commit(): void {
    const editing = this.editing();
    if (!editing || !editing.nameAr.trim()) return;
    const body = { nameAr: editing.nameAr.trim(), nameEn: editing.nameEn.trim() || null };
    const [kind, id] = editing.key.split(':');

    const request =
      kind === 'new-faculty' ? this.admin.createFaculty(body)
      : kind === 'new-dept' ? this.admin.createDepartment(id, body)
      : kind === 'faculty' ? this.admin.updateFaculty(id, body)
      : this.admin.updateDepartment(id, body);
    this.send(request, () => this.editing.set(null));
  }

  removeFaculty(faculty: FacultyRow): void {
    if (confirm(this.i18n.tf('confirmRemove', faculty.name_ar))) this.send(this.admin.removeFaculty(faculty.id));
  }

  removeDepartment(department: DepartmentRow): void {
    if (confirm(this.i18n.tf('confirmRemove', department.name_ar))) this.send(this.admin.removeDepartment(department.id));
  }

  private send(request: Observable<unknown>, onDone?: () => void): void {
    this.busy.set(true);
    this.error.set('');
    request.subscribe({
      next: () => {
        this.busy.set(false);
        onDone?.();
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(error, this.i18n.t('authFailed')));
      },
    });
  }
}
