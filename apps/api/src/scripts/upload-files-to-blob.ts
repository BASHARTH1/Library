/**
 * Upload the research files to Vercel Blob and repoint the database at them.
 *
 * Locally, research_files.stored_path holds an absolute Windows path and the
 * viewer streams straight off disk. That cannot work on Vercel, so each file is
 * uploaded to a PRIVATE blob (public URLs would bypass the access-level checks
 * in spec §27) and stored_path is replaced with the returned blob URL.
 *
 * Resumable: a file whose stored_path is already a blob URL is skipped, so an
 * interrupted run can simply be repeated.
 *
 * Usage: node dist/scripts/upload-files-to-blob.js [--dry-run] [--limit N] [--concurrency N]
 */
import 'reflect-metadata';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { put } from '@vercel/blob';
import { AppModule } from '../app.module';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
// .env.local carries the Vercel-provisioned BLOB_READ_WRITE_TOKEN; .env has the
// rest. Load both, with .env.local taking precedence for overlapping keys.
loadEnv({ path: resolve(REPO_ROOT, '.env'), quiet: true });
loadEnv({ path: resolve(REPO_ROOT, '.env.local'), override: true, quiet: true });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await worker(items[i]);
      }
    }),
  );
}

interface FileRow {
  id: string;
  research_id: string;
  original_filename: string;
  stored_path: string;
  mime_type: string;
  sha256: string;
}

async function main(): Promise<void> {
  const logger = new Logger('BlobUpload');
  const dryRun = process.argv.includes('--dry-run');
  const limit = arg('limit') ? Number(arg('limit')) : Infinity;
  const concurrency = Number(arg('concurrency') ?? 4);

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    logger.error('BLOB_READ_WRITE_TOKEN missing. Run: vercel env pull .env.local --yes');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const dataSource = app.get(DataSource);

  const rows = await dataSource.query<FileRow[]>(
    `SELECT id, research_id, original_filename, stored_path, mime_type, sha256
     FROM research_files WHERE deleted_at IS NULL ORDER BY original_filename`,
  );

  const pending = rows.filter((r) => !r.stored_path.startsWith('http'));
  const already = rows.length - pending.length;
  logger.log(`${rows.length} files: ${pending.length} to upload, ${already} already on blob`);

  const missing = pending.filter((r) => !existsSync(r.stored_path));
  if (missing.length > 0) {
    logger.warn(`${missing.length} file(s) not found on disk and will be skipped:`);
    for (const m of missing.slice(0, 5)) logger.warn(`   ${m.stored_path}`);
  }

  const targets = pending.filter((r) => existsSync(r.stored_path)).slice(0, limit);
  if (dryRun) {
    let bytes = 0;
    for (const t of targets) bytes += (await stat(t.stored_path)).size;
    logger.log(`DRY RUN — would upload ${targets.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    await app.close();
    return;
  }

  let uploaded = 0;
  let failed = 0;
  let bytes = 0;

  await pool(targets, concurrency, async (file) => {
    try {
      const body = await readFile(file.stored_path);

      // Content-addressed key: the checksum dedupes identical files and keeps
      // the pathname free of the Arabic filename, which would need escaping.
      const key = `research/${file.sha256.slice(0, 16)}.pdf`;

      // Private: the URL alone must never grant access. The API reads the blob
      // server-side with the store token and streams it only to a viewer whose
      // access level permits it (spec §27).
      const blob = await put(key, body, {
        access: 'private',
        addRandomSuffix: false,
        contentType: file.mime_type,
        token: process.env.BLOB_READ_WRITE_TOKEN,
        allowOverwrite: true,
      });

      await dataSource.query(
        `UPDATE research_files SET stored_path = $2 WHERE id = $1`,
        [file.id, blob.url],
      );

      uploaded += 1;
      bytes += body.length;
      logger.log(`  [${uploaded}/${targets.length}] ${(body.length / 1024 / 1024).toFixed(1)} MB  ${file.original_filename.slice(0, 46)}`);
    } catch (error) {
      failed += 1;
      logger.error(`  FAILED ${file.original_filename.slice(0, 46)}: ${(error as Error).message.slice(0, 120)}`);
    }
  });

  const [check] = await dataSource.query<Array<{ on_blob: string; on_disk: string }>>(
    `SELECT count(*) FILTER (WHERE stored_path LIKE 'http%') AS on_blob,
            count(*) FILTER (WHERE stored_path NOT LIKE 'http%') AS on_disk
     FROM research_files WHERE deleted_at IS NULL`,
  );

  console.log('\n=== BLOB UPLOAD SUMMARY ===');
  console.log(`  uploaded      : ${uploaded}`);
  console.log(`  failed        : ${failed}`);
  console.log(`  bytes         : ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  now on blob   : ${check.on_blob}`);
  console.log(`  still on disk : ${check.on_disk}`);

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
