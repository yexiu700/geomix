import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
  KEYWORD_ID_PATTERN,
  keywordBulkSchema,
  keywordDistillSchema,
  keywordExportTable,
  keywordSaveSchema,
  ok,
  parseKeywordListQuery,
  sampleExportMime,
  toCsv,
  toXlsx,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { KeywordsService } from './keywords.service';

type DownloadResponse = {
  status(code: number): DownloadResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
};

@Controller('keywords')
@UseGuards(AuthGuard, TenantActiveGuard)
export class KeywordsController {
  constructor(@Inject(KeywordsService) private readonly keywords: KeywordsService) {}

  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    const parsed = parseKeywordListQuery(query);
    if (!parsed.export) {
      response.status(200).json(ok(await this.keywords.page(parsed)));
      return;
    }
    const table = keywordExportTable(await this.keywords.collect(parsed));
    const body =
      parsed.export === 'csv'
        ? toCsv(table.headers, table.rows)
        : Buffer.from(toXlsx(table.headers, table.rows));
    response.status(200);
    response.setHeader('content-type', sampleExportMime(parsed.export));
    response.setHeader('content-disposition', `attachment; filename="keywords.${parsed.export}"`);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.send(body);
  }

  @Get(':id')
  async one(@Param('id') id: string) {
    return ok(await this.keywords.one(readKeywordId(id)));
  }

  @Post('distill')
  @HttpCode(200)
  async distill(
    @Body() body: unknown,
    @Headers('idempotency-key') idemHeader: string | undefined,
    @Req() req: unknown,
  ) {
    const parsed = parseBody(keywordDistillSchema, body);
    return ok(
      await this.keywords.distill({
        ...parsed,
        idempotencyKey: idemHeader,
        userId: asHttpRequest(req).auth?.userId,
      }),
    );
  }

  @Post()
  @HttpCode(200)
  async create(@Body() body: unknown, @Req() req: unknown) {
    const parsed = parseBody(keywordSaveSchema, body);
    return ok(
      await this.keywords.create({
        ...parsed,
        userId: asHttpRequest(req).auth?.userId,
      }),
    );
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: unknown) {
    const parsed = parseBody(keywordSaveSchema, body);
    return ok(
      await this.keywords.update(readKeywordId(id), {
        ...parsed,
        userId: asHttpRequest(req).auth?.userId,
      }),
    );
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return ok(await this.keywords.removeMany([readKeywordId(id)]));
  }

  @Post('bulk')
  @HttpCode(200)
  async bulk(@Body() body: unknown) {
    const parsed = parseBody(keywordBulkSchema, body);
    return ok(await this.keywords.removeMany(parsed.ids));
  }
}

function readKeywordId(id: string): string {
  if (!KEYWORD_ID_PATTERN.test(id)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '关键词编号不正确');
  }
  return id;
}
