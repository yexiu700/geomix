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
  API_ERROR,
  REWRITE_ID_PATTERN,
  ok,
  parseRewriteListQuery,
  rewriteBulkDeleteSchema,
  rewriteBulkStatusSchema,
  rewriteExportTable,
  rewriteSingleCreateSchema,
  toCsv,
  toXlsx,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { RewritesService } from './rewrites.service';

type DownloadResponse = {
  status(code: number): DownloadResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
};

function parseRecordId(raw: string): string {
  if (!REWRITE_ID_PATTERN.test(raw)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '复刻记录编号不合法');
  }
  return raw;
}

@Controller('rewrites')
@UseGuards(AuthGuard, TenantActiveGuard)
export class RewritesController {
  constructor(@Inject(RewritesService) private readonly rewrites: RewritesService) {}

  @Get()
  async list(
    @Query() rawQuery: Record<string, unknown>,
    @Res() res: DownloadResponse,
  ): Promise<void> {
    const query = parseRewriteListQuery(rawQuery);
    const exportFormat = typeof rawQuery.export === 'string' ? rawQuery.export.trim() : '';

    if (exportFormat === 'csv' || exportFormat === 'xlsx') {
      const items = await this.rewrites.collectForExport(query);
      const table = rewriteExportTable(items);
      if (exportFormat === 'csv') {
        const csv = toCsv(table.headers, table.rows);
        res.status(200);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="geomix-rewrites.csv"');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(csv);
        return;
      }
      const xlsx = Buffer.from(toXlsx(table.headers, table.rows));
      res.status(200);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', 'attachment; filename="geomix-rewrites.xlsx"');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(xlsx);
      return;
    }

    res.status(200).json(ok(await this.rewrites.list(query)));
  }

  @Get('check-url')
  async checkUrl(@Query('url') url?: string) {
    if (!url || typeof url !== 'string' || !url.trim()) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请提供要检查的链接');
    }
    return ok(await this.rewrites.checkDuplicateUrl(url));
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return ok(await this.rewrites.detail(parseRecordId(id)));
  }

  @Post()
  @HttpCode(200)
  async createSingle(@Req() req: unknown, @Body() body: unknown) {
    const input = parseBody(rewriteSingleCreateSchema, body);
    const userId = asHttpRequest(req).auth?.userId;
    return ok(await this.rewrites.createSingle(input, userId));
  }

  @Post('bulk-status')
  @HttpCode(200)
  async bulkStatus(@Body() body: unknown) {
    const input = parseBody(rewriteBulkStatusSchema, body);
    return ok(await this.rewrites.bulkUpdateArticleStatus(input));
  }

  @Post('bulk-delete')
  @HttpCode(200)
  async bulkDelete(@Body() body: unknown) {
    const input = parseBody(rewriteBulkDeleteSchema, body);
    return ok(await this.rewrites.bulkDelete(input.ids));
  }

  @Delete(':id')
  async deleteOne(@Param('id') id: string) {
    return ok(await this.rewrites.bulkDelete([parseRecordId(id)]));
  }
}
