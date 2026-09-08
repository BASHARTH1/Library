import { Injectable, inject } from '@angular/core';
import type { AnswerSource } from './api.service';
import { AuthService } from './auth.service';
import { I18nService } from './i18n.service';

export interface ChatFinal {
  conversationId: string;
  messageId: string;
  answer: string;
  confidence: { level: string; score: number };
  citedPages: number[];
  invalidPages: number[];
  sources: AnswerSource[];
  retrieval: { mode: 'semantic' | 'lexical' | 'none'; papersSearched: number };
  usage: { model: string; totalTokens: number; latencyMs: number };
}

export interface ChatCallbacks {
  onSources?: (sources: AnswerSource[]) => void;
  onDelta?: (text: string) => void;
  onFinal?: (final: ChatFinal) => void;
  onError?: (error: string) => void;
  onDone?: () => void;
}

/**
 * Streams answers over Server-Sent Events.
 *
 * EventSource cannot POST, so this reads the SSE stream from a fetch() body.
 * The returned AbortController backs the "stop generation" button.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly auth = inject(AuthService);
  private readonly i18n = inject(I18nService);

  ask(
    body: { question: string; researchId?: string; conversationId?: string; generalKnowledge?: boolean },
    callbacks: ChatCallbacks,
  ): AbortController {
    const controller = new AbortController();

    void (async () => {
      try {
        // This uses raw fetch() for SSE, so Angular's HTTP interceptor never
        // runs — the token must be attached explicitly or the request 401s.
        const token = this.auth.accessToken;
        const response = await fetch('/api/chat/ask', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          // Every message here is rendered straight into the transcript, so it
          // has to be readable prose in the reader's language — never a status
          // code or an internal sentinel.
          if (response.status === 403) {
            // The only 403 a visitor can hit is the shared daily AI ceiling.
            callbacks.onError?.(this.i18n.t('aiLimitReached'));
          } else {
            callbacks.onError?.(this.i18n.t('aiUnavailable'));
          }
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            let event = 'message';
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (data === '') continue;

            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }

            switch (event) {
              case 'sources':
                callbacks.onSources?.((parsed as { sources: AnswerSource[] }).sources);
                break;
              case 'delta':
                callbacks.onDelta?.((parsed as { text: string }).text);
                break;
              case 'final':
                callbacks.onFinal?.(parsed as ChatFinal);
                break;
              case 'error':
                callbacks.onError?.((parsed as { error: string }).error);
                break;
              case 'done':
                callbacks.onDone?.();
                break;
            }
          }
        }
        callbacks.onDone?.();
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          // A dropped connection surfaces as "Failed to fetch"; show prose.
          callbacks.onError?.(this.i18n.t('aiUnavailable'));
        }
        callbacks.onDone?.();
      }
    })();

    return controller;
  }
}
