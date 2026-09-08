import { routes, type VercelConfig } from '@vercel/config/v1';

/**
 * Deployment shape:
 *
 *   /api/*  -> api/index.ts, the NestJS app running as a Vercel Function
 *   /*      -> the Angular SPA built to apps/web/dist/web/browser
 *
 * The API and the SPA share one origin, so the browser needs no CORS handling
 * and the Gemini key stays entirely server-side.
 *
 * Not deployed here: OCR, ingestion and embedding backfill. Those runs take
 * 20-45 minutes, far beyond any function timeout, and remain local/CI scripts
 * under apps/api/src/scripts.
 */
export const config: VercelConfig = {
  framework: null,
  buildCommand: 'npm run vercel-build',
  installCommand: 'npm install',
  outputDirectory: 'apps/web/dist/web/browser',

  functions: {
    'api/index.ts': {
      // Chat answers stream for 15-25s; comparisons over several papers longer.
      maxDuration: 120,
      memory: 1769,
    },
  },

  rewrites: [
    // Every API path is handled by the single Nest entry point.
    routes.rewrite('/api/(.*)', '/api/index'),
    // SPA fallback: deep links like /research/:id must reach Angular's router,
    // not 404. Listed after the API rule so it never swallows /api.
    routes.rewrite('/((?!api/).*)', '/index.html'),
  ],

  headers: [
    routes.cacheControl('/assets/(.*)', { public: true, maxAge: '1 year', immutable: true }),
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      ],
    },
  ],
};

export default config;
