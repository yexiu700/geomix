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
  parseRewriteBatchListQuery,
  rewriteBatchBulkDeleteSchema,
  rewriteBatchCreateSchema,
  rewriteBatchExportTable,
  toCsv,
  toXlsx,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { RewriteBatchesService } from './rewrite-batches.service';

type DownloadResponse = {
  status(code: number): DownloadResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
};

function parseBatchId(raw: string): string {
  const id = raw.trim();
  if (!REWRITE_ID_PATTERN.test(id)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '批量复刻任务编号不合法');
  }
  return id;
}

@Controller('rewrite-batches')
@UseGuards(AuthGuard, TenantActiveGuard)
export class RewriteBatchesController {
  constructor(@Inject(RewriteBatchesService) private readonly batches: RewriteBatchesService) {}

  @Get()
  async list(
    @Query() rawQuery: Record<string, unknown>,
    @Res() res: DownloadResponse,
  ): Promise<void> {
    const query = parseRewriteBatchListQuery(rawQuery);
    const exportFormat = typeof rawQuery.export === 'string' ? rawQuery.export.trim() : '';

    if (exportFormat === 'csv' || exportFormat === 'xlsx') {
      const items = await this.batches.collectForExport(query);
      const table = rewriteBatchExportTable(items);
      if (exportFormat === 'csv') {
        const csv = toCsv(table.headers, table.rows);
        res.status(200);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="geomix-rewrite-batches.csv"');
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
      res.setHeader('Content-Disposition', 'attachment; filename="geomix-rewrite-batches.xlsx"');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(xlsx);
      return;
    }

    res.status(200).json(ok(await this.batches.list(query)));
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return ok(await this.batches.detail(parseBatchId(id)));
  }

  @Post()
  @HttpCode(200)
  async create(@Req() req: unknown, @Body() body: unknown) {
    const input = parseBody(rewriteBatchCreateSchema, body);
    const userId = asHttpRequest(req).auth?.userId;
    return ok(await this.batches.create(input, userId));
  }

  @Post(':id/pause')
  @HttpCode(200)
  async pause(@Param('id') id: string) {
    return ok(await this.batches.pause(parseBatchId(id)));
  }

  @Post(':id/resume')
  @HttpCode(200)
  async resume(@Param('id') id: string) {
    return ok(await this.batches.resume(parseBatchId(id)));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string) {
    return ok(await this.batches.cancel(parseBatchId(id)));
  }

  @Post('bulk-delete')
  @HttpCode(200)
  async bulkDelete(@Body() body: unknown) {
    const input = parseBody(rewriteBatchBulkDeleteSchema, body);
    return ok(await this.batches.bulkDelete(input.ids));
  }

  @Delete(':id')
  async deleteOne(@Param('id') id: string) {
    return ok(await this.batches.bulkDelete([parseBatchId(id)]));
  }
}
