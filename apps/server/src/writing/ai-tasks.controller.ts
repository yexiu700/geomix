import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  AI_TASK_ID_PATTERN,
  API_ERROR,
  AUTH_ERROR,
  CrudQueryError,
  aiTaskBulkDeleteSchema,
  aiTaskCreateSchema,
  aiTaskExportTable,
  ok,
  parseAiTaskListQuery,
  sampleExportMime,
  toCsv,
  toXlsx,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { LlmService } from '../infra/llm';
import { AiTasksService } from './ai-tasks.service';

type DownloadResponse = {
  status(code: number): DownloadResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
};

function readTaskId(raw: string): string {
  const value = raw.trim();
  if (!AI_TASK_ID_PATTERN.test(value)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '任务编号不合法');
  }
  return value;
}

function requireUserId(req: unknown): string {
  const auth = asHttpRequest(req).auth;
  if (!auth?.userId) {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录或会话已失效');
  }
  return auth.userId;
}

@Controller('ai-tasks')
@UseGuards(AuthGuard, TenantActiveGuard)
export class AiTasksController {
  constructor(
    @Inject(AiTasksService) private readonly tasks: AiTasksService,
    @Inject(LlmService) private readonly llm: LlmService,
  ) {}

  @Get()
  async list(
    @Query() query: Record<string, string | string[] | undefined>,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    let parsed;
    try {
      parsed = parseAiTaskListQuery(query);
    } catch (error) {
      if (error instanceof CrudQueryError) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, error.message);
      }
      throw error;
    }

    const exportKind = parsed.export;
    if (!exportKind) {
      response.status(200).json(ok(await this.tasks.page(parsed)));
      return;
    }

    const rows = await this.tasks.exportRows(parsed);
    const table = aiTaskExportTable(rows);
    const body =
      exportKind === 'csv'
        ? toCsv(table.headers, table.rows)
        : Buffer.from(toXlsx(table.headers, table.rows));
    response.status(200);
    response.setHeader('content-type', sampleExportMime(exportKind));
    response.setHeader('content-disposition', `attachment; filename="ai-tasks.${exportKind}"`);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.send(body);
  }

  @Get('generation-mode')
  generationMode() {
    return ok({
      bodySimulated: this.llm.usesFakePrimary('body'),
      titleSimulated: this.llm.usesFakePrimary('title'),
    });
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return ok(await this.tasks.detail(readTaskId(id)));
  }

  @Post()
  @HttpCode(200)
  async create(@Body() body: unknown, @Req() req: unknown) {
    const userId = requireUserId(req);
    const parsed = parseBody(aiTaskCreateSchema, body);
    return ok(await this.tasks.create(parsed, userId));
  }

  @Post('bulk-delete')
  @HttpCode(200)
  async bulkDelete(@Body() body: unknown) {
    const parsed = parseBody(aiTaskBulkDeleteSchema, body);
    return ok(await this.tasks.bulkDelete(parsed.ids));
  }

  @Post(':id/pause')
  @HttpCode(200)
  async pause(@Param('id') id: string) {
    return ok(await this.tasks.pause(readTaskId(id)));
  }

  @Post(':id/resume')
  @HttpCode(200)
  async resume(@Param('id') id: string) {
    return ok(await this.tasks.resume(readTaskId(id)));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string) {
    return ok(await this.tasks.cancel(readTaskId(id)));
  }

  @Delete(':id')
  async deleteOne(@Param('id') id: string) {
    return ok(await this.tasks.bulkDelete([readTaskId(id)]));
  }
}
