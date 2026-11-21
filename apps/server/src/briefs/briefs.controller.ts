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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  API_ERROR,
  GEO_BRIEF_ID_PATTERN,
  geoBriefGenerateSchema,
  geoBriefListQuerySchema,
  geoBriefUpdateSchema,
  ok,
  type GeoMarket,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { parseBrandId, parseMarket, requireAuth } from '../brands/brands.http-utils';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { BriefsService } from './briefs.service';

function parseBriefId(raw: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!GEO_BRIEF_ID_PATTERN.test(value)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '写作意见编号不合法');
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

@Controller({ path: 'brands/:brandId/briefs', version: '2' })
@UseGuards(AuthGuard)
export class BrandBriefsController {
  constructor(@Inject(BriefsService) private readonly briefs: BriefsService) {}

  @Get()
  async list(@Param('brandId') brandIdRaw: string, @Query() query: Record<string, unknown>) {
    const brandId = parseBrandId(brandIdRaw);
    const flat = flattenQuery(query);
    const parsed = parseBody(geoBriefListQuerySchema, flat);
    return ok(await this.briefs.list(brandId, parsed));
  }

  @Post('generate')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async generate(
    @Req() req: unknown,
    @Param('brandId') brandIdRaw: string,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(req);
    const brandId = parseBrandId(brandIdRaw);
    const flat = flattenQuery(query);
    const queryMarket = parseOptionalMarket(flat.market);
    const input = parseBody(geoBriefGenerateSchema, body);
    return ok(await this.briefs.generate(auth.tenantId, auth.userId, brandId, input, queryMarket));
  }
}

@Controller({ path: 'briefs', version: '2' })
@UseGuards(AuthGuard)
export class BriefsController {
  constructor(@Inject(BriefsService) private readonly briefs: BriefsService) {}

  @Get(':id')
  async getById(@Param('id') idRaw: string) {
    const id = parseBriefId(idRaw);
    return ok(await this.briefs.getById(id));
  }

  @Patch(':id')
  @UseGuards(TenantActiveGuard)
  async update(@Req() req: unknown, @Param('id') idRaw: string, @Body() body: unknown) {
    const auth = requireAuth(req);
    const id = parseBriefId(idRaw);
    const input = parseBody(geoBriefUpdateSchema, body);
    return ok(await this.briefs.update(auth.tenantId, auth.userId, id, input));
  }
}
