import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { ChatService } from './chat.service';
import { AssistantService } from './assistant.service';
import { AiUsageGuard } from '../auth/auth.guards';
import { ANONYMOUS, CurrentUser, OptionalAuth, type AuthenticatedUser } from '../auth/auth.types';

/** Anonymous callers have no users row, and ai_usage_logs.user_id is a FK. */
const usageOwner = (user: AuthenticatedUser): string | undefined =>
  user.id === ANONYMOUS.id ? undefined : user.id;

export class AskDto {
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  question!: string;

  @IsOptional() @IsUUID() researchId?: string;
  @IsOptional() @IsUUID() conversationId?: string;
  @IsOptional() @IsBoolean() generalKnowledge?: boolean;
}

export class FindDto {
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  query!: string;

  @IsOptional() @IsInt() @Min(1) @Max(20) limit?: number;
}

/**
 * Both AI endpoints are open to signed-out visitors: the repository is public
 * and the assistant is part of what it offers.
 *
 * They remain the only routes that can spend money, so AiUsageGuard still runs
 * — a signed-in caller is metered against their own daily allowance, and
 * everyone else shares the anonymous ceiling.
 */
@Controller('api/chat')
@UseGuards(AiUsageGuard)
@OptionalAuth()
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly assistant: AssistantService,
  ) {}

  /**
   * Search assistant: finds papers and explains why each one matches.
   * The result set comes from the database; the model only annotates it.
   */
  @Post('find')
  find(@Body() body: FindDto, @CurrentUser() user: AuthenticatedUser) {
    return this.assistant.find({
      query: body.query,
      limit: body.limit,
      userId: usageOwner(user),
      isUniversityMember: user.isUniversityMember,
      isAdmin: user.isAdmin,
    });
  }

  /**
   * Server-Sent Events endpoint (spec §21). Emits `sources` first so the UI can
   * show citations while the answer is still streaming, then `delta` tokens,
   * then a `final` payload with confidence and citation validation.
   */
  @Post('ask')
  async ask(
    @Body() body: AskDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Client disconnect (or the "stop generation" button) aborts the Gemini call.
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const event of this.chat.ask({
        question: body.question,
        researchId: body.researchId,
        conversationId: body.conversationId,
        generalKnowledge: body.generalKnowledge,
        // Retrieval is access-filtered by these before any chunk is read.
        userId: usageOwner(user),
        isUniversityMember: user.isUniversityMember,
        isAdmin: user.isAdmin,
        signal: controller.signal,
      })) {
        switch (event.type) {
          case 'sources':
            send('sources', { sources: event.sources });
            break;
          case 'delta':
            send('delta', { text: event.text });
            break;
          case 'final':
            send('final', event.final);
            break;
          case 'error':
            send('error', { error: event.error });
            break;
        }
      }
    } catch (error) {
      send('error', { error: (error as Error).message });
    } finally {
      res.write('event: done\ndata: {}\n\n');
      res.end();
    }
  }
}
