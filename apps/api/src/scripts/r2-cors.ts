/**
 * Allow the admin page to upload straight to the private R2 bucket.
 *
 * Theses are larger than a Vercel Function accepts, so the browser PUTs them to a
 * presigned URL, and the browser only does that when the bucket's CORS rules allow
 * the site's origin. This grants PUT only: reads still go through the API, after
 * its access check. Needs a token allowed to edit bucket settings; if yours is
 * object-only, add the same rule in the Cloudflare dashboard (see README).
 *
 * Usage: npm run api:r2-cors -- https://your-site.example [http://localhost:4200]
 */
import { resolve } from 'node:path';
import { PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { config as loadEnv } from 'dotenv';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
loadEnv({ path: resolve(REPO_ROOT, '.env'), quiet: true });
loadEnv({ path: resolve(REPO_ROOT, '.env.local'), override: true, quiet: true });

async function main(): Promise<void> {
  const origins = process.argv.slice(2);
  if (origins.length === 0 || origins.some((origin) => !/^https?:\/\/[^/]+$/.test(origin))) {
    throw new Error('Pass the site origin(s), for example: npm run api:r2-cors -- https://your-site.example');
  }

  const bucket = process.env.R2_BUCKET ?? 'gulf-research-files';
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    },
  });

  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          { AllowedOrigins: origins, AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'], MaxAgeSeconds: 3600 },
        ],
      },
    }),
  );
  console.log(`CORS updated on ${bucket}: PUT allowed from ${origins.join(', ')}`);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
