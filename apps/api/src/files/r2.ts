import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
    // The SDK otherwise signs a CRC32 checksum into presigned URLs, which the
    // browser cannot supply, so the upload is rejected.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

function bucket(): string {
  return process.env.R2_BUCKET ?? 'gulf-research-files';
}

export function isR2Configured(): boolean {
  return Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

export function isR2Path(storedPath: string): boolean {
  return storedPath.startsWith(R2_SCHEME);
}

export async function putR2Object(key: string, body: Buffer, contentType: string): Promise<string> {
  await r2().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }));
  return `${R2_SCHEME}${key}`;
}

/**
 * A short-lived URL the browser can PUT one file to directly. Theses are far
 * larger than the 4.5 MB a Vercel Function accepts as a request body, so they
 * cannot pass through the API. Needs a CORS rule on the bucket (scripts/r2-cors).
 */
export async function presignR2Put(key: string, contentType: string, expiresInSeconds = 900): Promise<string> {
  return getSignedUrl(r2(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), {
    expiresIn: expiresInSeconds,
  });
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
