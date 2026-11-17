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
import {
  API_ERROR,
  AUTH_ERROR,
  AccountQueryError,
  VISIBILITY_ID_PATTERN,
  ok,
  parseVisibilityRunListQuery,
  readIdempotencyKey,
  visibilityCitationQuerySchema,
  visibilityOverviewQuerySchema,
  visibilityProfileCreateWithPrefillSchema,
  visibilityProfileUpdateSchema,
  visibilityRunBulkDeleteSchema,
  visibilityRunCreateSchema,
  type CitationSourceKind,
  type VisibilityCitationQuery,
  type VisibilityEngineKey,
  type VisibilityOverviewQuery,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { VisibilityService } from './visibility.service';

function readVisibilityId(raw: string, label = '编号'): string {
  const value = raw.trim();
  if (!VISIBILITY_ID_PATTERN.test(value)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, `${label}不合法`);
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

function requireIdempotencyHeader(req: unknown): string {
  const http = asHttpRequest(req);
  const raw = http.header('idempotency-key') ?? http.header('Idempotency-Key');
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

function flattenQuery(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(raw)) {
    out[key] = Array.isArray(val) ? val[0] : val;
  }
  return out;
}

@Controller('visibility')
@UseGuards(AuthGuard, TenantActiveGuard)
export class VisibilityController {
  constructor(@Inject(VisibilityService) private readonly visibility: VisibilityService) {}

  // ===================== Profiles =====================

  @Get('profiles')
  async listProfiles() {
    return ok(await this.visibility.listProfiles());
  }

  @Get('profiles/:id')
  async getProfile(@Param('id') id: string) {
    return ok(await this.visibility.getProfile(readVisibilityId(id, '监测档案编号')));
  }

  @Post('profiles')
  @HttpCode(200)
  async createProfile(@Body() body: unknown, @Req() req: unknown) {
    const userId = requireUserId(req);
    const parsed = parseBody(visibilityProfileCreateWithPrefillSchema, body);
    return ok(await this.visibility.createProfile(parsed, userId));
  }

  @Patch('profiles/:id')
  async updateProfile(@Param('id') id: string, @Body() body: unknown, @Req() req: unknown) {
    const userId = requireUserId(req);
    const profileId = readVisibilityId(id, '监测档案编号');
    const parsed = parseBody(visibilityProfileUpdateSchema, body);
    return ok(await this.visibility.updateProfile(profileId, parsed, userId));
  }

  @Delete('profiles/:id')
  async deleteProfile(@Param('id') id: string) {
    return ok(await this.visibility.deleteProfile(readVisibilityId(id, '监测档案编号')));
  }

  // ===================== Runs =====================

  @Get('runs')
  async listRuns(@Query() query: Record<string, string | string[] | undefined>) {
    const parsed = parseVisibilityRunListQuery(flattenQuery(query));
    return ok(await this.visibility.listRuns(parsed));
  }

  @Get('runs/:id')
  async getRunDetail(@Param('id') id: string) {
    return ok(await this.visibility.getRunDetail(readVisibilityId(id, '监测任务编号')));
  }

  @Post('runs')
  @HttpCode(200)
  async createRun(@Body() body: unknown, @Req() req: unknown) {
    const userId = requireUserId(req);
    const idempotencyKey = requireIdempotencyHeader(req);
    const parsed = parseBody(visibilityRunCreateSchema, body);
    return ok(await this.visibility.createRun(parsed, idempotencyKey, userId));
  }

  @Post('runs/bulk-delete')
  @HttpCode(200)
  async bulkDeleteRuns(@Body() body: unknown) {
    const parsed = parseBody(visibilityRunBulkDeleteSchema, body);
    return ok(await this.visibility.bulkDeleteRuns(parsed.ids));
  }

  @Post('runs/:id/pause')
  @HttpCode(200)
  async pauseRun(@Param('id') id: string) {
    return ok(await this.visibility.pauseRun(readVisibilityId(id, '监测任务编号')));
  }

  @Post('runs/:id/resume')
  @HttpCode(200)
  async resumeRun(@Param('id') id: string) {
    return ok(await this.visibility.resumeRun(readVisibilityId(id, '监测任务编号')));
  }

  @Post('runs/:id/cancel')
  @HttpCode(200)
  async cancelRun(@Param('id') id: string) {
    return ok(await this.visibility.cancelRun(readVisibilityId(id, '监测任务编号')));
  }

  @Delete('runs/:id')
  async deleteRun(@Param('id') id: string) {
    const runId = readVisibilityId(id, '监测任务编号');
    return ok(await this.visibility.bulkDeleteRuns([runId]));
  }

  // ===================== Analytics =====================

  @Get('overview')
  async overview(@Query() query: Record<string, string | string[] | undefined>) {
    const parsed = parseBody(visibilityOverviewQuerySchema, flattenQuery(query));
    const normalized: VisibilityOverviewQuery = {
      profileId: parsed.profileId,
      engine: parsed.engine as VisibilityEngineKey | undefined,
      days: parsed.days,
      from: parsed.from,
      to: parsed.to,
    };
    return ok(await this.visibility.overview(normalized));
  }

  @Get('citations')
  async citations(@Query() query: Record<string, string | string[] | undefined>) {
    const parsed = parseBody(visibilityCitationQuerySchema, flattenQuery(query));
    const normalized: VisibilityCitationQuery = {
      profileId: parsed.profileId,
      engine: parsed.engine as VisibilityEngineKey | undefined,
      sourceKind: parsed.sourceKind as CitationSourceKind | undefined,
      days: parsed.days,
      ...(parsed.from !== undefined ? { from: parsed.from } : {}),
      ...(parsed.to !== undefined ? { to: parsed.to } : {}),
      page: parsed.page,
      pageSize: parsed.pageSize,
    };
    return ok(await this.visibility.citations(normalized));
  }
}
