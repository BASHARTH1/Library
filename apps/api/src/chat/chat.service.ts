import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GeminiService } from '../gemini/gemini.service';
import { SearchService } from '../search/search.service';
import {
  GENERAL_KNOWLEDGE_SUFFIX,
  NOT_FOUND_AR,
  NOT_FOUND_EN,
  REPOSITORY_SYSTEM_INSTRUCTION,
  SINGLE_RESEARCH_SYSTEM_INSTRUCTION,
  buildGroundedPrompt,
  detectLanguage,
  estimateConfidence,
  validateCitations,
} from '../gemini/grounding';
import type { GroundingChunk, StreamChunk } from '../gemini/gemini.types';

export interface AskInput {
  question: string;
  researchId?: string;
  conversationId?: string;
  userId?: string;
  isUniversityMember?: boolean;
  isAdmin?: boolean;
  generalKnowledge?: boolean;
  signal?: AbortSignal;
}

export interface AnswerSource {
  chunkId: string;
  researchId: string;
  researchTitle: string;
  pageNumber: number;
  sectionName: string | null;
  excerpt: string;
  similarity: number;
  wasCited: boolean;
  /** Attribution shown next to every repository-wide citation (spec §7). */
  authors: string[];
  publicationYear: number | null;
  facultyName: string | null;
}

export interface AskEvent {
  type: 'sources' | 'delta' | 'final' | 'error';
  sources?: AnswerSource[];
  text?: string;
  final?: {
    conversationId: string;
    messageId: string;
    answer: string;
    confidence: { level: string; score: number };
    citedPages: number[];
    invalidPages: number[];
    sources: AnswerSource[];
    /** How context was found for THIS answer, and over how many papers. */
    retrieval: { mode: 'semantic' | 'lexical' | 'none'; papersSearched: number };
    usage: { model: string; totalTokens: number; latencyMs: number };
  };
  error?: string;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly gemini: GeminiService,
    private readonly search: SearchService,
  ) {}

  /**
   * Retrieval-Augmented Generation with streaming output.
   *
   * Workflow (spec §6): receive question → detect language → embed query →
   * retrieve chunks scoped to the paper and the viewer's access → send to Gemini
   * → stream answer → validate citations → persist conversation + sources.
   */
  async *ask(input: AskInput): AsyncGenerator<AskEvent> {
    const question = input.question.trim();
    if (question.length === 0) {
      yield { type: 'error', error: 'Question must not be empty' };
      return;
    }

    const language = detectLanguage(question);

    let retrieved: GroundingChunk[];
    try {
      retrieved = await this.search.retrieveChunks({
        query: question,
        researchId: input.researchId,
        limit: Number(process.env.AI_MAX_RETRIEVED_CHUNKS ?? 12),
        isUniversityMember: input.isUniversityMember,
        isAdmin: input.isAdmin,
      });
    } catch (error) {
      yield { type: 'error', error: `Retrieval failed: ${(error as Error).message}` };
      return;
    }

    const sources: AnswerSource[] = retrieved.map((chunk) => ({
      chunkId: chunk.chunkId,
      researchId: chunk.researchId,
      researchTitle: chunk.researchTitle,
      pageNumber: chunk.pageNumber,
      sectionName: chunk.sectionName,
      excerpt: chunk.text.slice(0, 300),
      similarity: chunk.similarity,
      wasCited: false,
      authors: chunk.authors ?? [],
      publicationYear: chunk.publicationYear ?? null,
      facultyName: chunk.facultyName ?? null,
    }));

    yield { type: 'sources', sources };

    // No context retrieved → refuse rather than answer from general knowledge.
    if (retrieved.length === 0) {
      const answer = language === 'ar' ? NOT_FOUND_AR : NOT_FOUND_EN;
      const persisted = await this.persist({
        input, question, language, answer, sources: [],
        confidence: { level: 'none', score: 0 }, citedPages: [], invalidPages: [],
        usage: { model: 'none', totalTokens: 0, latencyMs: 0 }, prompt: '',
      });
      yield {
        type: 'final',
        final: {
          ...persisted, answer, confidence: { level: 'none', score: 0 },
          citedPages: [], invalidPages: [], sources: [],
          retrieval: { mode: 'none', papersSearched: 0 },
          usage: { model: 'none', totalTokens: 0, latencyMs: 0 },
        },
      };
      return;
    }

    const history = input.conversationId ? await this.loadHistory(input.conversationId) : [];
    const prompt = buildGroundedPrompt({ question, chunks: retrieved, history });

    let systemInstruction = input.researchId
      ? SINGLE_RESEARCH_SYSTEM_INSTRUCTION
      : REPOSITORY_SYSTEM_INSTRUCTION;
    if (input.generalKnowledge) systemInstruction += GENERAL_KNOWLEDGE_SUFFIX;

    let answer = '';
    let usage = { model: this.gemini.resolveModel('chat'), totalTokens: 0, latencyMs: 0 };
    let failed: string | null = null;

    const stream = this.gemini.generateStream(prompt, {
      tier: 'chat',
      systemInstruction,
      temperature: 0.2,
      maxOutputTokens: 4096,
      signal: input.signal,
    });

    for await (const event of stream as AsyncGenerator<StreamChunk>) {
      if (event.type === 'text' && event.text) {
        answer += event.text;
        yield { type: 'delta', text: event.text };
      } else if (event.type === 'usage' && event.usage) {
        usage = { model: event.usage.model, totalTokens: event.usage.totalTokens, latencyMs: event.usage.latencyMs };
      } else if (event.type === 'error') {
        failed = event.error ?? 'Gemini streaming failed';
      }
    }

    if (failed) {
      yield { type: 'error', error: failed };
      return;
    }

    // Citation validation (spec §18) — pages the model cited must exist in context.
    const citation = validateCitations(answer, retrieved);
    if (citation.invalidPages.length > 0) {
      this.logger.warn(`Model cited pages not in context: ${citation.invalidPages.join(', ')}`);
    }
    const confidence = estimateConfidence({ chunks: retrieved, answer, invalidPages: citation.invalidPages });

    // Page numbers alone are ambiguous across papers — page 8 exists in most of
    // them. For repository-wide answers a source counts as cited only when its
    // paper is actually named in the answer as well.
    const citedSet = new Set(citation.validPages);
    const normalizedAnswer = answer.replace(/\s+/g, ' ');
    for (const source of sources) {
      const pageCited = citedSet.has(source.pageNumber);
      if (!input.researchId) {
        const titleFragment = source.researchTitle.replace(/\s+/g, ' ').slice(0, 40);
        source.wasCited = pageCited && titleFragment.length > 0 && normalizedAnswer.includes(titleFragment);
      } else {
        source.wasCited = pageCited;
      }
    }

    const persisted = await this.persist({
      input, question, language, answer, sources,
      confidence, citedPages: citation.citedPages, invalidPages: citation.invalidPages,
      usage, prompt,
    });

    yield {
      type: 'final',
      final: {
        ...persisted, answer, confidence,
        citedPages: citation.citedPages, invalidPages: citation.invalidPages,
        sources,
        retrieval: {
          mode: retrieved[0]?.retrieval ?? 'none',
          papersSearched: new Set(retrieved.map((c) => c.researchId)).size,
        },
        usage,
      },
    };
  }

  private async loadHistory(conversationId: string): Promise<Array<{ role: string; content: string }>> {
    const max = Number(process.env.AI_MAX_CHAT_HISTORY ?? 20);
    const rows = await this.dataSource.query<Array<{ role: string; content: string }>>(
      `SELECT role, content FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [conversationId, max],
    );
    return rows.reverse();
  }

  private async persist(args: {
    input: AskInput;
    question: string;
    language: string;
    answer: string;
    sources: AnswerSource[];
    confidence: { level: string; score: number };
    citedPages: number[];
    invalidPages: number[];
    usage: { model: string; totalTokens: number; latencyMs: number };
    prompt: string;
  }): Promise<{ conversationId: string; messageId: string }> {
    const { input } = args;

    let conversationId = input.conversationId ?? null;
    if (!conversationId) {
      const [row] = await this.dataSource.query<Array<{ id: string }>>(
        `INSERT INTO ai_conversations (user_id, research_id, scope, title, general_knowledge_enabled)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [
          input.userId ?? null,
          input.researchId ?? null,
          input.researchId ? 'single_research' : 'repository',
          args.question.slice(0, 120),
          input.generalKnowledge ?? false,
        ],
      );
      conversationId = row.id;
    }

    await this.dataSource.query(
      `INSERT INTO ai_messages (conversation_id, role, content, language) VALUES ($1,'user',$2,$3)`,
      [conversationId, args.question, args.language],
    );

    const [message] = await this.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO ai_messages
         (conversation_id, role, content, language, confidence, model, total_tokens, latency_ms, prompt_hash, rendered_prompt)
       VALUES ($1,'assistant',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        conversationId, args.answer, args.language, args.confidence.score,
        args.usage.model, args.usage.totalTokens, args.usage.latencyMs,
        createHash('sha256').update(args.prompt).digest('hex'),
        args.prompt.slice(0, 200000),
      ],
    );

    let rank = 1;
    for (const source of args.sources) {
      await this.dataSource.query(
        `INSERT INTO ai_message_sources
           (message_id, chunk_id, research_id, page_number, similarity, rank, was_cited, quoted_text, citation_valid)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          message.id, source.chunkId, source.researchId, source.pageNumber,
          source.similarity, rank++, source.wasCited, source.excerpt.slice(0, 500),
          args.invalidPages.length === 0,
        ],
      );
    }

    await this.dataSource.query(
      `INSERT INTO ai_usage_logs
         (user_id, research_id, operation, model, total_tokens, latency_ms, succeeded)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [
        input.userId ?? null, input.researchId ?? null,
        input.researchId ? 'chat_single' : 'chat_repository',
        args.usage.model, args.usage.totalTokens, args.usage.latencyMs,
      ],
    );

    return { conversationId, messageId: message.id };
  }

  /** Suggested questions grounded in the paper's actual content (spec §17). */
  async suggestedQuestions(researchId: string): Promise<string[]> {
    const cached = await this.dataSource.query<Array<{ content: string }>>(
      `SELECT content FROM ai_generated_content
       WHERE research_id = $1 AND kind = 'suggested_questions' AND deleted_at IS NULL LIMIT 1`,
      [researchId],
    );
    if (cached.length > 0) return JSON.parse(cached[0].content) as string[];

    const rows = await this.dataSource.query<Array<{ title: string; abstract: string | null; sections: string }>>(
      `SELECT COALESCE(r.title_ar, r.title_en) AS title,
              COALESCE(r.abstract_ar, r.abstract_en) AS abstract,
              COALESCE(string_agg(DISTINCT s.name, ', '), '') AS sections
       FROM research r LEFT JOIN research_sections s ON s.research_id = r.id
       WHERE r.id = $1 GROUP BY r.id`,
      [researchId],
    );
    if (rows.length === 0) return [];

    const result = await this.gemini.generate<{ questions: string[] }>(
      `Based only on the research metadata below, propose 6 questions a reader could ask about THIS paper.
Return JSON: {"questions": ["...", ...]}

Title: ${rows[0].title}
Abstract: ${(rows[0].abstract ?? '').slice(0, 2000)}
Sections present: ${rows[0].sections}

Write questions in the same language as the title. Only ask about topics the abstract or sections show are covered.`,
      {
        tier: 'fast',
        responseSchema: {
          type: 'object',
          properties: { questions: { type: 'array', items: { type: 'string' } } },
          required: ['questions'],
        },
      },
    );

    const questions = result.data.questions.slice(0, 6);
    await this.dataSource.query(
      `INSERT INTO ai_generated_content (research_id, kind, language, content, model, total_tokens)
       VALUES ($1,'suggested_questions','unknown',$2,$3,$4)
       ON CONFLICT (research_id, kind, language) WHERE deleted_at IS NULL DO NOTHING`,
      [researchId, JSON.stringify(questions), result.usage.model, result.usage.totalTokens],
    );
    return questions;
  }
}
