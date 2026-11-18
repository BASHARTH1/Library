import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  ACCESS_LEVELS,
  AdminService,
  type FacultyRow,
  type PipelineState,
  type ThesisDetail,
  type ThesisDetails,
  errorMessage,
} from '../../core/admin.service';
import { I18nService, type StringKey } from '../../core/i18n.service';

/** Pipeline order. A step is finished once the job's next step lies beyond it. */
const STEPS = ['parse', 'ocr', 'index', 'metadata', 'embed'] as const;
const STEP_LABELS: Record<(typeof STEPS)[number], StringKey> = {
  parse: 'stepParse',
  ocr: 'stepOcr',
  index: 'stepIndex',
  metadata: 'stepMetadata',
  embed: 'stepEmbed',
};

interface Form {
  titleAr: string;
  titleEn: string;
  abstractAr: string;
  abstractEn: string;
  publicationYear: string;
  facultyId: string;
  departmentId: string;
  degree: string;
  doi: string;
  accessLevel: string;
  embargoUntil: string;
  authors: string;
  supervisors: string;
  keywordsAr: string;
  keywordsEn: string;
}

const lines = (value: string): string[] => value.split('\n').map((v) => v.trim()).filter(Boolean);
const commaList = (value: string): string[] => value.split(/[,،\n]/).map((v) => v.trim()).filter(Boolean);

@Component({
  selector: 'app-admin-thesis',
  imports: [FormsModule, RouterLink],
  styleUrl: './admin.scss',
  template: `
    <div class="page-head">
      <h1>{{ heading() }}</h1>
      <a class="btn btn-ghost" routerLink="/admin/theses">{{ i18n.t('backToTheses') }}</a>
    </div>

    @if (loadError()) { <p class="notice">{{ i18n.t('loadFailed') }}</p> }

    @if (thesis(); as t) {
      @if (t.deleted_at) {
        <section class="card section">
          <p class="small">{{ i18n.t('restoredHint') }}</p>
          <button class="btn" type="button" [disabled]="working()" (click)="run('restore')">{{ i18n.t('restoreThesis') }}</button>
        </section>
      }

      @if (pipeline(); as p) {
        <!-- Processing, shown only while there is something to say about it. -->
        @if (p.nextStep || p.failed) {
          <section class="card section">
            <h2>{{ i18n.t('processingTitle') }}</h2>
            <ol class="steps">
              @for (step of steps; track step) {
                <li [class.done]="isDone(step)"
                    [class.current]="p.nextStep === step && !p.failed"
                    [class.stopped]="p.nextStep === step && p.failed">
                  {{ i18n.t(stepLabels[step]) }}
                  @if (step === 'ocr' && p.nextStep === 'ocr' && p.ocrCursor > 0) {
                    <small>{{ i18n.tf('ocrProgress', p.ocrCursor, p.totalPages) }}</small>
                  }
                  @if (step === 'embed' && p.nextStep === 'embed') {
                    <small>{{ i18n.tf('vectorProgress', p.vectors, p.chunks) }}</small>
                  }
                </li>
              }
            </ol>
            @if (p.failed) {
              <p class="notice small" role="alert">{{ i18n.t('processingFailed') }} {{ p.error }}</p>
              <button class="btn" type="button" [disabled]="processing()" (click)="retry()">{{ i18n.t('retry') }}</button>
            } @else {
              <p class="small muted"><span class="spinner"></span> {{ i18n.t('keepTabOpen') }}</p>
            }
          </section>
        } @else if (justFinished()) {
          <p class="notice notice-ai small section" role="status">{{ i18n.t('processingDone') }}</p>
        }

        @if (p.warnings.length) {
          <section class="card section">
            <h2>{{ i18n.t('processingWarnings') }}</h2>
            @for (warning of p.warnings; track warning) { <p class="small">{{ warning }}</p> }
          </section>
        }

        <section class="card section">
          <div class="faculty-row">
            <div>
              <span class="status" [class]="p.researchStatus">{{ i18n.t(statusKey(p.researchStatus)) }}</span>
              <span class="small muted">
                {{ p.researchStatus === 'published' ? i18n.t('publishedHint') : i18n.t('unpublishedHint') }}
              </span>
            </div>
            @if (!t.deleted_at) {
              @if (p.researchStatus === 'published') {
                <button class="btn btn-ghost" type="button" [disabled]="working()" (click)="run('unpublish')">{{ i18n.t('unpublishThesis') }}</button>
              } @else {
                <button class="btn" type="button" [disabled]="working() || !p.indexed" (click)="publish()">{{ i18n.t('publishThesis') }}</button>
              }
            }
          </div>

          <h3 class="small muted" style="margin-block-start: 0.9rem">{{ i18n.t('readiness') }}</h3>
          <ul class="readiness">
            <li [class]="p.chunks > 0 ? 'yes' : 'no'">{{ p.chunks > 0 ? '✓' : '…' }} {{ i18n.t('readyFullText') }}</li>
            <li [class]="p.chunks > 0 && p.vectors >= p.chunks ? 'yes' : 'no'">
              {{ p.chunks > 0 && p.vectors >= p.chunks ? '✓' : '…' }} {{ i18n.t('readySemantic') }}
              ({{ i18n.tf('vectorProgress', p.vectors, p.chunks) }})
            </li>
            <li [class]="t.has_title_vector ? 'yes' : 'no'">{{ t.has_title_vector ? '✓' : '…' }} {{ i18n.t('readyTitleVector') }}</li>
            @if (hasAbstract()) {
              <li [class]="t.has_abstract_vector ? 'yes' : 'no'">{{ t.has_abstract_vector ? '✓' : '…' }} {{ i18n.t('readyAbstractVector') }}</li>
            } @else {
              <li class="no">{{ i18n.t('readyNoAbstract') }}</li>
            }
          </ul>
          @if (!p.nextStep && !t.deleted_at && p.chunks > 0 && (p.vectors < p.chunks || !t.has_title_vector || (hasAbstract() && !t.has_abstract_vector))) {
            <div class="actions">
              <button class="btn btn-ghost btn-sm" type="button" [disabled]="working()" (click)="embedMissing()">{{ i18n.t('generateMissing') }}</button>
            </div>
          }
        </section>
      }

      @if (actionError()) { <p class="notice small section" role="alert">{{ actionError() }}</p> }

      <!-- Hidden during processing: it fills in details, and the reload when it
           finishes would discard anything typed here in the meantime. -->
      @if (!pipeline()?.nextStep || pipeline()?.failed) {
      <form class="card section" (ngSubmit)="save()">
        <div class="form-grid">
          <label><span class="small muted">{{ i18n.t('titleAr') }}</span>
            <input class="input" name="titleAr" dir="rtl" [ngModel]="form().titleAr" (ngModelChange)="set('titleAr', $event)" /></label>
          <label><span class="small muted">{{ i18n.t('titleEn') }}</span>
            <input class="input" name="titleEn" dir="ltr" [ngModel]="form().titleEn" (ngModelChange)="set('titleEn', $event)" /></label>

          <label><span class="small muted">{{ i18n.t('authors') }}</span>
            <textarea class="input" name="authors" rows="2" [ngModel]="form().authors" (ngModelChange)="set('authors', $event)"></textarea></label>
          <label><span class="small muted">{{ i18n.t('supervisors') }}</span>
            <textarea class="input" name="supervisors" rows="2" [ngModel]="form().supervisors" (ngModelChange)="set('supervisors', $event)"></textarea></label>

          <label><span class="small muted">{{ i18n.t('faculty') }}</span>
            <select class="select" name="facultyId" [ngModel]="form().facultyId" (ngModelChange)="set('facultyId', $event); set('departmentId', '')">
              <option value="">—</option>
              @for (f of faculties(); track f.id) { <option [value]="f.id">{{ f.name_ar }}</option> }
            </select></label>
          <label><span class="small muted">{{ i18n.t('department') }}</span>
            <select class="select" name="departmentId" [ngModel]="form().departmentId" (ngModelChange)="set('departmentId', $event)">
              <option value="">—</option>
              @for (d of departments(); track d.id) { <option [value]="d.id">{{ d.name_ar }}</option> }
            </select></label>

          <label><span class="small muted">{{ i18n.t('publicationYear') }}</span>
            <input class="input" type="number" name="year" min="1950" max="2100" [ngModel]="form().publicationYear" (ngModelChange)="set('publicationYear', $event)" /></label>
          <label><span class="small muted">{{ i18n.t('degreeLabel') }}</span>
            <input class="input" name="degree" [ngModel]="form().degree" (ngModelChange)="set('degree', $event)" /></label>
          <label><span class="small muted">{{ i18n.t('doiLabel') }}</span>
            <input class="input" name="doi" dir="ltr" [ngModel]="form().doi" (ngModelChange)="set('doi', $event)" /></label>

          <label><span class="small muted">{{ i18n.t('accessLevel') }}</span>
            <select class="select" name="accessLevel" [ngModel]="form().accessLevel" (ngModelChange)="set('accessLevel', $event)">
              @for (level of accessLevels; track level) { <option [value]="level">{{ i18n.t(accessKey(level)) }}</option> }
            </select></label>
          @if (form().accessLevel === 'embargoed') {
            <label><span class="small muted">{{ i18n.t('embargoUntil') }}</span>
              <input class="input" type="date" name="embargo" [ngModel]="form().embargoUntil" (ngModelChange)="set('embargoUntil', $event)" /></label>
          }

          <label class="wide"><span class="small muted">{{ i18n.t('abstractAr') }}</span>
            <textarea class="input" name="abstractAr" dir="rtl" rows="6" [ngModel]="form().abstractAr" (ngModelChange)="set('abstractAr', $event)"></textarea></label>
          <label class="wide"><span class="small muted">{{ i18n.t('abstractEn') }}</span>
            <textarea class="input" name="abstractEn" dir="ltr" rows="6" [ngModel]="form().abstractEn" (ngModelChange)="set('abstractEn', $event)"></textarea></label>

          <label><span class="small muted">{{ i18n.t('keywordsAr') }}</span>
            <textarea class="input" name="keywordsAr" dir="rtl" rows="2" [ngModel]="form().keywordsAr" (ngModelChange)="set('keywordsAr', $event)"></textarea></label>
          <label><span class="small muted">{{ i18n.t('keywordsEn') }}</span>
            <textarea class="input" name="keywordsEn" dir="ltr" rows="2" [ngModel]="form().keywordsEn" (ngModelChange)="set('keywordsEn', $event)"></textarea></label>
        </div>

        <div class="actions">
          <button class="btn" type="submit" [disabled]="working() || t.deleted_at">{{ i18n.t('save') }}</button>
          @if (savedNote()) { <span class="small" role="status">{{ savedNote() }}</span> }
        </div>
      </form>
      }

      @if (!t.deleted_at) {
        <section class="card section">
          @for (file of t.files; track file.id) {
            <p class="small"><strong><bdi>{{ file.original_filename }}</bdi></strong> · <span class="muted">{{ sizeMb(file.size_bytes) }}</span></p>
          }
          <div class="actions">
            <button class="btn btn-ghost btn-sm" type="button" (click)="openFile()">{{ i18n.t('openFile') }}</button>
            @if (pipeline()?.researchStatus === 'published') {
              <a class="btn btn-ghost btn-sm" [routerLink]="['/research', t.id]">{{ i18n.t('openPublicPage') }}</a>
            }
            <label class="btn btn-ghost btn-sm">
              {{ uploadPercent() !== null ? i18n.tf('uploadingFile', uploadPercent()) : i18n.t('replaceFile') }}
              <input type="file" accept=".pdf,.docx,.doc" hidden [disabled]="working() || processing()" (change)="replaceFile($event)" />
            </label>
            <button class="btn btn-danger btn-sm" type="button" [disabled]="working()" (click)="remove()">{{ i18n.t('deleteThesis') }}</button>
          </div>
        </section>
      }
    }
  `,
})
export class AdminThesis implements OnDestroy {
  readonly i18n = inject(I18nService);
  private readonly admin = inject(AdminService);
  private readonly router = inject(Router);
  private readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id')!;
  private left = false;

  readonly steps = STEPS;
  readonly stepLabels = STEP_LABELS;
  readonly accessLevels = ACCESS_LEVELS;

  readonly thesis = signal<ThesisDetail | null>(null);
  readonly pipeline = signal<PipelineState | null>(null);
  readonly faculties = signal<FacultyRow[]>([]);
  readonly form = signal<Form>({
    titleAr: '', titleEn: '', abstractAr: '', abstractEn: '', publicationYear: '',
    facultyId: '', departmentId: '', degree: '', doi: '', accessLevel: 'public', embargoUntil: '',
    authors: '', supervisors: '', keywordsAr: '', keywordsEn: '',
  });

  readonly loadError = signal(false);
  readonly actionError = signal('');
  readonly savedNote = signal('');
  readonly working = signal(false);
  readonly processing = signal(false);
  readonly justFinished = signal(false);
  readonly uploadPercent = signal<number | null>(null);

  readonly departments = computed(
    () => this.faculties().find((f) => f.id === this.form().facultyId)?.departments ?? [],
  );

  readonly hasAbstract = computed(() => {
    const t = this.thesis();
    return Boolean(t?.abstract_ar || t?.abstract_en);
  });

  readonly heading = computed(() => {
    const t = this.thesis();
    if (!t) return '';
    return this.i18n.title(t) || t.files[0]?.original_filename || this.i18n.t('untitled');
  });

  constructor() {
    this.admin.faculties().subscribe({ next: (rows) => this.faculties.set(rows) });
    void this.load().then(() => this.resumeProcessing());
  }

  ngOnDestroy(): void {
    this.left = true;
  }

  statusKey(status: string): StringKey {
    return `status_${status}` as StringKey;
  }

  accessKey(level: string): StringKey {
    return `access_${level}` as StringKey;
  }

  isDone(step: (typeof STEPS)[number]): boolean {
    const next = this.pipeline()?.nextStep;
    return !next || STEPS.indexOf(step) < STEPS.indexOf(next);
  }

  sizeMb(bytes: string | null): string {
    return bytes ? `${(Number(bytes) / 1024 / 1024).toFixed(1)} MB` : '';
  }

  set<K extends keyof Form>(field: K, value: Form[K]): void {
    this.form.update((form) => ({ ...form, [field]: value ?? '' }));
    this.savedNote.set('');
  }

  private async load(): Promise<void> {
    try {
      const thesis = await firstValueFrom(this.admin.thesis(this.id));
      this.thesis.set(thesis);
      this.pipeline.set(thesis.pipeline);
      this.fillForm(thesis);
    } catch {
      this.loadError.set(true);
    }
  }

  private fillForm(t: ThesisDetail): void {
    this.form.set({
      titleAr: t.title_ar ?? '',
      titleEn: t.title_en ?? '',
      abstractAr: t.abstract_ar ?? '',
      abstractEn: t.abstract_en ?? '',
      publicationYear: t.publication_year?.toString() ?? '',
      facultyId: t.faculty_id ?? '',
      departmentId: t.department_id ?? '',
      degree: t.degree ?? '',
      doi: t.doi ?? '',
      accessLevel: t.access_level,
      embargoUntil: t.embargo_until?.slice(0, 10) ?? '',
      authors: t.authors.join('\n'),
      supervisors: t.supervisors.join('\n'),
      keywordsAr: t.keywords_ar.join('، '),
      keywordsEn: t.keywords_en.join(', '),
    });
  }

  private async resumeProcessing(): Promise<void> {
    const state = this.pipeline();
    if (!state?.nextStep || state.failed || this.thesis()?.deleted_at || this.processing()) return;

    this.processing.set(true);
    this.actionError.set('');
    try {
      const final = await this.admin.process(
        this.id,
        (next) => this.pipeline.set(next),
        () => this.left,
      );
      if (final && !final.failed) this.justFinished.set(true);
      // The pipeline has filled in details, which the form now needs to show.
      if (final) await this.load();
    } catch (error) {
      this.actionError.set(errorMessage(error, this.i18n.t('loadFailed')));
    } finally {
      this.processing.set(false);
    }
  }

  async retry(): Promise<void> {
    this.pipeline.set(await firstValueFrom(this.admin.retry(this.id)));
    await this.resumeProcessing();
  }

  async embedMissing(): Promise<void> {
    this.working.set(true);
    try {
      this.pipeline.set(await firstValueFrom(this.admin.embedMissing(this.id)));
    } finally {
      this.working.set(false);
    }
    await this.resumeProcessing();
  }

  private details(): ThesisDetails {
    const f = this.form();
    return {
      titleAr: f.titleAr.trim() || null,
      titleEn: f.titleEn.trim() || null,
      abstractAr: f.abstractAr.trim() || null,
      abstractEn: f.abstractEn.trim() || null,
      publicationYear: f.publicationYear ? Number(f.publicationYear) : null,
      facultyId: f.facultyId || null,
      departmentId: f.departmentId || null,
      degree: f.degree.trim() || null,
      doi: f.doi.trim() || null,
      accessLevel: f.accessLevel,
      embargoUntil: f.accessLevel === 'embargoed' ? f.embargoUntil || null : null,
      authors: lines(f.authors),
      supervisors: lines(f.supervisors),
      keywordsAr: commaList(f.keywordsAr),
      keywordsEn: commaList(f.keywordsEn),
    };
  }

  async save(): Promise<void> {
    this.working.set(true);
    this.actionError.set('');
    this.savedNote.set('');
    try {
      const { vectorWarning } = await firstValueFrom(this.admin.update(this.id, this.details()));
      await this.load();
      this.savedNote.set(vectorWarning ? this.i18n.t('vectorWarning') : this.i18n.t('saved'));
    } catch (error) {
      this.actionError.set(errorMessage(error, this.i18n.t('authFailed')));
    } finally {
      this.working.set(false);
    }
  }

  /** Saves first, so what goes public is what is on screen. */
  async publish(): Promise<void> {
    this.working.set(true);
    this.actionError.set('');
    try {
      await firstValueFrom(this.admin.update(this.id, this.details()));
      await firstValueFrom(this.admin.action(this.id, 'publish'));
      this.justFinished.set(false);
      await this.load();
    } catch (error) {
      this.actionError.set(errorMessage(error, this.i18n.t('authFailed')));
    } finally {
      this.working.set(false);
    }
  }

  async run(action: 'unpublish' | 'restore'): Promise<void> {
    this.working.set(true);
    this.actionError.set('');
    try {
      await firstValueFrom(this.admin.action(this.id, action));
      await this.load();
    } catch (error) {
      this.actionError.set(errorMessage(error, this.i18n.t('authFailed')));
    } finally {
      this.working.set(false);
    }
  }

  async remove(): Promise<void> {
    if (!confirm(this.i18n.t('deleteThesisConfirm'))) return;
    this.left = true; // Stops any processing loop before the record disappears.
    try {
      await firstValueFrom(this.admin.remove(this.id));
      void this.router.navigate(['/admin/theses']);
    } catch (error) {
      this.left = false;
      this.actionError.set(errorMessage(error, this.i18n.t('authFailed')));
    }
  }

  async openFile(): Promise<void> {
    try {
      await this.admin.openFile(this.id);
    } catch (error) {
      this.actionError.set(errorMessage(error, this.i18n.t('loadFailed')));
    }
  }

  async replaceFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !confirm(this.i18n.t('replaceFileConfirm'))) return;

    this.working.set(true);
    this.actionError.set('');
    this.uploadPercent.set(0);
    try {
      const descriptor = await this.admin.uploadFile(file, this.id, (percent) => this.uploadPercent.set(percent));
      await firstValueFrom(this.admin.replace(this.id, descriptor));
      await this.load();
    } catch (error) {
      this.actionError.set(errorMessage(error, this.i18n.t('uploadFailed')));
      return;
    } finally {
      this.working.set(false);
      this.uploadPercent.set(null);
    }
    await this.resumeProcessing();
  }
}
