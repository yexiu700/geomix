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
  QUESTION_ID_PATTERN,
  ok,
  parseQuestionListQuery,
  questionBatchCreateSchema,
  questionBulkSchema,
  questionExportTable,
  questionUpdateSchema,
  sampleExportMime,
  toCsv,
  toXlsx,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { QuestionsService } from './questions.service';

type DownloadResponse = {
  status(code: number): DownloadResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
};

function readQuestionId(raw: string): string {
  const id = raw.trim();
  if (!QUESTION_ID_PATTERN.test(id)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '写作标题编号不合法');
  }
  return id;
}

@Controller('questions')
@UseGuards(AuthGuard, TenantActiveGuard)
export class QuestionsController {
  constructor(@Inject(QuestionsService) private readonly questions: QuestionsService) {}

  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    const parsed = parseQuestionListQuery(query);
    if (!parsed.export) {
      response.status(200).json(ok(await this.questions.page(parsed)));
      return;
    }
    const table = questionExportTable(await this.questions.collect(parsed));
    const body =
      parsed.export === 'csv'
        ? toCsv(table.headers, table.rows)
        : Buffer.from(toXlsx(table.headers, table.rows));
    response.status(200);
    response.setHeader('content-type', sampleExportMime(parsed.export));
    response.setHeader('content-disposition', `attachment; filename="questions.${parsed.export}"`);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.send(body);
  }

  @Post()
  @HttpCode(200)
  async batchCreate(@Body() body: unknown, @Req() req: unknown) {
    const parsed = parseBody(questionBatchCreateSchema, body);
    return ok(
      await this.questions.batchCreate({
        ...parsed,
        userId: asHttpRequest(req).auth?.userId,
      }),
    );
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: unknown) {
    const parsed = parseBody(questionUpdateSchema, body);
    return ok(
      await this.questions.update(readQuestionId(id), {
        ...parsed,
        userId: asHttpRequest(req).auth?.userId,
      }),
    );
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return ok(await this.questions.removeMany([readQuestionId(id)]));
  }

  @Post('bulk')
  @HttpCode(200)
  async bulk(@Body() body: unknown) {
    const parsed = parseBody(questionBulkSchema, body);
    return ok(await this.questions.removeMany(parsed.ids));
  }
}
