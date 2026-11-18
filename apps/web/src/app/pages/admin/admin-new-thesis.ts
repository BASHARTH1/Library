import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ACCESS_LEVELS, AdminService, type FacultyRow, errorMessage } from '../../core/admin.service';
import { I18nService, type StringKey } from '../../core/i18n.service';

const ALLOWED = /\.(pdf|docx|doc)$/i;

function lines(value: string): string[] {
  return value.split('\n').map((v) => v.trim()).filter(Boolean);
}

@Component({
  selector: 'app-admin-new-thesis',
  imports: [FormsModule, RouterLink],
  styleUrl: './admin.scss',
  template: `
    <div class="page-head">
      <h1>{{ i18n.t('addThesis') }}</h1>
      <a class="btn btn-ghost" routerLink="/admin/theses">{{ i18n.t('backToTheses') }}</a>
    </div>

    <form class="card" (ngSubmit)="submit()">
      <p class="muted small">{{ i18n.t('newThesisIntro') }}</p>

      <div class="form-grid">
        <label class="wide">
          <span class="small muted">{{ i18n.t('thesisFile') }}</span>
          <input class="input" type="file" name="file" accept=".pdf,.docx,.doc" required
                 [disabled]="busy()" (change)="pick($event)" />
        </label>

        <label>
          <span class="small muted">{{ i18n.t('faculty') }}</span>
          <select class="select" name="faculty" required [disabled]="busy()"
                  [ngModel]="facultyId()" (ngModelChange)="facultyId.set($event); departmentId.set('')">
            <option value="">{{ i18n.t('chooseFaculty') }}</option>
            @for (f of faculties(); track f.id) { <option [value]="f.id">{{ f.name_ar }}</option> }
          </select>
        </label>

        <label>
          <span class="small muted">{{ i18n.t('department') }}</span>
          <select class="select" name="department" [disabled]="busy() || departments().length === 0"
                  [ngModel]="departmentId()" (ngModelChange)="departmentId.set($event)">
            <option value="">{{ i18n.t('chooseDepartment') }}</option>
            @for (d of departments(); track d.id) { <option [value]="d.id">{{ d.name_ar }}</option> }
          </select>
        </label>

        <label>
          <span class="small muted">{{ i18n.t('accessLevel') }}</span>
          <select class="select" name="access" [disabled]="busy()"
                  [ngModel]="accessLevel()" (ngModelChange)="accessLevel.set($event)">
            @for (level of accessLevels; track level) {
              <option [value]="level">{{ i18n.t(accessKey(level)) }}</option>
            }
          </select>
        </label>

        @if (accessLevel() === 'embargoed') {
          <label>
            <span class="small muted">{{ i18n.t('embargoUntil') }}</span>
            <input class="input" type="date" name="embargo" required [disabled]="busy()"
                   [ngModel]="embargoUntil()" (ngModelChange)="embargoUntil.set($event)" />
          </label>
        }

        <label>
          <span class="small muted">{{ i18n.t('titleAr') }} ({{ i18n.t('optional') }})</span>
          <input class="input" name="titleAr" dir="rtl" [disabled]="busy()"
                 [ngModel]="titleAr()" (ngModelChange)="titleAr.set($event)" />
        </label>

        <label>
          <span class="small muted">{{ i18n.t('titleEn') }} ({{ i18n.t('optional') }})</span>
          <input class="input" name="titleEn" dir="ltr" [disabled]="busy()"
                 [ngModel]="titleEn()" (ngModelChange)="titleEn.set($event)" />
        </label>

        <label class="wide">
          <span class="small muted">{{ i18n.t('authors') }} ({{ i18n.t('optional') }})</span>
          <textarea class="input" name="authors" rows="2" [disabled]="busy()"
                    [ngModel]="authors()" (ngModelChange)="authors.set($event)"></textarea>
        </label>
      </div>

      @if (progressText()) {
        <p class="small" role="status">{{ progressText() }}</p>
        @if (percent() !== null) {
          <div class="progress"><span [style.inline-size.%]="percent()"></span></div>
        }
      }
      @if (error()) { <p class="notice small" role="alert">{{ error() }}</p> }
      @if (duplicateId()) {
        <p class="notice small" role="alert">
          {{ i18n.t('duplicateFile') }} {{ duplicateTitle() }}
          <a [routerLink]="['/admin/theses', duplicateId()]">{{ i18n.t('openExisting') }}</a>
        </p>
      }

      <div class="actions">
        <button class="btn" type="submit" [disabled]="busy() || !file() || !facultyId()">
          @if (busy()) { <span class="spinner"></span> }
          {{ i18n.t('uploadAndProcess') }}
        </button>
      </div>
    </form>
  `,
})
export class AdminNewThesis {
  readonly i18n = inject(I18nService);
  private readonly admin = inject(AdminService);
  private readonly router = inject(Router);

  readonly accessLevels = ACCESS_LEVELS;
  readonly faculties = signal<FacultyRow[]>([]);
  readonly file = signal<File | null>(null);
  readonly facultyId = signal('');
  readonly departmentId = signal('');
  readonly accessLevel = signal<string>('public');
  readonly embargoUntil = signal('');
  readonly titleAr = signal('');
  readonly titleEn = signal('');
  readonly authors = signal('');

  readonly busy = signal(false);
  readonly progressText = signal('');
  readonly percent = signal<number | null>(null);
  readonly error = signal('');
  readonly duplicateId = signal<string | null>(null);
  readonly duplicateTitle = signal('');

  readonly departments = computed(
    () => this.faculties().find((f) => f.id === this.facultyId())?.departments ?? [],
  );

  constructor() {
    this.admin.faculties().subscribe({
      next: (rows) => this.faculties.set(rows),
      error: () => this.error.set(this.i18n.t('loadFailed')),
    });
  }

  accessKey(level: string): StringKey {
    return `access_${level}` as StringKey;
  }

  pick(event: Event): void {
    const chosen = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.error.set('');
    this.duplicateId.set(null);
    if (chosen && !ALLOWED.test(chosen.name)) {
      this.error.set(this.i18n.t('fileWrongType'));
      this.file.set(null);
      return;
    }
    this.file.set(chosen);
  }

  async submit(): Promise<void> {
    const file = this.file();
    if (!file || !this.facultyId() || this.busy()) return;

    this.busy.set(true);
    this.error.set('');
    this.duplicateId.set(null);
    this.progressText.set(this.i18n.t('checkingFile'));
    try {
      const descriptor = await this.admin.uploadFile(file, null, (percent) => {
        this.percent.set(percent);
        this.progressText.set(this.i18n.tf('uploadingFile', percent));
      });
      this.percent.set(null);
      this.progressText.set(this.i18n.t('creatingRecord'));

      const { id } = await firstValueFrom(
        this.admin.create(descriptor, {
          facultyId: this.facultyId(),
          departmentId: this.departmentId() || null,
          accessLevel: this.accessLevel(),
          embargoUntil: this.accessLevel() === 'embargoed' ? this.embargoUntil() : null,
          titleAr: this.titleAr().trim() || null,
          titleEn: this.titleEn().trim() || null,
          authors: lines(this.authors()),
        }),
      );
      // Processing runs from the thesis page, which also resumes it after a reload.
      void this.router.navigate(['/admin/theses', id]);
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy.set(false);
      this.progressText.set('');
      this.percent.set(null);
    }
  }

  private showError(error: unknown): void {
    if (error instanceof HttpErrorResponse && error.status === 409) {
      const body = error.error as { code?: string; existingId?: string; existingTitle?: string | null };
      if (body?.code === 'duplicate_file' && body.existingId) {
        this.duplicateId.set(body.existingId);
        this.duplicateTitle.set(body.existingTitle ?? '');
        return;
      }
    }
    this.error.set(errorMessage(error, this.i18n.t('uploadFailed')));
  }
}
