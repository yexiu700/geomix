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
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  API_ERROR,
  AccountQueryError,
  CHANNEL_PROVIDERS,
  SUPPORTED_LOCALE_CODES,
  createDistributionVariantsSchema,
  createPrShareLinkSchema,
  ok,
  publishDistributionTaskSchema,
  readIdempotencyKey,
  retestScheduleConfigSchema,
  updateDistributionTaskSchema,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { requireAuth } from '../brands/brands.http-utils';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { flattenQuery, parseEntityId } from '../studio/studio.controller';
import { DistributionService } from './distribution.service';
import { retestBudgetEstimateQuerySchema } from './retest-scheduler.service';

const articlePreflightBodySchema = z
  .object({
    title: z.string().trim().max(300).optional(),
    contentMarkdown: z.string().max(150_000).optional(),
    provider: z.enum(CHANNEL_PROVIDERS).nullable().optional(),
    targetLocale: z.enum(SUPPORTED_LOCALE_CODES).nullable().optional(),
    variantSlug: z.string().trim().max(160).nullable().optional(),
    variantMetaDesc: z.string().trim().max(320).nullable().optional(),
  })
  .optional()
  .default({});

function normalizeOptionalBody(body: unknown): unknown {
  return body === undefined || body === null || body === '' ? {} : body;
}

function parseOptionalIdempotencyHeader(req: unknown): string | undefined {
  const headers =
    req && typeof req === 'object' && 'headers' in req
      ? ((req as { headers?: Record<string, unknown> }).headers ?? {})
      : {};
  const raw = headers['idempotency-key'] ?? headers['Idempotency-Key'];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (Array.isArray(raw) || typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Idempotency-Key 请求头格式不正确');
  }
  try {
    return readIdempotencyKey(raw);
  } catch (error) {
    if (error instanceof AccountQueryError) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, error.message);
    }
    throw error;
  }
}

@Controller({ version: '2' })
@UseGuards(AuthGuard)
export class DistributionController {
  constructor(@Inject(DistributionService) private readonly distribution: DistributionService) {}

  @Post('articles/:articleId/preflight')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async preflightArticle(
    @Req() request: unknown,
    @Param('articleId') articleIdRaw: string,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const articleId = parseEntityId(articleIdRaw, '文章编号');
    const overrides = parseBody(articlePreflightBodySchema, normalizeOptionalBody(body));
    return ok(await this.distribution.preflightArticle(articleId, auth, overrides));
  }

  @Get('articles/:articleId/distributions')
  async listArticleDistributions(@Param('articleId') articleIdRaw: string) {
    const articleId = parseEntityId(articleIdRaw, '文章编号');
    return ok(await this.distribution.listArticleDistributions(articleId));
  }

  @Post('articles/:articleId/distributions/variants')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async generateVariants(
    @Req() request: unknown,
    @Param('articleId') articleIdRaw: string,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const articleId = parseEntityId(articleIdRaw, '文章编号');
    const input = parseBody(createDistributionVariantsSchema, body);
    const idempotencyKey = parseOptionalIdempotencyHeader(request);
    return ok(await this.distribution.generateVariants(articleId, input, auth, idempotencyKey));
  }

  @Post('articles/:articleId/distributions/variant-jobs')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async createVariantJob(
    @Req() request: unknown,
    @Param('articleId') articleIdRaw: string,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const articleId = parseEntityId(articleIdRaw, '文章编号');
    const input = parseBody(createDistributionVariantsSchema, body);
    const idempotencyKey = parseOptionalIdempotencyHeader(request);
    return ok(await this.distribution.createVariantJob(articleId, input, auth, idempotencyKey));
  }

  @Get('articles/:articleId/distributions/variant-jobs')
  async listVariantJobs(@Param('articleId') articleIdRaw: string) {
    const articleId = parseEntityId(articleIdRaw, '文章编号');
    return ok(await this.distribution.listVariantJobs(articleId));
  }

  @Get('articles/:articleId/distributions/variant-jobs/:jobId')
  async getVariantJob(@Param('articleId') articleIdRaw: string, @Param('jobId') jobIdRaw: string) {
    const articleId = parseEntityId(articleIdRaw, '文章编号');
    const jobId = parseEntityId(jobIdRaw, '变体生成任务编号');
    return ok(await this.distribution.getVariantJob(articleId, jobId));
  }

  @Patch('distributions/:taskId')
  @UseGuards(TenantActiveGuard)
  async updateTask(@Param('taskId') taskIdRaw: string, @Body() body: unknown) {
    const taskId = parseEntityId(taskIdRaw, '分发任务编号');
    const input = parseBody(updateDistributionTaskSchema, body);
    return ok(await this.distribution.updateTask(taskId, input));
  }

  @Post('distributions/:taskId/publish')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async publishTask(
    @Req() request: unknown,
    @Param('taskId') taskIdRaw: string,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const taskId = parseEntityId(taskIdRaw, '分发任务编号');
    const input = parseBody(publishDistributionTaskSchema, normalizeOptionalBody(body));
    const idempotencyKey = parseOptionalIdempotencyHeader(request);
    return ok(await this.distribution.publishTask(taskId, input, auth, idempotencyKey));
  }

  @Post('distributions/:taskId/pr-share')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async createPrShare(
    @Req() request: unknown,
    @Param('taskId') taskIdRaw: string,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const taskId = parseEntityId(taskIdRaw, '分发任务编号');
    const input = parseBody(createPrShareLinkSchema, normalizeOptionalBody(body));
    return ok(await this.distribution.createPrShare(taskId, input, auth));
  }

  @Delete('distributions/:taskId/pr-share')
  @UseGuards(TenantActiveGuard)
  async revokePrShare(@Param('taskId') taskIdRaw: string) {
    const taskId = parseEntityId(taskIdRaw, '分发任务编号');
    return ok(await this.distribution.revokePrShare(taskId));
  }

  @Post('publish-records/:id/crawl-probe')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async triggerCrawlProbe(@Req() request: unknown, @Param('id') idRaw: string) {
    const auth = requireAuth(request);
    const publishRecordId = parseEntityId(idRaw, '发布记录编号');
    return ok(await this.distribution.triggerCrawlProbe(publishRecordId, auth));
  }

  @Get('publish-records/:id/retest-budget')
  async getRetestBudget(
    @Req() request: unknown,
    @Param('id') idRaw: string,
    @Query() query: Record<string, unknown>,
  ) {
    const auth = requireAuth(request);
    const publishRecordId = parseEntityId(idRaw, '发布记录编号');
    const parsed = parseBody(retestBudgetEstimateQuerySchema, flattenQuery(query));
    return ok(await this.distribution.estimateRetestBudget(publishRecordId, auth, parsed));
  }

  @Patch('publish-records/:id/retest-schedules')
  @UseGuards(TenantActiveGuard)
  async updateRetestSchedules(@Param('id') idRaw: string, @Body() body: unknown) {
    const publishRecordId = parseEntityId(idRaw, '发布记录编号');
    const input = parseBody(retestScheduleConfigSchema, body);
    return ok(await this.distribution.updateRetestSchedules(publishRecordId, input));
  }
}
