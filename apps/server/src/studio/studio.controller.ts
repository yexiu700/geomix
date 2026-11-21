import { randomUUID } from 'node:crypto';
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
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  API_ERROR,
  AccountQueryError,
  BRAND_ID_PATTERN,
  geoArticleListQuerySchema,
  geoArticleStreamSchema,
  geoArticleUpdateSchema,
  geoBatchCreateSchema,
  geoBatchListQuerySchema,
  geoRewriteSectionSchema,
  ok,
  promptPreferenceSchema,
  readIdempotencyKey,
  type GeoMarket,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { parseBrandId, parseMarket, requireAuth } from '../brands/brands.http-utils';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { StudioService, type SseRequestLike, type SseResponseLike } from './studio.service';

function parseEntityId(raw: string, label: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!BRAND_ID_PATTERN.test(value)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, `${label}不合法`);
  }
  return value;
}

function flattenQuery(raw: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === undefined) {
      out[key] = undefined;
    } else if (typeof val === 'string') {
      out[key] = val;
    } else {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, `查询参数 ${key} 格式不正确`);
    }
  }
  return out;
}

function parseOptionalMarket(raw?: string): GeoMarket | undefined {
  if (!raw || !raw.trim()) return undefined;
  return parseMarket(raw.trim());
}

function resolveIdempotencyHeader(req: unknown): string {
  const headers =
    req && typeof req === 'object' && 'headers' in req
      ? ((req as { headers?: Record<string, unknown> }).headers ?? {})
      : {};
  const raw = headers['idempotency-key'] ?? headers['Idempotency-Key'];
  if (raw === undefined || raw === null || raw === '') {
    return `auto_${randomUUID().replace(/-/g, '')}`;
  }
  if (Array.isArray(raw) || typeof raw !== 'string') {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Idempotency-Key 请求头格式不正确');
  }
  try {
    return readIdempotencyKey(raw);
  } catch (err) {
    if (err instanceof AccountQueryError) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, err.message);
    }
    throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Idempotency-Key 请求头格式不正确');
  }
}

@Controller({ path: 'brands/:brandId', version: '2' })
@UseGuards(AuthGuard)
export class BrandStudioController {
  constructor(@Inject(StudioService) private readonly studio: StudioService) {}

  @Get('articles')
  async listArticles(
    @Param('brandId') brandIdRaw: string,
    @Query() query: Record<string, unknown>,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const flat = flattenQuery(query);
    const parsed = parseBody(geoArticleListQuerySchema, flat);
    return ok(await this.studio.listArticles(brandId, parsed));
  }

  @Post('articles/stream')
  @UseGuards(TenantActiveGuard)
  async streamArticle(
    @Req() req: unknown,
    @Res() res: SseResponseLike,
    @Param('brandId') brandIdRaw: string,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(req);
    const brandId = parseBrandId(brandIdRaw);
    const flat = flattenQuery(query);
    const queryMarket = parseOptionalMarket(flat.market);
    const idempotencyKey = resolveIdempotencyHeader(req);
    const parsed = parseBody(geoArticleStreamSchema, body);
    if (queryMarket && queryMarket !== parsed.market) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '查询参数 market 与请求体不一致');
    }

    // Phase 1: all validation, compliance 403/40302, idempotency, and billing reserve 402/40201
    // happen BEFORE writing any SSE headers!
    const prepared = await this.studio.prepareStreamArticle(brandId, parsed, idempotencyKey, auth);

    // Phase 2: SSE headers + streaming + atomic settle-or-refund
    await this.studio.executeStreamArticle(prepared, res, req as SseRequestLike);
  }

  @Post('articles/batch')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async createBatchJob(
    @Req() req: unknown,
    @Param('brandId') brandIdRaw: string,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(req);
    const brandId = parseBrandId(brandIdRaw);
    const flat = flattenQuery(query);
    const queryMarket = parseOptionalMarket(flat.market);
    const idempotencyKey = resolveIdempotencyHeader(req);
    const parsed = parseBody(geoBatchCreateSchema, body);
    if (queryMarket && queryMarket !== parsed.market) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '查询参数 market 与请求体不一致');
    }
    return ok(await this.studio.createBatchJob(brandId, parsed, idempotencyKey, auth));
  }

  @Get('batch-jobs')
  async listBatchJobs(
    @Param('brandId') brandIdRaw: string,
    @Query() query: Record<string, unknown>,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const flat = flattenQuery(query);
    const parsed = parseBody(geoBatchListQuerySchema, flat);
    return ok(await this.studio.listBatchJobs(brandId, parsed));
  }

  @Get('batch-jobs/:jobId')
  async getBatchJob(
    @Param('brandId') brandIdRaw: string,
    @Param('jobId') jobIdRaw: string,
    @Query() query: Record<string, unknown>,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const jobId = parseEntityId(jobIdRaw, '批量任务编号');
    const flat = flattenQuery(query);
    const market = parseOptionalMarket(flat.market);
    return ok(await this.studio.getBatchJob(brandId, jobId, market));
  }
}

@Controller({ path: 'articles', version: '2' })
@UseGuards(AuthGuard)
export class ArticlesController {
  constructor(@Inject(StudioService) private readonly studio: StudioService) {}

  @Get(':id')
  async getArticle(@Param('id') idRaw: string) {
    const id = parseEntityId(idRaw, '文章编号');
    return ok(await this.studio.getArticle(id));
  }

  @Patch(':id')
  @UseGuards(TenantActiveGuard)
  async updateArticle(@Req() req: unknown, @Param('id') idRaw: string, @Body() body: unknown) {
    const auth = requireAuth(req);
    const id = parseEntityId(idRaw, '文章编号');
    const parsed = parseBody(geoArticleUpdateSchema, body);
    return ok(await this.studio.updateArticle(id, parsed, auth));
  }

  @Delete(':id')
  @UseGuards(TenantActiveGuard)
  async deleteArticle(@Param('id') idRaw: string) {
    const id = parseEntityId(idRaw, '文章编号');
    return ok(await this.studio.deleteArticle(id));
  }

  @Post(':id/rewrite-section')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async rewriteSection(@Req() req: unknown, @Param('id') idRaw: string, @Body() body: unknown) {
    const auth = requireAuth(req);
    const id = parseEntityId(idRaw, '文章编号');
    const parsed = parseBody(geoRewriteSectionSchema, body);
    return ok(await this.studio.rewriteSection(id, parsed, auth));
  }
}

@Controller({ path: 'prompt-preferences', version: '2' })
@UseGuards(AuthGuard)
export class PromptPreferencesController {
  constructor(@Inject(StudioService) private readonly studio: StudioService) {}

  @Get()
  async getPreferences(@Req() req: unknown) {
    const auth = requireAuth(req);
    return ok(await this.studio.getPromptPreferences(auth.tenantId));
  }

  @Put()
  @UseGuards(TenantActiveGuard)
  async upsertPreferences(@Req() req: unknown, @Body() body: unknown) {
    const auth = requireAuth(req);
    const parsed = parseBody(promptPreferenceSchema, body);
    return ok(await this.studio.upsertPromptPreferences(auth.tenantId, parsed, auth));
  }
}
