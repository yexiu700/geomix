import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  BRAND_ID_PATTERN,
  GEO_MARKETS,
  createBrandSchema,
  ok,
  upsertBrandMarketSchema,
  type GeoMarket,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { asHttpRequest } from '../auth/http-request';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { BrandsService } from './brands.service';

@Controller({ path: 'brands', version: '2' })
@UseGuards(AuthGuard, TenantActiveGuard)
export class BrandsController {
  constructor(@Inject(BrandsService) private readonly brands: BrandsService) {}

  @Get()
  async list() {
    return ok(await this.brands.list());
  }

  @Post()
  @HttpCode(200)
  async create(@Req() request: unknown, @Body() body: unknown) {
    const auth = requireAuth(request);
    const input = parseBody(createBrandSchema, body);
    return ok(await this.brands.create(auth.tenantId, auth.userId, input));
  }

  @Post(':id/markets/:market')
  @HttpCode(200)
  async enableMarket(
    @Req() request: unknown,
    @Param('id') id: string,
    @Param('market') rawMarket: string,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(id);
    const market = parseMarket(rawMarket);
    const normalizedBody = body && typeof body === 'object' ? body : {};
    const input = parseBody(upsertBrandMarketSchema, normalizedBody);
    return ok(await this.brands.enableMarket(auth.tenantId, auth.userId, brandId, market, input));
  }
}

function requireAuth(request: unknown): { tenantId: string; userId: string } {
  const http = asHttpRequest(request);
  if (!http.auth) {
    throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '未登录');
  }
  return { tenantId: http.auth.tenantId, userId: http.auth.userId };
}

function parseBrandId(raw: string): string {
  const trimmed = raw.trim();
  if (!BRAND_ID_PATTERN.test(trimmed)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '品牌编号不正确');
  }
  return trimmed;
}

function parseMarket(raw: string): GeoMarket {
  const upper = raw.trim().toUpperCase();
  if ((GEO_MARKETS as readonly string[]).includes(upper)) {
    return upper as GeoMarket;
  }
  throw new ApiError(400, API_ERROR.BAD_REQUEST, '市场参数仅支持 CN 或 GLOBAL');
}
