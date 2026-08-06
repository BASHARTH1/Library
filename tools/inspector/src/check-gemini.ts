/** Connectivity + capability probe for the configured Gemini credentials. */
import { GoogleGenAI } from '@google/genai';
import { env } from './lib/env.js';

async function main(): Promise<void> {
  const key = env.geminiApiKey;
  console.log(`API key: ${key.slice(0, 6)}...${key.slice(-4)} (len ${key.length})`);
  const ai = new GoogleGenAI({ apiKey: key });

  console.log('\n--- listing models ---');
  try {
    const pager = await ai.models.list();
    const names: string[] = [];
    for await (const model of pager) {
      names.push(model.name ?? '(unnamed)');
      if (names.length >= 60) break;
    }
    console.log(names.join('\n'));
  } catch (error) {
    console.log(`list failed: ${(error as Error).message}`);
  }

  for (const model of [env.geminiFastModel, env.geminiChatModel]) {
    console.log(`\n--- generateContent: ${model} ---`);
    try {
      const response = await ai.models.generateContent({
        model,
        contents: 'Reply with exactly: OK',
      });
      console.log(`text: ${response.text}`);
      console.log(`usage: ${JSON.stringify(response.usageMetadata)}`);
    } catch (error) {
      console.log(`FAILED: ${(error as Error).message.slice(0, 400)}`);
    }
  }

  console.log(`\n--- embedContent: ${env.geminiEmbeddingModel} ---`);
  try {
    const response = await ai.models.embedContent({
      model: env.geminiEmbeddingModel,
      contents: 'اختبار التضمين للغة العربية',
      config: { outputDimensionality: 1536 },
    });
    const values = response.embeddings?.[0]?.values ?? [];
    console.log(`dimensions: ${values.length}`);
    console.log(`first 5: ${values.slice(0, 5).map((v) => v.toFixed(5)).join(', ')}`);
  } catch (error) {
    console.log(`FAILED: ${(error as Error).message.slice(0, 400)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
