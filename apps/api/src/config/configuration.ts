import { resolve } from 'node:path';

/**
 * Central configuration. Every value comes from the environment.
 *
 * Model names are NEVER hardcoded in services — they are read from here so they
 * can be changed without touching application code (spec §20).
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  frontendOrigin: string;
  defaultLocale: string;
  gemini: {
    apiKey: string;
    chatModel: string;
    fastModel: string;
    deepModel: string;
    embeddingModel: string;
    embeddingDimensions: number;
    maxRetries: number;
    timeoutMs: number;
  };
  database: {
    url?: string;
    host: string;
    port: number;
    name: string;
    username: string;
    password: string;
    ssl: boolean;
  };
  jwt: {
    secret: string;
    expiresIn: string;
    refreshSecret: string;
    refreshExpiresIn: string;
  };
  storage: {
    driver: string;
    path: string;
    maxUploadSizeMb: number;
  };
  ai: {
    dailyTokenLimitPerUser: number;
    maxChatHistory: number;
    maxRetrievedChunks: number;
    cacheTtlSeconds: number;
  };
  researchSourceDir: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

function num(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${name} must be a number, got "${value}"`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export default (): AppConfig => ({
  nodeEnv: optional('NODE_ENV', 'development'),
  port: num('PORT', 3000),
  frontendOrigin: optional('FRONTEND_ORIGIN', 'http://localhost:4200'),
  defaultLocale: optional('DEFAULT_LOCALE', 'ar'),
  gemini: {
    apiKey: required('GEMINI_API_KEY'),
    chatModel: optional('GEMINI_CHAT_MODEL', 'gemini-3.6-flash'),
    fastModel: optional('GEMINI_FAST_MODEL', 'gemini-3.5-flash-lite'),
    deepModel: optional('GEMINI_DEEP_MODEL', 'gemini-3.6-flash'),
    embeddingModel: optional('GEMINI_EMBEDDING_MODEL', 'gemini-embedding-001'),
    embeddingDimensions: num('GEMINI_EMBEDDING_DIMENSIONS', 1536),
    maxRetries: num('GEMINI_MAX_RETRIES', 5),
    timeoutMs: num('GEMINI_TIMEOUT_MS', 120000),
  },
  database: {
    url: process.env.DATABASE_URL?.trim() || undefined,
    host: optional('DATABASE_HOST', 'localhost'),
    port: num('DATABASE_PORT', 5432),
    name: optional('DATABASE_NAME', 'gulf_research_repository'),
    username: optional('DATABASE_USERNAME', 'postgres'),
    password: optional('DATABASE_PASSWORD', ''),
    ssl: bool('DATABASE_SSL', false),
  },
  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: optional('JWT_EXPIRES_IN', '1h'),
    refreshSecret: optional('JWT_REFRESH_SECRET', required('JWT_SECRET')),
    refreshExpiresIn: optional('JWT_REFRESH_EXPIRES_IN', '7d'),
  },
  storage: {
    driver: optional('FILE_STORAGE_DRIVER', 'local'),
    path: resolve(optional('FILE_STORAGE_PATH', './storage/research')),
    maxUploadSizeMb: num('MAX_UPLOAD_SIZE_MB', 100),
  },
  ai: {
    dailyTokenLimitPerUser: num('AI_DAILY_TOKEN_LIMIT_PER_USER', 200000),
    maxChatHistory: num('AI_MAX_CHAT_HISTORY', 20),
    maxRetrievedChunks: num('AI_MAX_RETRIEVED_CHUNKS', 12),
    cacheTtlSeconds: num('AI_CACHE_TTL_SECONDS', 86400),
  },
  researchSourceDir: optional('RESEARCH_SOURCE_DIR', ''),
});
