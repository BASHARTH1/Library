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

function cliArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

/**
 * Report filename for the current batch. The first corpus uses the bare names
 * (folder-analysis.json); a later delivery passed as `--batch <name>` gets its
 * own set (folder-analysis-<name>.json) so it never overwrites the first.
 */
export function reportName(base: string, extension: 'json' | 'xlsx'): string {
  const batch = cliArg('batch');
  return resolve(REPO_ROOT, 'reports', batch ? `${base}-${batch}.${extension}` : `${base}.${extension}`);
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
    // `--source <dir>` inspects another delivery without editing .env.
    const dir = cliArg('source') ?? required('RESEARCH_SOURCE_DIR');
    if (!existsSync(dir)) {
      throw new Error(`RESEARCH_SOURCE_DIR does not exist: ${dir}`);
    }
    return dir;
  },
  reportsDir: resolve(REPO_ROOT, 'reports'),
};
