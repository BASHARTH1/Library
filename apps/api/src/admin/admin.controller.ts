import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/auth.types';
import { isR2Configured } from '../files/r2';
import { streamStoredFile } from '../files/serve';
import {
  CreateThesisDto,
  CreateUserDto,
  FacultyDto,
  ThesisDetailsDto,
  ThesisFileDto,
  UpdateUserDto,
} from './admin.dto';
import { AdminService } from './admin.service';
import { ThesisPipelineService } from './thesis-pipeline.service';

/**
 * Repository management. Authentication is already global, so a token is always
 * required here; the class-level permission covers every route that does not
 * ask for something stronger. Admins and librarians hold it.
 */
@Controller('api/admin')
@RequirePermissions('admin.review')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly pipeline: ThesisPipelineService,
  ) {}

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @Get('activity')
  activity() {
    return this.admin.activity();
  }

  // ---- theses --------------------------------------------------------------

  @Get('research')
  listTheses(
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('trash') trash?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.admin.listTheses({
      q,
      status: status || undefined,
      trash: trash === 'true',
      limit: Number(limit) || 25,
      offset: Number(offset) || 0,
    });
  }

  @Post('research/upload-url')
  @HttpCode(200)
  prepareUpload(@Body() file: ThesisFileDto) {
    return this.admin.prepareUpload(file);
  }

  @Post('research')
  createThesis(@Body() body: CreateThesisDto, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.createThesis(body, user.id);
  }

  @Get('research/:id')
  thesis(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.thesis(id);
  }

  @Patch('research/:id')
  updateThesis(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ThesisDetailsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.admin.updateThesis(id, body, user.id);
  }

  @Delete('research/:id')
  async deleteThesis(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.admin.deleteThesis(id, user.id);
    return { ok: true };
  }

  @Post('research/:id/restore')
  @HttpCode(200)
  async restoreThesis(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.admin.restoreThesis(id, user.id);
    return { ok: true };
  }

  @Post('research/:id/publish')
  @HttpCode(200)
  async publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.admin.publish(id, user.id);
    return { ok: true };
  }

  @Post('research/:id/unpublish')
  @HttpCode(200)
  async unpublish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.admin.unpublish(id, user.id);
    return { ok: true };
  }

  /** Runs one bounded processing step. The admin page calls this until finished. */
  @Post('research/:id/process')
  @HttpCode(200)
  process(@Param('id', ParseUUIDPipe) id: string) {
    return this.pipeline.advance(id);
  }

  @Post('research/:id/retry')
  @HttpCode(200)
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.pipeline.retry(id);
  }

  @Post('research/:id/embed-missing')
  @HttpCode(200)
  async embedMissing(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.admin.queueMissingVectors(id, user.id);
    return this.pipeline.state(id);
  }

  @Post('research/:id/replace-file/upload-url')
  @HttpCode(200)
  prepareReplacement(@Param('id', ParseUUIDPipe) id: string, @Body() file: ThesisFileDto) {
    return this.admin.prepareUpload(file, id);
  }

  @Post('research/:id/replace-file')
  @HttpCode(200)
  async replaceFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() file: ThesisFileDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.admin.replaceFile(id, file, user.id);
    return { ok: true };
  }

  /** Lets an admin read a draft, which the public file route refuses to serve. */
  @Get('research/:id/file')
  async file(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await streamStoredFile(await this.admin.thesisFile(id), res);
  }

  /**
   * Development only. In production the browser uploads straight to R2, and a
   * function could not accept a thesis-sized body anyway.
   */
  @Put('uploads/:name')
  async localUpload(@Param('name') name: string, @Req() req: Request) {
    if (isR2Configured()) throw new NotFoundException();
    this.admin.assertLocalUploadName(name);
    await pipeline(req, createWriteStream(this.admin.localUploadPath(name)));
    return { ok: true };
  }

  // ---- faculties and departments -------------------------------------------

  @Get('faculties')
  faculties() {
    return this.admin.faculties();
  }

  @Post('faculties')
  createFaculty(@Body() body: FacultyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.createFaculty(body, user.id);
  }

  @Patch('faculties/:id')
  async updateFaculty(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: FacultyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.admin.updateFaculty(id, body, user.id);
    return { ok: true };
  }

  @Delete('faculties/:id')
  async deleteFaculty(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.admin.deleteFaculty(id, user.id);
    return { ok: true };
  }

  @Post('faculties/:id/departments')
  createDepartment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: FacultyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.admin.createDepartment(id, body, user.id);
  }

  @Patch('departments/:id')
  async updateDepartment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: FacultyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.admin.updateDepartment(id, body, user.id);
    return { ok: true };
  }

  @Delete('departments/:id')
  async deleteDepartment(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.admin.deleteDepartment(id, user.id);
    return { ok: true };
  }

  // ---- users ---------------------------------------------------------------

  @Get('users')
  @RequirePermissions('admin.manage_users')
  users(@Query('q') q?: string) {
    return this.admin.users(q);
  }

  @Post('users')
  @RequirePermissions('admin.manage_users')
  createUser(@Body() body: CreateUserDto, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.createUser(body, user.id);
  }

  @Patch('users/:id')
  @RequirePermissions('admin.manage_users')
  async updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUserDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.admin.updateUser(id, body, user.id);
    return { ok: true };
  }
}
