/** Shared types for all Gemini interactions. */

export type ModelTier = 'fast' | 'chat' | 'deep';

export interface GeminiUsage {
  model: string;
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
  latencyMs: number;
  cacheHit: boolean;
}

export interface GenerateOptions {
  /** Which configured model tier to use. Never a hardcoded model name. */
  tier?: ModelTier;
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** JSON schema for structured output. When set, responseMimeType is JSON. */
  responseSchema?: Record<string, unknown>;
  /** Skip the response cache for this call. */
  noCache?: boolean;
  /** Aborts an in-flight request (e.g. the user pressed "stop generation"). */
  signal?: AbortSignal;
}

export interface GenerateResult<T = string> {
  data: T;
  raw: string;
  usage: GeminiUsage;
  finishReason: string | null;
}

export interface StreamChunk {
  type: 'text' | 'usage' | 'error' | 'done';
  text?: string;
  usage?: GeminiUsage;
  error?: string;
}

/**
 * A retrieved passage handed to the model as grounding context.
 * Every field here must survive into the citation shown to the user.
 */
export interface GroundingChunk {
  chunkId: string;
  researchId: string;
  researchTitle: string;
  pageNumber: number;
  sectionName: string | null;
  text: string;
  similarity: number;
  /** Carried through so repository-wide answers can attribute each claim. */
  authors?: string[];
  publicationYear?: number | null;
  facultyName?: string | null;
  /** How this chunk was found — reported to the user per answer. */
  retrieval?: 'semantic' | 'lexical';
}

export class GeminiUnavailableError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'GeminiUnavailableError';
  }
}

export class GeminiQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiQuotaExceededError';
  }
}
