/** Determine the exact embedding quota metric and limit for this API key. */
import { GoogleGenAI } from '@google/genai';
import { env } from './lib/env.js';

async function main(): Promise<void> {
  const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });

  // Single-content call first — establishes whether embeddings work at all now.
  try {
    const single = await ai.models.embedContent({
      model: env.geminiEmbeddingModel,
      contents: 'اختبار',
      config: { outputDimensionality: 1536 },
    });
    console.log(`single content OK — dims=${single.embeddings?.[0]?.values?.length}`);
  } catch (error) {
    console.log(`single content FAILED:\n${(error as Error).message}\n`);
  }

  // Batch call — shows whether batching multiplies quota consumption.
  for (const batchSize of [4, 16]) {
    try {
      const response = await ai.models.embedContent({
        model: env.geminiEmbeddingModel,
        contents: Array.from({ length: batchSize }, (_, i) => `نص تجريبي رقم ${i} للاختبار`),
        config: { outputDimensionality: 1536 },
      });
      console.log(`batch ${batchSize} OK — returned ${response.embeddings?.length}`);
    } catch (error) {
      console.log(`batch ${batchSize} FAILED:\n${(error as Error).message.slice(0, 1200)}\n`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
