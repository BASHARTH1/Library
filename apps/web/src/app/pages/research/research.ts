import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import {
  ApiService,
  type AnswerSource,
  type ResearchDetail,
  type SimilarResearch,
} from '../../core/api.service';
import { ChatService, type ChatFinal } from '../../core/chat.service';
import { I18nService } from '../../core/i18n.service';

interface ChatTurn {
  question: string;
  answer: string;
  sources: AnswerSource[];
  confidence: { level: string; score: number } | null;
  citedPages: number[];
  invalidPages: number[];
  streaming: boolean;
  error: string | null;
  usage: { model: string; totalTokens: number; latencyMs: number } | null;
}

@Component({
  selector: 'app-research',
  imports: [FormsModule, RouterLink],
  templateUrl: './research.html',
  styleUrl: './research.scss',
})
export class ResearchPage {
  private readonly api = inject(ApiService);
  private readonly chat = inject(ChatService);
  private readonly route = inject(ActivatedRoute);
  private readonly sanitizer = inject(DomSanitizer);
  readonly i18n = inject(I18nService);

  readonly research = signal<ResearchDetail | null>(null);
  readonly similar = signal<SimilarResearch[]>([]);
  readonly suggestions = signal<string[]>([]);
  readonly loading = signal(true);

  readonly turns = signal<ChatTurn[]>([]);
  readonly question = signal('');
  readonly streaming = signal(false);
  readonly conversationId = signal<string | undefined>(undefined);
  readonly copiedIndex = signal<number | null>(null);
  private abort: AbortController | null = null;

  /** Current page shown in the viewer; updated when a citation is clicked. */
  readonly viewerPage = signal(1);

  readonly researchId = signal('');

  readonly viewerUrl = computed<SafeResourceUrl | null>(() => {
    const id = this.researchId();
    if (!id) return null;
    // #page= is honoured by the browser's built-in PDF viewer.
    const url = `${this.api.fileUrl(id)}#page=${this.viewerPage()}&zoom=page-width`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });

  readonly hasPdf = computed(() => this.research()?.files.some((f) => f.file_kind === 'pdf') ?? false);

  /** Corrupted Arabic glyphs come from the PDF font, not our parsing. */
  readonly showTextQualityWarning = computed(() => {
    const r = this.research();
    if (!r) return false;
    const text = `${r.abstract_ar ?? ''}${r.title_ar ?? ''}`;
    return /(?:^|[^ؠ-ي])[اأإآ][اأإآ]ل/u.test(text);
  });

  constructor() {
    this.route.paramMap.subscribe((params) => {
      const id = params.get('id');
      if (!id) return;
      this.researchId.set(id);
      this.loading.set(true);
      this.turns.set([]);
      this.conversationId.set(undefined);
      this.viewerPage.set(1);

      this.api.research(id).subscribe({
        next: (r) => { this.research.set(r); this.loading.set(false); },
        error: () => this.loading.set(false),
      });
      this.api.similar(id).subscribe({ next: (s) => this.similar.set(s) });
      this.api.suggestedQuestions(id).subscribe({
        next: (q) => this.suggestions.set(q),
        error: () => this.suggestions.set([]),
      });
    });
  }

  title(): string {
    const r = this.research();
    return r ? this.i18n.title(r) : '';
  }

  abstract(): string | null {
    const r = this.research();
    if (!r) return null;
    return this.i18n.locale() === 'ar'
      ? (r.abstract_ar ?? r.abstract_en)
      : (r.abstract_en ?? r.abstract_ar);
  }

  authorsOnly(): ResearchDetail['authors'] {
    return this.research()?.authors.filter((a) => a.role === 'author') ?? [];
  }

  supervisorsOnly(): ResearchDetail['authors'] {
    return this.research()?.authors.filter((a) => a.role === 'supervisor') ?? [];
  }

  ask(text?: string): void {
    const question = (text ?? this.question()).trim();
    if (question.length < 2 || this.streaming()) return;

    this.question.set('');
    this.streaming.set(true);

    const turn: ChatTurn = {
      question, answer: '', sources: [], confidence: null,
      citedPages: [], invalidPages: [], streaming: true, error: null, usage: null,
    };
    this.turns.update((list) => [...list, turn]);
    const index = this.turns().length - 1;

    const patch = (changes: Partial<ChatTurn>): void => {
      this.turns.update((list) => list.map((t, i) => (i === index ? { ...t, ...changes } : t)));
    };

    this.abort = this.chat.ask(
      {
        question,
        researchId: this.researchId(),
        conversationId: this.conversationId(),
      },
      {
        onSources: (sources) => patch({ sources }),
        onDelta: (delta) => {
          this.turns.update((list) =>
            list.map((t, i) => (i === index ? { ...t, answer: t.answer + delta } : t)));
        },
        onFinal: (final: ChatFinal) => {
          this.conversationId.set(final.conversationId);
          patch({
            answer: final.answer,
            sources: final.sources,
            confidence: final.confidence,
            citedPages: final.citedPages,
            invalidPages: final.invalidPages,
            usage: final.usage,
          });
        },
        onError: (error) => patch({ error }),
        onDone: () => {
          patch({ streaming: false });
          this.streaming.set(false);
          this.abort = null;
        },
      },
    );
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.streaming.set(false);
  }

  regenerate(turn: ChatTurn): void {
    this.ask(turn.question);
  }

  copy(text: string, index: number): void {
    void navigator.clipboard.writeText(text).then(() => {
      this.copiedIndex.set(index);
      setTimeout(() => this.copiedIndex.set(null), 1600);
    });
  }

  openPage(page: number): void {
    this.viewerPage.set(page);
    document.querySelector('.viewer-frame')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  confidenceLabel(level: string): string {
    switch (level) {
      case 'high': return this.i18n.t('high');
      case 'medium': return this.i18n.t('medium');
      case 'low': return this.i18n.t('low');
      default: return this.i18n.t('none');
    }
  }

  similarTitle(item: SimilarResearch): string {
    return this.i18n.title(item);
  }
}
