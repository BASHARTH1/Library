/** Probe which generation models the configured key can actually call. */
import { GoogleGenAI } from '@google/genai';
import { env } from './lib/env.js';

const CANDIDATES = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-3-pro-preview',
  'gemini-pro-latest',
  'gemini-2.0-flash',
];

async function main(): Promise<void> {
  const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });
  for (const model of CANDIDATES) {
    const started = Date.now();
    try {
      const response = await ai.models.generateContent({
        model,
        contents: 'Reply with exactly: OK',
        config: { maxOutputTokens: 2048 },
      });
      const usage = response.usageMetadata;
      console.log(
        `OK      ${model.padEnd(28)} ${String(Date.now() - started).padStart(6)}ms  text=${JSON.stringify(response.text ?? '').slice(0, 20)}  tokens=${usage?.totalTokenCount ?? '?'}`,
      );
    } catch (error) {
      const message = (error as Error).message;
      const code = message.match(/"code":\s*(\d+)/)?.[1] ?? '?';
      console.log(`FAIL(${code}) ${model.padEnd(28)} ${message.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
