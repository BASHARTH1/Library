import { createReadStream, existsSync } from 'node:fs';
import { Controller, Get, Header, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ResearchService } from './research.service';
import { SearchService, type SearchFilters } from '../search/search.service';
import { ChatService } from '../chat/chat.service';

@Controller('api')
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

  @Get('research/:id/suggested-questions')
  suggestedQuestions(@Param('id', ParseUUIDPipe) id: string) {
    return this.chat.suggestedQuestions(id);
  }

  @Get('research/:id/pages/:page')
  page(@Param('id', ParseUUIDPipe) id: string, @Param('page', ParseIntPipe) page: number) {
    return this.research.page(id, page);
  }

  /** Streams the canonical file for the in-browser viewer. */
  @Get('research/:id/file')
  @Header('Cache-Control', 'private, max-age=3600')
  async file(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const file = await this.research.canonicalFile(id);
    if (!file || !existsSync(file.storedPath)) throw new NotFoundException('File not available');
    res.setHeader('Content-Type', file.mimeType);
    // inline so the PDF renders in the viewer rather than downloading
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalFilename)}"`);
    createReadStream(file.storedPath).pipe(res);
  }
}
