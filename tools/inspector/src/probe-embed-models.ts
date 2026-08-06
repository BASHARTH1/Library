/**
 * The Gemini free-tier embedding quota is scoped PER MODEL
 * (EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier), so a second
 * embedding model may still have headroom today.
 *
 * Caveat: vectors from different models are NOT comparable, so a corpus must be
 * embedded entirely with one model. This probe only establishes what is usable.
 */
import { GoogleGenAI } from '@google/genai';
import { env } from './lib/env.js';

const CANDIDATES = ['gemini-embedding-001', 'gemini-embedding-2', 'gemini-embedding-2-preview'];

async function main(): Promise<void> {
  const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });

  for (const model of CANDIDATES) {
    try {
      const response = await ai.models.embedContent({
        model,
        contents: Array.from({ length: 8 }, (_, i) => `نص تجريبي رقم ${i} لقياس الحصة اليومية`),
        config: { outputDimensionality: 1536 },
      });
      const dims = response.embeddings?.[0]?.values?.length ?? 0;
      console.log(`AVAILABLE  ${model.padEnd(28)} batch=8 ok, dims=${dims}`);
    } catch (error) {
      const message = (error as Error).message;
      const quota = message.match(/"quotaValue":\s*"(\d+)"/)?.[1];
      const retry = message.match(/"retryDelay":\s*"([^"]+)"/)?.[1];
      const perDay = /PerDay/i.test(message);
      console.log(
        `EXHAUSTED  ${model.padEnd(28)} limit=${quota ?? '?'}/${perDay ? 'day' : 'min'} retryIn=${retry ?? '?'}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
