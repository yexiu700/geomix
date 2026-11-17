import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  PROMPT_ID_PATTERN,
  isPromptKind,
  ok,
  parsePromptListQuery,
  promptBulkSchema,
  promptCloneSchema,
  promptExportTable,
  promptWriteSchema,
  sampleExportMime,
  toCsv,
  toXlsx,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { PromptsService } from './prompts.service';

type DownloadResponse = {
  status(code: number): DownloadResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
};

function readPromptId(raw: string): string {
  const id = raw.trim();
  if (!PROMPT_ID_PATTERN.test(id)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '指令编号不合法');
  }
  return id;
}

function requireUserId(req: unknown): string {
  const auth = asHttpRequest(req).auth;
  if (!auth?.userId) {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
  }
  return auth.userId;
}

@Controller('prompts')
@UseGuards(AuthGuard, TenantActiveGuard)
export class PromptsController {
  constructor(@Inject(PromptsService) private readonly prompts: PromptsService) {}

  @Get()
  async list(
    @Query() query: Record<string, string | string[] | undefined>,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    const parsed = parsePromptListQuery(query);
    const exportKind = query.export === 'csv' || query.export === 'xlsx' ? query.export : undefined;
    if (!exportKind) {
      response.status(200).json(ok(await this.prompts.pageUser(parsed)));
      return;
    }
    const rows = await this.prompts.exportUserRows(parsed);
    const table = promptExportTable(rows);
    const body =
      exportKind === 'csv'
        ? toCsv(table.headers, table.rows)
        : Buffer.from(toXlsx(table.headers, table.rows));
    response.status(200);
    response.setHeader('content-type', sampleExportMime(exportKind));
    response.setHeader('content-disposition', `attachment; filename="prompts.${exportKind}"`);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.send(body);
  }

  @Get('system')
  async system(@Query() query: Record<string, string | string[] | undefined>) {
    const rawKind = (Array.isArray(query.kind) ? query.kind[0] : query.kind)?.trim();
    const kind = isPromptKind(rawKind) ? rawKind : undefined;
    return ok(await this.prompts.listSystem(kind));
  }

  @Get('options')
  async options(@Query() query: Record<string, string | string[] | undefined>) {
    const rawKind = (Array.isArray(query.kind) ? query.kind[0] : query.kind)?.trim();
    if (!isPromptKind(rawKind)) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '请指定有效的指令类型（ARTICLE/TITLE/REWRITE）',
      );
    }
    return ok(await this.prompts.optionsByKind(rawKind));
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return ok(await this.prompts.findOne(readPromptId(id)));
  }

  @Post()
  @HttpCode(200)
  async create(@Body() body: unknown, @Req() req: unknown) {
    const userId = requireUserId(req);
    const parsed = parseBody(promptWriteSchema, body);
    return ok(await this.prompts.create(parsed, userId));
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: unknown) {
    const promptId = readPromptId(id);
    const userId = requireUserId(req);
    const parsed = parseBody(promptWriteSchema, body);
    return ok(await this.prompts.update(promptId, parsed, userId));
  }

  @Post(':id/clone')
  @HttpCode(200)
  async clone(@Param('id') id: string, @Body() body: unknown, @Req() req: unknown) {
    const promptId = readPromptId(id);
    const userId = requireUserId(req);
    const parsed = parseBody(promptCloneSchema, body ?? {});
    return ok(await this.prompts.clone(promptId, parsed, userId));
  }

  @Post('bulk-delete')
  @HttpCode(200)
  async bulkDelete(@Body() body: unknown) {
    const parsed = parseBody(promptBulkSchema, body);
    return ok(await this.prompts.removeMany(parsed.ids));
  }

  @Delete(':id')
  async removeOne(@Param('id') id: string) {
    return ok(await this.prompts.removeMany([readPromptId(id)]));
  }
}
