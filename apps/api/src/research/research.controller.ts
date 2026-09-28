import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { get } from '@vercel/blob';
import { getR2Object, isR2Path } from '../files/r2';
import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AiUsageGuard } from '../auth/auth.guards';
import { ResearchService } from './research.service';
import { SearchService, type SearchFilters } from '../search/search.service';
import { ChatService } from '../chat/chat.service';
import {
  CurrentUser,
  OptionalAuth,
  type AuthenticatedUser,
} from '../auth/auth.types';

/**
 * Browsing and search work anonymously, but the viewer's identity still decides
 * which access levels are visible — an anonymous caller sees only public
 * research, a university member sees more (spec §27).
 */
@Controller('api')
@OptionalAuth()
export class ResearchController {
  constructor(
    private readonly research: ResearchService,
    private readonly search: SearchService,
    private readonly chat: ChatService,
  ) {}

  @Get('stats')
  stats() {
    return this.research.stats();
  }

  @Get('facets')
  facets() {
    return this.research.facets();
  }

  @Get('research/latest')
  latest(@Query('limit') limit?: string) {
    return this.research.latest(limit ? Number(limit) : 8);
  }

  @Get('research/most-viewed')
  mostViewed(@Query('limit') limit?: string) {
    return this.research.mostViewed(limit ? Number(limit) : 8);
  }

  @Get('search')
  async searchResearch(
    @Query('q') q = '',
    @Query('year') year?: string,
    @Query('facultyId') facultyId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('language') language?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('semantic') semantic?: string,
    @CurrentUser() user?: AuthenticatedUser | null,
  ) {
    const filters: SearchFilters = {};
    if (year) filters.year = Number(year);
    if (facultyId) filters.facultyId = facultyId;
    if (departmentId) filters.departmentId = departmentId;
    if (language) filters.language = language;

    return this.search.search({
      query: q,
      filters,
      limit: limit ? Number(limit) : 20,
      offset: offset ? Number(offset) : 0,
      semantic: semantic !== 'false',
      isUniversityMember: user?.isUniversityMember ?? false,
      isAdmin: user?.isAdmin ?? false,
    });
  }

  @Get('research/:id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.research.findOne(id, { countView: true });
  }

  @Get('research/:id/similar')
  similar(@Param('id', ParseUUIDPipe) id: string) {
    return this.research.similar(id, false, false);
  }

  /**
   * Generates via Gemini on a cache miss, so it is a billable route. Open to
   * signed-out visitors like the rest of the assistant; AiUsageGuard meters it.
   */
  @Get('research/:id/suggested-questions')
  @UseGuards(AiUsageGuard)
  suggestedQuestions(@Param('id', ParseUUIDPipe) id: string) {
    return this.chat.suggestedQuestions(id);
  }

  @Get('research/:id/pages/:page')
  page(@Param('id', ParseUUIDPipe) id: string, @Param('page', ParseIntPipe) page: number) {
    return this.research.page(id, page);
  }

  /**
   * Streams the canonical file for the in-browser viewer.
   * The access level is re-checked here — a research id is guessable, so this
   * must not rely on the caller having come from a permitted listing.
   */
  @Get('research/:id/file')
  @Header('Cache-Control', 'private, max-age=3600')
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser | null,
    @Res() res: Response,
  ): Promise<void> {
    const allowed = await this.research.canAccessFile(
      id,
      user?.isUniversityMember ?? false,
      user?.isAdmin ?? false,
    );
    if (!allowed) throw new ForbiddenException('You are not permitted to open this file');

    const file = await this.research.canonicalFile(id);
    if (!file) throw new NotFoundException('File not available');

    res.setHeader('Content-Type', file.mimeType);
    // inline so the PDF renders in the viewer rather than downloading
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalFilename)}"`);

    // Deployed, stored_path is an object in the PRIVATE R2 bucket, streamed only
    // after the access check above.
    if (isR2Path(file.storedPath)) {
      const object = await getR2Object(file.storedPath);
      if (!object) throw new NotFoundException('File not available');
      if (object.length !== undefined) res.setHeader('Content-Length', String(object.length));
      object.stream.pipe(res);
      return;
    }

    // Older deployments used a PRIVATE Vercel Blob URL: it is fetched server-side
    // with the store token and streamed only after the access check above, so
    // possessing the URL grants nothing. Locally it is still a filesystem path.
    if (file.storedPath.startsWith('http')) {
      // A private blob cannot be fetched by URL alone — that is the point of
      // choosing private storage. get() authenticates with the store token and
      // returns a stream, which is piped only after the access check above.
      const result = await get(file.storedPath, {
        access: 'private',
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      // get() resolves to null when the blob is absent.
      if (!result || result.statusCode !== 200 || !result.stream) {
        throw new NotFoundException('File not available');
      }
      const length = result.headers.get('content-length');
      if (length) res.setHeader('Content-Length', length);
      Readable.fromWeb(result.stream as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
      return;
    }

    if (!existsSync(file.storedPath)) throw new NotFoundException('File not available');
    createReadStream(file.storedPath).pipe(res);
  }
}
