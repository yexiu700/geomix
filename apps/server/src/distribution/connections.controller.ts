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
  BRAND_ID_PATTERN,
  createChannelConnectionSchema,
  ok,
  testChannelConnectionSchema,
  updateChannelConnectionSchema,
  type GeoMarket,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { parseBrandId, parseMarket, requireAuth } from '../brands/brands.http-utils';
import { ApiError } from '../common/api-error';
import { parseBody } from '../common/parse-body';
import { ConnectionsService } from './connections.service';

function parseConnectionId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '渠道连接编号不正确');
  }
  const trimmed = raw.trim();
  if (!BRAND_ID_PATTERN.test(trimmed)) {
    throw new ApiError(400, API_ERROR.BAD_REQUEST, '渠道连接编号不正确');
  }
  return trimmed;
}

function parseOptionalMarket(raw: unknown): GeoMarket | undefined {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined || first === null) return undefined;
  if (typeof first === 'string' && first.trim() === '') return undefined;
  return parseMarket(first);
}

@Controller({ path: 'brands/:brandId/connections', version: '2' })
@UseGuards(AuthGuard)
export class ConnectionsController {
  constructor(@Inject(ConnectionsService) private readonly connections: ConnectionsService) {}

  @Get()
  async list(@Param('brandId') brandIdRaw: string, @Query() query: Record<string, unknown>) {
    const brandId = parseBrandId(brandIdRaw);
    const market = parseOptionalMarket(query?.market);
    return ok(await this.connections.list(brandId, market));
  }

  @Post()
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async create(
    @Req() request: unknown,
    @Param('brandId') brandIdRaw: string,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(brandIdRaw);
    const input = parseBody(createChannelConnectionSchema, body);
    return ok(await this.connections.create(auth.tenantId, brandId, input));
  }

  @Patch(':id')
  @UseGuards(TenantActiveGuard)
  async update(
    @Param('brandId') brandIdRaw: string,
    @Param('id') idRaw: string,
    @Body() body: unknown,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const connectionId = parseConnectionId(idRaw);
    const input = parseBody(updateChannelConnectionSchema, body);
    return ok(await this.connections.update(brandId, connectionId, input));
  }

  @Delete(':id')
  @UseGuards(TenantActiveGuard)
  async remove(
    @Req() request: unknown,
    @Param('brandId') brandIdRaw: string,
    @Param('id') idRaw: string,
  ) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(brandIdRaw);
    const connectionId = parseConnectionId(idRaw);
    return ok(await this.connections.remove(auth.tenantId, brandId, connectionId));
  }

  @Post(':id/test')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async test(
    @Param('brandId') brandIdRaw: string,
    @Param('id') idRaw: string,
    @Body() body: unknown,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const connectionId = parseConnectionId(idRaw);
    const normalizedBody = body === undefined || body === null || body === '' ? {} : body;
    const input = parseBody(testChannelConnectionSchema, normalizedBody);
    return ok(await this.connections.test(brandId, connectionId, input));
  }
}
