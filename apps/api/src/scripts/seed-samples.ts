/**
 * Seed the five phase-1 sample papers into the database.
 *
 * Reads the validated metadata from reports/sample-extraction.json, then runs
 * the real ingestion pipeline (parse → sections → chunks → embeddings).
 * Safe to re-run: an already-ingested file is replaced, not duplicated.
 */
import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module';
import { IngestService, type IngestInput } from '../ingest/ingest.service';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
loadEnv({ path: resolve(REPO_ROOT, '.env'), quiet: true });

interface Field<T> { value: T | null }
interface SampleResult {
  originalFilename: string;
  relativePath: string;
  metadata: Record<string, Field<unknown>>;
}

function val<T>(metadata: Record<string, Field<unknown>>, key: string): T | null {
  const field = metadata[key];
  return field ? ((field.value as T) ?? null) : null;
}

function list(metadata: Record<string, Field<unknown>>, key: string): string[] {
  const value = val<unknown>(metadata, key);
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.trim().length > 0);
  if (typeof value === 'string' && value.trim().length > 0) return [value];
  return [];
}

async function main(): Promise<void> {
  const logger = new Logger('Seed');
  const sourceDir = process.env.RESEARCH_SOURCE_DIR;
  if (!sourceDir) throw new Error('RESEARCH_SOURCE_DIR is not set');

  const raw = await readFile(resolve(REPO_ROOT, 'reports', 'sample-extraction.json'), 'utf8');
  const { results } = JSON.parse(raw) as { results: SampleResult[] };
  logger.log(`Loaded ${results.length} analyzed papers`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const ingest = app.get(IngestService);

  const summary: Array<Record<string, unknown>> = [];

  for (const result of results) {
    const absolutePath = resolve(sourceDir, result.relativePath);
    const facultyFolder = result.relativePath.split(/[\\/]/)[0] ?? null;

    const input: IngestInput = {
      absolutePath,
      facultyNameAr: facultyFolder,
      accessLevel: 'public',
      metadata: {
        titleAr: val<string>(result.metadata, 'titleAr'),
        titleEn: val<string>(result.metadata, 'titleEn'),
        authors: list(result.metadata, 'authors'),
        supervisors: list(result.metadata, 'supervisors'),
        abstractAr: val<string>(result.metadata, 'abstractAr'),
        abstractEn: val<string>(result.metadata, 'abstractEn'),
        keywordsAr: list(result.metadata, 'keywordsAr'),
        keywordsEn: list(result.metadata, 'keywordsEn'),
        publicationYear: val<number>(result.metadata, 'publicationYear'),
        faculty: val<string>(result.metadata, 'faculty'),
        department: val<string>(result.metadata, 'department'),
        degree: val<string>(result.metadata, 'degree'),
        researchType: val<string>(result.metadata, 'researchType'),
        publicationType: val<string>(result.metadata, 'publicationType'),
        doi: val<string>(result.metadata, 'doi'),
      },
    };

    try {
      // Resumable: skip files already ingested with a complete embedding set,
      // so a re-run after a quota interruption only does the missing papers.
      if (await ingest.isFullyIngested(absolutePath)) {
        logger.log(`SKIP (already ingested) — ${result.originalFilename.slice(0, 60)}`);
        summary.push({ title: result.originalFilename.slice(0, 50), status: 'skipped' });
        continue;
      }

      const started = Date.now();
      const outcome = await ingest.ingestFile(input);
      summary.push({ ...outcome, seconds: Math.round((Date.now() - started) / 1000) });
      logger.log(
        `OK  ${outcome.chunks} chunks, ${outcome.embedded} embedded, ${outcome.sections} sections — ${result.originalFilename.slice(0, 50)}`,
      );
    } catch (error) {
      logger.error(`FAILED ${result.originalFilename}: ${(error as Error).message}`);
      summary.push({ title: result.originalFilename, error: (error as Error).message });
    }
  }

  console.table(summary);
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
