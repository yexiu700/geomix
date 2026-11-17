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
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  API_ERROR,
  ARTICLE_ID_PATTERN,
  CrudQueryError,
  articleBulkDeleteSchema,
  articleBulkStatusSchema,
  articleCreateSchema,
  articleManageExportTable,
  articleUpdateSchema,
  articleZipExportSchema,
  ok,
  parseArticleManageQuery,
  toCsv,
  toXlsx,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { ArticlesManageService } from './articles-manage.service';

type DownloadResponse = {
  status(code: number): DownloadResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
};

function parseArticleId(raw: string): string {
  if (!ARTICLE_ID_PATTERN.test(raw)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '文章编号不合法');
  }
  return raw;
}

@Controller('articles')
@UseGuards(AuthGuard, TenantActiveGuard)
export class ArticlesManageController {
  constructor(@Inject(ArticlesManageService) private readonly articles: ArticlesManageService) {}

  @Get()
  async list(
    @Query() rawQuery: Record<string, unknown>,
    @Res() res: DownloadResponse,
  ): Promise<void> {
    let query;
    try {
      query = parseArticleManageQuery(rawQuery);
    } catch (err) {
      if (err instanceof CrudQueryError) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, err.message);
      }
      throw err;
    }

    if (query.export) {
      const items = await this.articles.collectForTableExport(query);
      const table = articleManageExportTable(items);
      if (query.export === 'csv') {
        const csv = toCsv(table.headers, table.rows);
        res.status(200);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="geomix-articles.csv"');
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
      res.setHeader('Content-Disposition', 'attachment; filename="geomix-articles.xlsx"');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(xlsx);
      return;
    }

    res.status(200).json(ok(await this.articles.list(query)));
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return ok(await this.articles.detail(parseArticleId(id)));
  }

  @Post()
  @HttpCode(200)
  async create(@Body() body: unknown) {
    const input = parseBody(articleCreateSchema, body);
    return ok(await this.articles.createManual(input));
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(articleUpdateSchema, body);
    return ok(await this.articles.update(parseArticleId(id), input));
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@Param('id') id: string) {
    return ok(await this.articles.approveOne(parseArticleId(id)));
  }

  @Post('bulk-status')
  @HttpCode(200)
  async bulkStatus(@Body() body: unknown) {
    const input = parseBody(articleBulkStatusSchema, body);
    return ok(await this.articles.bulkStatus(input));
  }

  @Post('bulk-delete')
  @HttpCode(200)
  async bulkDelete(@Body() body: unknown) {
    const input = parseBody(articleBulkDeleteSchema, body);
    return ok(await this.articles.bulkDelete(input.ids));
  }

  @Delete(':id')
  async deleteOne(@Param('id') id: string) {
    return ok(await this.articles.bulkDelete([parseArticleId(id)]));
  }

  @Post('export-zip')
  @HttpCode(200)
  async exportZip(@Body() body: unknown, @Res() res: DownloadResponse): Promise<void> {
    const input = parseBody(articleZipExportSchema, body);
    const archive = await this.articles.exportZip(input);
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(archive.bytes);
  }
}
