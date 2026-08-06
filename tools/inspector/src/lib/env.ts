import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root = three levels up from tools/inspector/src/lib. */
export const REPO_ROOT = resolve(here, '..', '..', '..', '..');

config({ path: resolve(REPO_ROOT, '.env'), quiet: true });

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

export const env = {
  repoRoot: REPO_ROOT,
  get geminiApiKey(): string {
    return required('GEMINI_API_KEY');
  },
  geminiChatModel: optional('GEMINI_CHAT_MODEL', 'gemini-2.5-pro'),
  geminiFastModel: optional('GEMINI_FAST_MODEL', 'gemini-2.5-flash'),
  geminiEmbeddingModel: optional('GEMINI_EMBEDDING_MODEL', 'gemini-embedding-001'),
  geminiMaxRetries: Number(optional('GEMINI_MAX_RETRIES', '5')),
  geminiTimeoutMs: Number(optional('GEMINI_TIMEOUT_MS', '120000')),
  get sourceDir(): string {
    const dir = required('RESEARCH_SOURCE_DIR');
    if (!existsSync(dir)) {
      throw new Error(`RESEARCH_SOURCE_DIR does not exist: ${dir}`);
    }
    return dir;
  },
  reportsDir: resolve(REPO_ROOT, 'reports'),
};
