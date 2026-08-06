/**
 * Backfill embeddings for any chunk that does not yet have a vector.
 *
 * Safe to run repeatedly. Stops cleanly when the daily Gemini quota is reached
 * and reports exactly how much work remains.
 */
import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { IngestService } from '../ingest/ingest.service';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
loadEnv({ path: resolve(REPO_ROOT, '.env'), quiet: true });

async function main(): Promise<void> {
  const logger = new Logger('EmbedPending');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const ingest = app.get(IngestService);
  const dataSource = app.get(DataSource);

  const model = process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-001';

  const targets = await dataSource.query<Array<{ id: string; title: string; pending: string }>>(
    `SELECT r.id,
            left(COALESCE(r.title_ar, r.title_en), 45) AS title,
            count(c.id) FILTER (
              WHERE NOT EXISTS (SELECT 1 FROM research_embeddings e WHERE e.chunk_id = c.id AND e.model = $1)
            ) AS pending
     FROM research r
     JOIN research_chunks c ON c.research_id = r.id
     WHERE r.deleted_at IS NULL
     GROUP BY r.id, r.title_ar, r.title_en
     HAVING count(c.id) FILTER (
       WHERE NOT EXISTS (SELECT 1 FROM research_embeddings e WHERE e.chunk_id = c.id AND e.model = $1)
     ) > 0
     ORDER BY pending`,
    [model],
  );

  const totalPending = targets.reduce((sum, t) => sum + Number(t.pending), 0);
  logger.log(`${targets.length} research records with ${totalPending} chunks awaiting vectors`);

  let embedded = 0;
  let stopped = false;

  for (const [i, target] of targets.entries()) {
    if (stopped) break;
    try {
      const result = await ingest.embedResearch(target.id);
      embedded += result.embedded;
      logger.log(`[${i + 1}/${targets.length}] +${result.embedded} vectors — ${target.title}`);
    } catch (error) {
      const message = (error as Error).message;
      if (/quota/i.test(message)) {
        logger.warn(`Daily quota reached after ${embedded} vectors. Re-run after it resets.`);
        stopped = true;
      } else {
        logger.error(`Failed on ${target.title}: ${message.slice(0, 140)}`);
      }
    }
  }

  const [remaining] = await dataSource.query<Array<{ n: string }>>(
    `SELECT count(*) AS n FROM research_chunks c
     WHERE NOT EXISTS (SELECT 1 FROM research_embeddings e WHERE e.chunk_id = c.id AND e.model = $1)`,
    [model],
  );

  console.log(`\nvectors written this run : ${embedded}`);
  console.log(`chunks still pending     : ${remaining.n}`);

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
