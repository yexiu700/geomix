import {
  Body,
  Controller,
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
  CATEGORY_ID,
  CategoryQueryError,
  articleCategoryBulkSchema,
  articleCategoryInputSchema,
  categoryExportFilename,
  categoryExportMime,
  categoryExportTable,
  ok,
  parseArticleListQuery,
  parseCategoryListQuery,
  toCsv,
  toXlsx,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { CategoriesService } from './categories.service';

@Controller('writing/categories')
@UseGuards(AuthGuard, TenantActiveGuard)
export class CategoriesController {
  constructor(@Inject(CategoriesService) private readonly categories: CategoriesService) {}

  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    const parsed = parseQuery(query);
    if (!parsed.export) {
      response.status(200).json(ok(await this.categories.page(parsed)));
      return;
    }
    const table = categoryExportTable(await this.categories.collect(parsed));
    const body =
      parsed.export === 'csv'
        ? toCsv(table.headers, table.rows)
        : Buffer.from(toXlsx(table.headers, table.rows));
    response.status(200);
    response.setHeader('content-type', categoryExportMime(parsed.export));
    response.setHeader(
      'content-disposition',
      `attachment; filename="${categoryExportFilename(parsed.export)}"`,
    );
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.send(body);
  }

  @Get(':id')
  async one(@Param('id') id: string) {
    return ok(await this.categories.one(readId(id)));
  }

  @Post()
  @HttpCode(200)
  async create(@Body() body: unknown) {
    return ok(await this.categories.create(parseBody(articleCategoryInputSchema, body)));
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    return ok(
      await this.categories.update(readId(id), parseBody(articleCategoryInputSchema, body)),
    );
  }

  @Post('bulk')
  @HttpCode(200)
  async bulk(@Body() body: unknown) {
    const input = parseBody(articleCategoryBulkSchema, body);
    return ok(await this.categories.remove(input.ids));
  }
}

@Controller('writing/articles')
@UseGuards(AuthGuard, TenantActiveGuard)
export class ArticlesController {
  constructor(@Inject(CategoriesService) private readonly categories: CategoriesService) {}

  @Get()
  async list(@Query() query: Record<string, unknown>) {
    return ok(await this.categories.articles(parseArticles(query)));
  }
}

type DownloadResponse = {
  status(code: number): DownloadResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body: string | Buffer): void;
};

function parseQuery(query: Record<string, unknown>) {
  return parseChecked(query, parseCategoryListQuery);
}

function parseArticles(query: Record<string, unknown>) {
  return parseChecked(query, parseArticleListQuery);
}

function parseChecked<T>(
  query: Record<string, unknown>,
  parse: (input: Record<string, unknown>) => T,
): T {
  try {
    return parse(query);
  } catch (error) {
    if (error instanceof CategoryQueryError) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, error.message);
    }
    throw error;
  }
}

function readId(id: string): string {
  if (!CATEGORY_ID.test(id)) throw new ApiError(400, API_ERROR.BAD_REQUEST, '分类编号不正确');
  return id;
}
