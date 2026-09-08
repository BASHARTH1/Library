import { Injectable, inject } from '@angular/core';
import type { AnswerSource } from './api.service';
import { AuthService } from './auth.service';

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
          if (response.status === 401) {
            callbacks.onError?.('AUTH_REQUIRED');
          } else if (response.status === 403) {
            const detail = await response.json().catch(() => null);
            callbacks.onError?.(
              (detail as { message?: string })?.message ?? 'Not permitted or daily limit reached',
            );
          } else {
            callbacks.onError?.(`Request failed with status ${response.status}`);
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
          callbacks.onError?.((error as Error).message);
        }
        callbacks.onDone?.();
      }
    })();

    return controller;
  }
}
