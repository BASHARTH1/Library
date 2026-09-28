/**
 * Upload the research files to Cloudflare R2 and repoint the database at them.
 *
 * Replaces upload-files-to-blob: the Vercel Blob store on the Hobby plan was
 * suspended once the corpus outgrew its quota. Files are read from the local
 * originals — stored_path when it is still a disk path, otherwise the path the
 * inspector recorded for the same SHA-256 in reports/folder-analysis*.json —
 * so a suspended or unreadable Blob store does not matter.
 *
 * Only canonical files are uploaded unless --all is given: the viewer serves
 * nothing else. Resumable: rows already on r2:// are skipped.
 *
 * Usage: node dist/scripts/upload-files-to-r2.js [--dry-run] [--all] [--limit N] [--concurrency N]
 */
import 'reflect-metadata';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { isR2Path, putR2Object } from '../files/r2';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
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

/** sha256 -> local path, from every inspector inventory in reports/. */
async function localOriginals(): Promise<Map<string, string>> {
  const bySha = new Map<string, string>();
  const reports = (await readdir(resolve(REPO_ROOT, 'reports'))).filter((f) => /^folder-analysis.*\.json$/.test(f));
  for (const name of reports) {
    const report = JSON.parse(await readFile(resolve(REPO_ROOT, 'reports', name), 'utf8')) as {
      files: Array<{ sha256: string; absolutePath: string }>;
    };
    for (const f of report.files) if (f.sha256 && existsSync(f.absolutePath)) bySha.set(f.sha256, f.absolutePath);
  }
  return bySha;
}

interface FileRow {
  id: string;
  original_filename: string;
  stored_path: string;
  mime_type: string;
  file_kind: string;
  sha256: string;
}

async function main(): Promise<void> {
  const logger = new Logger('R2Upload');
  const dryRun = process.argv.includes('--dry-run');
  const limit = arg('limit') ? Number(arg('limit')) : Infinity;
  const concurrency = Number(arg('concurrency') ?? 4);

  // 'log' must be enabled or this script's own progress output is swallowed.
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const dataSource = app.get(DataSource);

  const rows = await dataSource.query<FileRow[]>(
    `SELECT id, original_filename, stored_path, mime_type, file_kind, sha256
     FROM research_files WHERE deleted_at IS NULL ${process.argv.includes('--all') ? '' : 'AND is_canonical'}
     ORDER BY original_filename`,
  );
  const originals = await localOriginals();
  const sourceOf = (r: FileRow) =>
    !r.stored_path.startsWith('http') && existsSync(r.stored_path) ? r.stored_path : originals.get(r.sha256);

  const pending = rows.filter((r) => !isR2Path(r.stored_path));
  const missing = pending.filter((r) => !sourceOf(r));
  const targets = pending.filter((r) => sourceOf(r)).slice(0, limit);
  logger.log(`${rows.length} files: ${pending.length} to upload, ${rows.length - pending.length} already on R2`);
  if (missing.length > 0) {
    logger.warn(`${missing.length} file(s) have no local original and are skipped:`);
    for (const m of missing.slice(0, 10)) logger.warn(`   ${m.original_filename}`);
  }

  if (dryRun) {
    let bytes = 0;
    for (const t of targets) bytes += (await stat(sourceOf(t)!)).size;
    logger.log(`DRY RUN — would upload ${targets.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    await app.close();
    return;
  }

  let uploaded = 0;
  let failed = 0;
  let bytes = 0;
  await pool(targets, concurrency, async (file) => {
    try {
      const body = await readFile(sourceOf(file)!);
      // Content-addressed key: dedupes identical files and keeps the Arabic
      // filename (which would need escaping) out of the object key.
      const storedPath = await putR2Object(`research/${file.sha256.slice(0, 16)}.${file.file_kind}`, body, file.mime_type);
      await dataSource.query(`UPDATE research_files SET stored_path = $2 WHERE id = $1`, [file.id, storedPath]);
      uploaded += 1;
      bytes += body.length;
      logger.log(`  [${uploaded}/${targets.length}] ${(body.length / 1024 / 1024).toFixed(1)} MB  ${file.original_filename.slice(0, 46)}`);
    } catch (error) {
      failed += 1;
      logger.error(`  FAILED ${file.original_filename.slice(0, 46)}: ${(error as Error).message.slice(0, 120)}`);
    }
  });

  console.log('\n=== R2 UPLOAD SUMMARY ===');
  console.log(`  uploaded : ${uploaded}`);
  console.log(`  failed   : ${failed}`);
  console.log(`  skipped  : ${missing.length} (no local original)`);
  console.log(`  bytes    : ${(bytes / 1024 / 1024).toFixed(1)} MB`);

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
