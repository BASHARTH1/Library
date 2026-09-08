import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, type AnswerSource, type Stats } from '../../core/api.service';
import { ChatService, type ChatFinal } from '../../core/chat.service';
import { I18nService } from '../../core/i18n.service';
import { AuthService } from '../../core/auth.service';

export type AssistantMode = 'find' | 'ask';

interface FoundPaper {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  faculty: string | null;
  pages: number | null;
  relevance: string;
  score: number;
  matchedPage: number | null;
}

interface FindResponse {
  interpretation: string;
  papers: FoundPaper[];
  totalFound: number;
  relaxed: boolean;
  latencyMs: number;
}

interface AskTurn {
  question: string;
  answer: string;
  sources: AnswerSource[];
  confidence: { level: string; score: number } | null;
  invalidPages: number[];
  streaming: boolean;
  error: string | null;
  retrieval: { mode: 'semantic' | 'lexical' | 'none'; papersSearched: number } | null;
  usage: { model: string; totalTokens: number; latencyMs: number } | null;
}

/** Sources grouped by paper, so the reader sees which PDFs an answer came from. */
interface SourcePaper {
  researchId: string;
  title: string;
  authors: string[];
  year: number | null;
  pages: number[];
  cited: boolean;
  excerpts: Array<{ page: number; text: string; section: string | null }>;
}

@Component({
  selector: 'app-assistant',
  imports: [FormsModule, RouterLink],
  templateUrl: './assistant.html',
  styleUrl: './assistant.scss',
})
export class AssistantPage {
  private readonly api = inject(ApiService);
  private readonly chat = inject(ChatService);
  readonly i18n = inject(I18nService);
  readonly auth = inject(AuthService);

  readonly mode = signal<AssistantMode>('ask');
  readonly query = signal('');
  readonly busy = signal(false);
  readonly stats = signal<Stats | null>(null);

  readonly findResult = signal<FindResponse | null>(null);
  readonly turns = signal<AskTurn[]>([]);
  readonly conversationId = signal<string | undefined>(undefined);
  readonly copiedIndex = signal<number | null>(null);
  private abort: AbortController | null = null;

  readonly semanticPartial = computed(() => {
    const s = this.stats();
    return s !== null && s.semantic_ready_count < s.research_count;
  });

  readonly examples = computed(() =>
    this.i18n.locale() === 'ar'
      ? [
          'ما هو الذكاء الاصطناعي؟',
          'ما الدراسات التي تناولت التحول الرقمي؟',
          'ما المناهج البحثية الأكثر استخدامًا في هذه البحوث؟',
          'قارن بين الدراسات التي تناولت أداء الموظفين',
        ]
      : [
          'What is artificial intelligence?',
          'Which studies discuss digital transformation?',
          'What research methods are most used across these theses?',
          'Compare the studies on employee performance',
        ],
  );

  constructor() {
    this.api.stats().subscribe({ next: (s) => this.stats.set(s) });
  }

  setMode(mode: AssistantMode): void {
    this.mode.set(mode);
  }

  submit(text?: string): void {
    const value = (text ?? this.query()).trim();
    if (value.length < 2 || this.busy()) return;
    if (this.mode() === 'find') this.runFind(value);
    else this.runAsk(value);
  }

  private runFind(query: string): void {
    this.busy.set(true);
    this.findResult.set(null);
    this.api.find(query).subscribe({
      next: (r) => { this.findResult.set(r as FindResponse); this.busy.set(false); },
      error: () => this.busy.set(false),
    });
  }

  private runAsk(question: string): void {
    this.query.set('');
    this.busy.set(true);

    const turn: AskTurn = {
      question, answer: '', sources: [], confidence: null,
      invalidPages: [], streaming: true, error: null, retrieval: null, usage: null,
    };
    this.turns.update((list) => [...list, turn]);
    const index = this.turns().length - 1;

    const patch = (changes: Partial<AskTurn>): void => {
      this.turns.update((list) => list.map((t, i) => (i === index ? { ...t, ...changes } : t)));
    };

    // No researchId => the repository-wide assistant.
    this.abort = this.chat.ask(
      { question, conversationId: this.conversationId() },
      {
        onSources: (sources) => patch({ sources }),
        onDelta: (delta) => this.turns.update((list) =>
          list.map((t, i) => (i === index ? { ...t, answer: t.answer + delta } : t))),
        onFinal: (final: ChatFinal) => {
          this.conversationId.set(final.conversationId);
          patch({
            answer: final.answer,
            sources: final.sources,
            confidence: final.confidence,
            invalidPages: final.invalidPages,
            retrieval: final.retrieval,
            usage: final.usage,
          });
        },
        onError: (error) => patch({ error }),
        onDone: () => { patch({ streaming: false }); this.busy.set(false); this.abort = null; },
      },
    );
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.busy.set(false);
  }

  /** Collapse chunk-level sources into one entry per paper. */
  papersFor(turn: AskTurn): SourcePaper[] {
    const byResearch = new Map<string, SourcePaper>();
    for (const source of turn.sources) {
      const existing = byResearch.get(source.researchId);
      if (existing) {
        if (!existing.pages.includes(source.pageNumber)) existing.pages.push(source.pageNumber);
        existing.cited = existing.cited || source.wasCited;
        existing.excerpts.push({ page: source.pageNumber, text: source.excerpt, section: source.sectionName });
      } else {
        byResearch.set(source.researchId, {
          researchId: source.researchId,
          title: source.researchTitle,
          authors: source.authors ?? [],
          year: source.publicationYear ?? null,
          pages: [source.pageNumber],
          cited: source.wasCited,
          excerpts: [{ page: source.pageNumber, text: source.excerpt, section: source.sectionName }],
        });
      }
    }
    // Papers the answer actually drew on come first.
    return [...byResearch.values()]
      .map((p) => ({ ...p, pages: p.pages.sort((a, b) => a - b) }))
      .sort((a, b) => Number(b.cited) - Number(a.cited));
  }

  copy(text: string, index: number): void {
    void navigator.clipboard.writeText(text).then(() => {
      this.copiedIndex.set(index);
      setTimeout(() => this.copiedIndex.set(null), 1600);
    });
  }

  confidenceLabel(level: string): string {
    switch (level) {
      case 'high': return this.i18n.t('high');
      case 'medium': return this.i18n.t('medium');
      case 'low': return this.i18n.t('low');
      default: return this.i18n.t('none');
    }
  }
}
