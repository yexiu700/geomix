import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { actionHomeQuerySchema, ok, publishRecordRetestSchema } from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { parseBrandId, requireAuth } from '../brands/brands.http-utils';
import { parseBody } from '../common/parse-body';
import { GeoDeliveryService } from './geo-delivery.service';
import { flattenQuery, parseEntityId, resolveIdempotencyHeader } from './studio.controller';

@Controller({ path: 'publish-records', version: '2' })
@UseGuards(AuthGuard)
export class PublishRecordsController {
  constructor(@Inject(GeoDeliveryService) private readonly delivery: GeoDeliveryService) {}

  @Post(':id/retest')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async retestPublishRecord(
    @Req() req: unknown,
    @Param('id') idRaw: string,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(req);
    const id = parseEntityId(idRaw, '发布记录编号');
    const idempotencyKey = resolveIdempotencyHeader(req);
    const rawBody = body === undefined || body === null || body === '' ? {} : body;
    const parsed = parseBody(publishRecordRetestSchema, rawBody);
    return ok(await this.delivery.retestPublishRecord(id, parsed, idempotencyKey, auth));
  }
}

@Controller({ path: 'brands/:brandId/home', version: '2' })
@UseGuards(AuthGuard)
export class HomeController {
  constructor(@Inject(GeoDeliveryService) private readonly delivery: GeoDeliveryService) {}

  @Get()
  async getActionHome(
    @Param('brandId') brandIdRaw: string,
    @Query() query: Record<string, unknown>,
  ) {
    const brandId = parseBrandId(brandIdRaw);
    const flat = flattenQuery(query);
    const parsed = parseBody(actionHomeQuerySchema, flat);
    return ok(await this.delivery.getActionHome(brandId, parsed));
  }
}
