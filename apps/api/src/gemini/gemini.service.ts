import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import type { AppConfig } from '../config/configuration';
import {
  GeminiQuotaExceededError,
  GeminiUnavailableError,
  type GenerateOptions,
  type GenerateResult,
  type GeminiUsage,
  type ModelTier,
  type StreamChunk,
} from './gemini.types';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * The ONLY place in the application that talks to the Gemini API.
 *
 * Responsibilities (spec §20): model-tier resolution from env, response and
 * embedding caching, duplicate-prompt detection, token accounting, retry with
 * exponential backoff, timeout handling, and model fallback.
 */
@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly client: GoogleGenAI;
  private readonly config: AppConfig['gemini'];
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  /** In-flight de-duplication: identical concurrent prompts share one request. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    this.config = this.configService.get('gemini', { infer: true });
    this.cacheTtlMs = this.configService.get('ai', { infer: true }).cacheTtlSeconds * 1000;
    this.client = new GoogleGenAI({ apiKey: this.config.apiKey });
  }

  /** Resolve a tier to a concrete model name. Never hardcoded at call sites. */
  resolveModel(tier: ModelTier = 'fast'): string {
    switch (tier) {
      case 'deep':
        return this.config.deepModel;
      case 'chat':
        return this.config.chatModel;
      default:
        return this.config.fastModel;
    }
  }

  /** Ordered fallback chain: if the preferred tier is unavailable, step down. */
  private fallbackChain(tier: ModelTier): string[] {
    const chain =
      tier === 'deep'
        ? [this.config.deepModel, this.config.chatModel, this.config.fastModel]
        : tier === 'chat'
          ? [this.config.chatModel, this.config.fastModel]
          : [this.config.fastModel];
    return [...new Set(chain)];
  }

  private cacheKey(parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }

  private readCache<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  private writeCache(key: string, value: unknown): void {
    this.cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs });
    // Bound memory: evict oldest entries beyond a soft cap.
    if (this.cache.size > 2000) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt).slice(0, 400);
      for (const [k] of oldest) this.cache.delete(k);
    }
  }

  private static statusFrom(error: unknown): number | null {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/"code":\s*(\d+)/) ?? message.match(/\[(\d{3})\]/);
    return match ? Number(match[1]) : null;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Non-streaming generation with retry, backoff and model fallback.
   * Returns parsed JSON when a responseSchema is supplied.
   */
  async generate<T = string>(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult<T>> {
    const tier = options.tier ?? 'fast';
    const key = this.cacheKey([
      'generate',
      tier,
      prompt,
      options.systemInstruction ?? '',
      options.responseSchema ?? null,
      options.temperature ?? 0,
    ]);

    if (!options.noCache) {
      const cached = this.readCache<GenerateResult<T>>(key);
      if (cached) {
        return { ...cached, usage: { ...cached.usage, cacheHit: true, latencyMs: 0 } };
      }
      const pending = this.inflight.get(key);
      if (pending) return (await pending) as GenerateResult<T>;
    }

    const run = this.generateUncached<T>(prompt, options, tier);
    if (!options.noCache) this.inflight.set(key, run as Promise<unknown>);

    try {
      const result = await run;
      if (!options.noCache) this.writeCache(key, result);
      return result;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async generateUncached<T>(
    prompt: string,
    options: GenerateOptions,
    tier: ModelTier,
  ): Promise<GenerateResult<T>> {
    const models = this.fallbackChain(tier);
    let lastError: unknown = null;
    let lastStatus: number | null = null;
    let attempts = 0;

    for (const model of models) {
      for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
        attempts += 1;
        const started = Date.now();
        try {
          const response = await this.client.models.generateContent({
            model,
            contents: prompt,
            config: {
              ...(options.systemInstruction ? { systemInstruction: options.systemInstruction } : {}),
              ...(options.responseSchema
                ? { responseMimeType: 'application/json', responseSchema: options.responseSchema }
                : {}),
              temperature: options.temperature ?? 0,
              maxOutputTokens: options.maxOutputTokens ?? 8192,
              abortSignal: options.signal ?? AbortSignal.timeout(this.config.timeoutMs),
            },
          });

          const raw = response.text ?? '';
          if (raw.trim() === '') throw new Error('Empty response body from Gemini');

          const usage: GeminiUsage = {
            model,
            promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
            responseTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
            totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
            latencyMs: Date.now() - started,
            cacheHit: false,
          };

          const data = (options.responseSchema ? (JSON.parse(raw) as T) : (raw as unknown as T));
          return {
            data,
            raw,
            usage,
            finishReason: response.candidates?.[0]?.finishReason ?? null,
          };
        } catch (error) {
          lastError = error;
          lastStatus = GeminiService.statusFrom(error);
          const message = error instanceof Error ? error.message : String(error);
          const retryable = (lastStatus !== null && RETRYABLE_STATUS.has(lastStatus)) || /timeout|ECONNRESET|fetch failed|socket|network/i.test(message);

          if (!retryable) break; // move to the next model in the fallback chain

          if (attempt < this.config.maxRetries) {
            const delay = Math.min(32000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
            this.logger.warn(`Gemini ${model} attempt ${attempt} failed (${lastStatus ?? 'net'}); retrying in ${delay}ms`);
            await GeminiService.sleep(delay);
          }
        }
      }
      this.logger.warn(`Model ${model} exhausted; trying fallback`);
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    if (lastStatus === 429) {
      throw new GeminiQuotaExceededError(`Gemini quota exceeded across all configured models: ${message.slice(0, 300)}`);
    }
    throw new GeminiUnavailableError(`Gemini unavailable: ${message.slice(0, 300)}`, lastStatus, attempts);
  }

  /**
   * Multimodal generation from an image (used by the OCR stage).
   *
   * Shares the same retry, backoff and model-fallback behaviour as text
   * generation. Images are NOT cached — an OCR pass runs once per page and
   * caching base64 page renders would bloat memory for no benefit.
   */
  async generateFromImage(
    image: Buffer,
    mimeType: string,
    prompt: string,
    options: GenerateOptions = {},
  ): Promise<GenerateResult<string>> {
    const models = this.fallbackChain(options.tier ?? 'fast');
    let lastError: unknown = null;
    let lastStatus: number | null = null;
    let attempts = 0;

    const contents = [
      {
        role: 'user' as const,
        parts: [
          { inlineData: { mimeType, data: image.toString('base64') } },
          { text: prompt },
        ],
      },
    ];

    for (const model of models) {
      for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
        attempts += 1;
        const started = Date.now();
        try {
          const response = await this.client.models.generateContent({
            model,
            contents,
            config: {
              ...(options.systemInstruction ? { systemInstruction: options.systemInstruction } : {}),
              temperature: options.temperature ?? 0,
              maxOutputTokens: options.maxOutputTokens ?? 8192,
              abortSignal: options.signal ?? AbortSignal.timeout(this.config.timeoutMs),
            },
          });

          const raw = response.text ?? '';
          return {
            data: raw,
            raw,
            usage: {
              model,
              promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
              responseTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
              totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
              latencyMs: Date.now() - started,
              cacheHit: false,
            },
            finishReason: response.candidates?.[0]?.finishReason ?? null,
          };
        } catch (error) {
          lastError = error;
          lastStatus = GeminiService.statusFrom(error);
          const message = error instanceof Error ? error.message : String(error);
          const retryable =
            (lastStatus !== null && RETRYABLE_STATUS.has(lastStatus)) ||
            /timeout|ECONNRESET|fetch failed|socket|network/i.test(message);
          if (!retryable) break;
          if (attempt < this.config.maxRetries) {
            const delay = Math.min(32000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
            await GeminiService.sleep(delay);
          }
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    if (lastStatus === 429) {
      throw new GeminiQuotaExceededError(`Gemini quota exceeded during OCR: ${message.slice(0, 300)}`);
    }
    throw new GeminiUnavailableError(`Gemini vision unavailable: ${message.slice(0, 300)}`, lastStatus, attempts);
  }

  /**
   * Streaming generation for chat (spec §21). Yields text deltas as they arrive
   * so the UI never waits for the full response.
   */
  async *generateStream(prompt: string, options: GenerateOptions = {}): AsyncGenerator<StreamChunk> {
    const models = this.fallbackChain(options.tier ?? 'chat');
    let lastError: unknown = null;

    for (const model of models) {
      const started = Date.now();
      try {
        const stream = await this.client.models.generateContentStream({
          model,
          contents: prompt,
          config: {
            ...(options.systemInstruction ? { systemInstruction: options.systemInstruction } : {}),
            temperature: options.temperature ?? 0.2,
            maxOutputTokens: options.maxOutputTokens ?? 8192,
            abortSignal: options.signal ?? AbortSignal.timeout(this.config.timeoutMs),
          },
        });

        let promptTokens = 0;
        let responseTokens = 0;
        let totalTokens = 0;

        for await (const part of stream) {
          if (options.signal?.aborted) break;
          const text = part.text;
          if (text) yield { type: 'text', text };
          if (part.usageMetadata) {
            promptTokens = part.usageMetadata.promptTokenCount ?? promptTokens;
            responseTokens = part.usageMetadata.candidatesTokenCount ?? responseTokens;
            totalTokens = part.usageMetadata.totalTokenCount ?? totalTokens;
          }
        }

        yield {
          type: 'usage',
          usage: { model, promptTokens, responseTokens, totalTokens, latencyMs: Date.now() - started, cacheHit: false },
        };
        yield { type: 'done' };
        return;
      } catch (error) {
        lastError = error;
        const status = GeminiService.statusFrom(error);
        this.logger.warn(`Streaming failed on ${model} (${status ?? 'net'}); trying fallback`);
      }
    }

    yield {
      type: 'error',
      error: lastError instanceof Error ? lastError.message.slice(0, 300) : 'Gemini streaming failed',
    };
  }

  /**
   * Sliding-window rate limiter for the embedding endpoint.
   *
   * The Gemini free tier enforces both requests-per-minute and tokens-per-minute
   * on embeddings. Without this, a large ingest burns through the minute budget
   * in seconds and every subsequent batch fails with HTTP 429.
   */
  private readonly embedWindow: Array<{ at: number; tokens: number }> = [];

  private async throttleEmbedding(tokens: number): Promise<void> {
    const rpm = Number(process.env.GEMINI_EMBED_RPM ?? 90);
    const tpm = Number(process.env.GEMINI_EMBED_TPM ?? 25000);

    for (;;) {
      const cutoff = Date.now() - 60_000;
      while (this.embedWindow.length > 0 && this.embedWindow[0].at < cutoff) this.embedWindow.shift();

      const usedTokens = this.embedWindow.reduce((sum, e) => sum + e.tokens, 0);
      const usedRequests = this.embedWindow.length;
      if (usedRequests + 1 <= rpm && usedTokens + tokens <= tpm) break;

      // Wait until the oldest entry leaves the window.
      const waitMs = Math.max(500, this.embedWindow[0].at + 60_000 - Date.now() + 250);
      this.logger.log(`Embedding rate limit reached (${usedRequests} req, ${usedTokens} tok in window); waiting ${Math.round(waitMs / 1000)}s`);
      await GeminiService.sleep(waitMs);
    }

    this.embedWindow.push({ at: Date.now(), tokens });
  }

  /** Rough token estimate matching the chunker's calibration. */
  private static estimateTokens(text: string): number {
    const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
    return Math.ceil(arabic / 2.2 + (text.length - arabic) / 4);
  }

  /**
   * Embed a batch of texts. Empty/whitespace input is rejected rather than
   * silently embedded (spec §4: never embed empty text or boilerplate).
   */
  async embed(texts: string[], taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' = 'RETRIEVAL_DOCUMENT'): Promise<number[][]> {
    const cleaned = texts.map((t) => t.trim());
    const emptyIndex = cleaned.findIndex((t) => t.length === 0);
    if (emptyIndex !== -1) {
      throw new Error(`Refusing to embed empty text at index ${emptyIndex}`);
    }

    const results: number[][] = new Array(cleaned.length);
    const uncachedIndexes: number[] = [];

    for (let i = 0; i < cleaned.length; i += 1) {
      const key = this.cacheKey(['embed', this.config.embeddingModel, taskType, cleaned[i]]);
      const cached = this.readCache<number[]>(key);
      if (cached) results[i] = cached;
      else uncachedIndexes.push(i);
    }
    if (uncachedIndexes.length === 0) return results;

    // The API accepts batches; keep them modest so one failure costs little
    // and so a single batch cannot blow the per-minute token budget.
    const BATCH = Number(process.env.GEMINI_EMBED_BATCH ?? 16);
    for (let offset = 0; offset < uncachedIndexes.length; offset += BATCH) {
      const slice = uncachedIndexes.slice(offset, offset + BATCH);
      const contents = slice.map((i) => cleaned[i]);
      const batchTokens = contents.reduce((sum, t) => sum + GeminiService.estimateTokens(t), 0);

      let embedded: number[][] | null = null;
      for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
        await this.throttleEmbedding(batchTokens);
        try {
          const response = await this.client.models.embedContent({
            model: this.config.embeddingModel,
            contents,
            config: { outputDimensionality: this.config.embeddingDimensions, taskType },
          });
          const vectors = (response.embeddings ?? []).map((e) => e.values ?? []);
          if (vectors.length !== contents.length) {
            throw new Error(`Expected ${contents.length} embeddings, received ${vectors.length}`);
          }
          embedded = vectors;
          break;
        } catch (error) {
          const status = GeminiService.statusFrom(error);
          const message = error instanceof Error ? error.message : String(error);
          // A per-DAY quota cannot be waited out inside a run. Fail fast with a
          // clear message rather than burning retries on a limit that resets at
          // midnight Pacific.
          if (/PerDay|RequestsPerDay|_free_tier_requests/i.test(message) && status === 429) {
            const limit = message.match(/"quotaValue":\s*"(\d+)"/)?.[1] ?? 'unknown';
            throw new GeminiQuotaExceededError(
              `Daily embedding quota exhausted (limit ${limit}/day on the free tier). ` +
                `Each text counts as one request, so batching does not help. ` +
                `Enable billing on the Google Cloud project, or resume after the quota resets.`,
            );
          }

          const retryable = (status !== null && RETRYABLE_STATUS.has(status)) || /timeout|fetch failed|socket/i.test(message);
          if (!retryable || attempt === this.config.maxRetries) {
            throw new GeminiUnavailableError(`Embedding failed: ${message.slice(0, 300)}`, status, attempt);
          }
          // A 429 means the minute budget is spent; wait out the window rather
          // than retrying inside it. Other errors use standard exponential backoff.
          const delay =
            status === 429
              ? 62_000
              : Math.min(32_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
          this.logger.warn(`Embedding attempt ${attempt} failed (${status ?? 'net'}); retrying in ${Math.round(delay / 1000)}s`);
          await GeminiService.sleep(delay);
        }
      }

      embedded!.forEach((vector, j) => {
        const targetIndex = slice[j];
        results[targetIndex] = vector;
        this.writeCache(this.cacheKey(['embed', this.config.embeddingModel, taskType, cleaned[targetIndex]]), vector);
      });
    }

    return results;
  }

  async embedOne(text: string, taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' = 'RETRIEVAL_QUERY'): Promise<number[]> {
    const [vector] = await this.embed([text], taskType);
    return vector;
  }

  get embeddingDimensions(): number {
    return this.config.embeddingDimensions;
  }
}
