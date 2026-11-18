import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { NotFoundException } from '@nestjs/common';
import { get } from '@vercel/blob';
import type { Response } from 'express';
import { getR2Object, isR2Path } from './r2';

/**
 * Streams a stored research file to the response. Callers must have completed
 * their access check first: this function grants access to whatever it is given.
 */
export async function streamStoredFile(
  file: { storedPath: string; originalFilename: string; mimeType: string },
  res: Response,
): Promise<void> {
  res.setHeader('Content-Type', file.mimeType);
  // inline so the PDF renders in the viewer rather than downloading
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalFilename)}"`);

  // Deployed, stored_path is an object in the PRIVATE R2 bucket.
  if (isR2Path(file.storedPath)) {
    const object = await getR2Object(file.storedPath);
    if (!object) throw new NotFoundException('File not available');
    if (object.length !== undefined) res.setHeader('Content-Length', String(object.length));
    object.stream.pipe(res);
    return;
  }

  // Older deployments used a PRIVATE Vercel Blob URL: it is fetched server-side
  // with the store token, so possessing the URL grants nothing. Locally it is
  // still a filesystem path.
  if (file.storedPath.startsWith('http')) {
    const result = await get(file.storedPath, {
      access: 'private',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    // get() resolves to null when the blob is absent.
    if (!result || result.statusCode !== 200 || !result.stream) {
      throw new NotFoundException('File not available');
    }
    const length = result.headers.get('content-length');
    if (length) res.setHeader('Content-Length', length);
    Readable.fromWeb(result.stream as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    return;
  }

  if (!existsSync(file.storedPath)) throw new NotFoundException('File not available');
  createReadStream(file.storedPath).pipe(res);
}
