import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

/**
 * Cloudflare R2 holds the research files in production. research_files.stored_path
 * stores `r2://<key>`; the bucket is private and a file is only ever streamed
 * by the API after its access check (spec §27), never linked to directly.
 */
export const R2_SCHEME = 'r2://';

let client: S3Client | null = null;

function r2(): S3Client {
  if (client) return client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 is not configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY');
  }
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

function bucket(): string {
  return process.env.R2_BUCKET ?? 'gulf-research-files';
}

export function isR2Path(storedPath: string): boolean {
  return storedPath.startsWith(R2_SCHEME);
}

export async function putR2Object(key: string, body: Buffer, contentType: string): Promise<string> {
  await r2().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }));
  return `${R2_SCHEME}${key}`;
}

export async function getR2Object(storedPath: string): Promise<{ stream: Readable; length: number | undefined } | null> {
  try {
    const result = await r2().send(
      new GetObjectCommand({ Bucket: bucket(), Key: storedPath.slice(R2_SCHEME.length) }),
    );
    if (!result.Body) return null;
    return { stream: result.Body as Readable, length: result.ContentLength };
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchKey') return null;
    throw error;
  }
}
