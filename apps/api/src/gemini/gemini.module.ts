import { Global, Module } from '@nestjs/common';
import { GeminiService } from './gemini.service';

/**
 * Dedicated module for all Gemini API communication (spec requirement).
 * Global so feature modules never instantiate their own client — and so the
 * API key stays confined to exactly one service.
 */
@Global()
@Module({
  providers: [GeminiService],
  exports: [GeminiService],
})
export class GeminiModule {}
