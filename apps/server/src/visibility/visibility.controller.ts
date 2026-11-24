import { randomUUID } from 'node:crypto';
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
  UseGuards,
} from '@nestjs/common';
import {
  API_ERROR,
  AccountQueryError,
  VISIBILITY_ID_PATTERN,
  nearMissQuerySchema,
  ok,
  readIdempotencyKey,
  visibilityRunBulkDeleteSchema,
  visibilityRunV2CreateSchema,
  visibilityV2CitationQuerySchema,
  visibilityV2OpportunitiesQuerySchema,
  visibilityV2OverviewQuerySchema,
  visibilityV2RunListQuerySchema,
  type CitationSourceKind,
  type GeoMarket,
  type VisibilityEngineKey,
  type VisibilityV2CitationQuery,
  type VisibilityV2OpportunitiesQuery,
  type VisibilityV2OverviewQuery,
  type VisibilityV2RunListQuery,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { parseBrandId, parseMarket, requireAuth } from '../brands/brands.http-utils';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { VisibilityNearMissService } from './visibility-near-miss.service';
import { VisibilityService } from './visibility.service';

function readVisibilityId(raw: string, label = '编号'): string {
  const value = raw.trim();
  if (!VISIBILITY_ID_PATTERN.test(value)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, `${label}不合法`);
  }
  return value;
}

function parseOptionalMarket(raw?: unknown): GeoMarket | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '市场参数仅支持 CN 或 GLOBAL');
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return parseMarket(trimmed);
}

function resolveIdempotencyHeader(req: unknown): string {
  const http = asHttpRequest(req);
  const raw = http.header('idempotency-key') ?? http.header('Idempotency-Key');
  if (raw === undefined) {
    return `auto_${randomUUID()}`;
  }
  try {
    return readIdempotencyKey(raw);
  } catch (error) {
    if (error instanceof AccountQueryError) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '请求头缺少合法的 Idempotency-Key（8-160 位字母数字、冒号、下划线或连字符）',
      );
    }
    throw error;
  }
}

function flattenQuery(raw: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === undefined) {
      out[key] = undefined;
    } else if (typeof val === 'string') {
      out[key] = val;
    } else if (
      Array.isArray(val) &&
      val.length > 0 &&
      val.every((item) => typeof item === 'string')
    ) {
      out[key] = val[0];
    } else {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, `查询参数 ${key} 格式不正确`);
    }
  }
  return out;
}

@Controller({ path: 'brands/:brandId/visibility', version: '2' })
@UseGuards(AuthGuard)
export class VisibilityController {
  constructor(
    @Inject(VisibilityService) private readonly visibility: VisibilityService,
    @Inject(VisibilityNearMissService) private readonly nearMissService: VisibilityNearMissService,
  ) {}

  // ===================== Engines =====================

  @Get('engines')
  async listEngines(@Param('brandId') brandIdRaw: string, @Query() query: Record<string, unknown>) {
    const brandId = parseBrandId(brandIdRaw);
    const flat = flattenQuery(query);
    const market = parseOptionalMarket(flat.market);
    return ok(await this.visibility.listEngines(brandId, market));
  }

  // ===================== Runs =====================

  @Get('runs')
  async listRuns(@Param('brandId') brandIdRaw: string, @Query() query: Record<string, unknown>) {
    const brandId = parseBrandId(brandIdRaw);
    const parsed = parseBody(visibilityV2RunListQuerySchema, flattenQuery(query));
    const normalized: VisibilityV2RunListQuery = {
      ...(parsed.market !== undefined ? { market: parsed.market } : {}),
      page: parsed.page,
      pageSize: parsed.pageSize,
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
      ...(parsed.keyword !== undefined ? { keyword: parsed.keyword } : {}),
    };
    return ok(await this.visibility.listRuns(brandId, normalized));
  }

  @Get('runs/:runId')
  async getRunDetail(
    @Param('brandId') brandIdRaw: string,
    @Param('runId') runIdRaw: string,
    @Query() query: Record<string, unknown>,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const runId = readVisibilityId(runIdRaw, '监测任务编号');
    const market = parseOptionalMarket(flattenQuery(query).market);
    return ok(await this.visibility.getRunDetail(brandId, runId, market));
  }

  @Post('runs')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async createRun(
    @Param('brandId') brandIdRaw: string,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
    @Req() req: unknown,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const { userId } = requireAuth(req);
    const idempotencyKey = resolveIdempotencyHeader(req);
    const queryMarket = parseOptionalMarket(flattenQuery(query).market);
    const parsed = parseBody(visibilityRunV2CreateSchema, body);
    return ok(
      await this.visibility.createRun(brandId, parsed, idempotencyKey, userId, queryMarket),
    );
  }

  @Post('runs/bulk-delete')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async bulkDeleteRuns(
    @Param('brandId') brandIdRaw: string,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const market = parseOptionalMarket(flattenQuery(query).market);
    const parsed = parseBody(visibilityRunBulkDeleteSchema, body);
    return ok(await this.visibility.bulkDeleteRuns(brandId, parsed.ids, market));
  }

  @Post('runs/:runId/pause')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async pauseRun(
    @Param('brandId') brandIdRaw: string,
    @Param('runId') runIdRaw: string,
    @Query() query: Record<string, unknown>,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const runId = readVisibilityId(runIdRaw, '监测任务编号');
    const market = parseOptionalMarket(flattenQuery(query).market);
    return ok(await this.visibility.pauseRun(brandId, runId, market));
  }

  @Post('runs/:runId/resume')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async resumeRun(
    @Param('brandId') brandIdRaw: string,
    @Param('runId') runIdRaw: string,
    @Query() query: Record<string, unknown>,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const runId = readVisibilityId(runIdRaw, '监测任务编号');
    const market = parseOptionalMarket(flattenQuery(query).market);
    return ok(await this.visibility.resumeRun(brandId, runId, market));
  }

  @Post('runs/:runId/cancel')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async cancelRun(
    @Param('brandId') brandIdRaw: string,
    @Param('runId') runIdRaw: string,
    @Query() query: Record<string, unknown>,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const runId = readVisibilityId(runIdRaw, '监测任务编号');
    const market = parseOptionalMarket(flattenQuery(query).market);
    return ok(await this.visibility.cancelRun(brandId, runId, market));
  }

  @Delete('runs/:runId')
  @UseGuards(TenantActiveGuard)
  async deleteRun(
    @Param('brandId') brandIdRaw: string,
    @Param('runId') runIdRaw: string,
    @Query() query: Record<string, unknown>,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const runId = readVisibilityId(runIdRaw, '监测任务编号');
    const market = parseOptionalMarket(flattenQuery(query).market);
    return ok(await this.visibility.deleteRun(brandId, runId, market));
  }

  // ===================== Analytics =====================

  @Get('overview')
  async overview(@Param('brandId') brandIdRaw: string, @Query() query: Record<string, unknown>) {
    const brandId = parseBrandId(brandIdRaw);
    const parsed = parseBody(visibilityV2OverviewQuerySchema, flattenQuery(query));
    const normalized: VisibilityV2OverviewQuery = {
      ...(parsed.market !== undefined ? { market: parsed.market } : {}),
      engine: parsed.engine as VisibilityEngineKey | undefined,
      days: parsed.days,
      ...(parsed.from !== undefined ? { from: parsed.from } : {}),
      ...(parsed.to !== undefined ? { to: parsed.to } : {}),
    };
    return ok(await this.visibility.overview(brandId, normalized));
  }

  @Get('citations')
  async citations(@Param('brandId') brandIdRaw: string, @Query() query: Record<string, unknown>) {
    const brandId = parseBrandId(brandIdRaw);
    const parsed = parseBody(visibilityV2CitationQuerySchema, flattenQuery(query));
    const normalized: VisibilityV2CitationQuery = {
      ...(parsed.market !== undefined ? { market: parsed.market } : {}),
      engine: parsed.engine as VisibilityEngineKey | undefined,
      sourceKind: parsed.sourceKind as CitationSourceKind | undefined,
      days: parsed.days,
      ...(parsed.from !== undefined ? { from: parsed.from } : {}),
      ...(parsed.to !== undefined ? { to: parsed.to } : {}),
      page: parsed.page,
      pageSize: parsed.pageSize,
    };
    return ok(await this.visibility.citations(brandId, normalized));
  }

  @Get('opportunities')
  async opportunities(
    @Param('brandId') brandIdRaw: string,
    @Query() query: Record<string, unknown>,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const parsed = parseBody(visibilityV2OpportunitiesQuerySchema, flattenQuery(query));
    const normalized: VisibilityV2OpportunitiesQuery = {
      ...(parsed.market !== undefined ? { market: parsed.market } : {}),
      engine: parsed.engine as VisibilityEngineKey | undefined,
      days: parsed.days,
      ...(parsed.from !== undefined ? { from: parsed.from } : {}),
      ...(parsed.to !== undefined ? { to: parsed.to } : {}),
      limit: parsed.limit,
    };
    return ok(await this.visibility.opportunities(brandId, normalized));
  }

  @Get('near-miss')
  async nearMiss(@Param('brandId') brandIdRaw: string, @Query() query: Record<string, unknown>) {
    const brandId = parseBrandId(brandIdRaw);
    const flat = flattenQuery(query);
    const cleaned: Record<string, string | undefined> = {};
    for (const [key, val] of Object.entries(flat)) {
      const trimmed = val?.trim();
      if (!trimmed) continue;
      cleaned[key] = key === 'market' ? trimmed.toUpperCase() : trimmed;
    }
    const parsed = parseBody(nearMissQuerySchema, cleaned);
    return ok(await this.nearMissService.listNearMiss(brandId, parsed));
  }
}
