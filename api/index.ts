/**
 * Vercel serverless entry point for the NestJS API.
 *
 * Vercel routes every /api/* request here (see vercel.ts). The Nest application
 * is created once per warm instance and reused — Fluid Compute keeps instances
 * alive across requests, so cold-start cost is paid rarely rather than per call.
 *
 * Long-running work (OCR, ingestion, embedding backfill) is deliberately NOT
 * reachable from here: those runs take 20-45 minutes and exceed any function
 * timeout. They stay as local/CI scripts under apps/api/src/scripts.
 */
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';

// Imported from the tsc-compiled output, NOT from src.
//
// Vercel bundles functions with esbuild, which does not support
// emitDecoratorMetadata. Compiling AppModule from source here would strip the
// metadata NestJS needs for dependency injection and every provider would
// resolve as undefined at runtime. `npm run vercel-build` runs `nest build`
// (real tsc) first, so this import already carries its metadata.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule } = require('../apps/api/dist/app.module') as {
  AppModule: new () => unknown;
};

let cachedApp: Express | null = null;

async function bootstrap(): Promise<Express> {
  if (cachedApp) return cachedApp;

  const expressApp = express();
  const app = await NestFactory.create(AppModule as never, new ExpressAdapter(expressApp), {
    // Vercel captures stdout; keep the noise down but retain real failures.
    logger: ['error', 'warn'],
  });

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );

  // Same-origin in production: the SPA and the API share the deployment domain,
  // so no cross-origin allowance is needed beyond an explicit override.
  const origin = process.env.FRONTEND_ORIGIN;
  app.enableCors({ origin: origin ? origin : true, credentials: true });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  await app.init();
  cachedApp = expressApp;
  return expressApp;
}

export default async function handler(req: Request, res: Response): Promise<void> {
  const server = await bootstrap();
  server(req, res);
}
