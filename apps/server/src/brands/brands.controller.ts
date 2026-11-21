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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  createBrandSchema,
  ok,
  updateBrandMarketSchema,
  updateBrandSchema,
  upsertBrandMarketSchema,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { clientAddress } from '../auth/client-address';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { parseBody } from '../common/parse-body';
import { parseBrandId, parseMarket, requireAuth } from './brands.http-utils';
import { BrandsService } from './brands.service';

@Controller({ path: 'brands', version: '2' })
@UseGuards(AuthGuard)
export class BrandsController {
  constructor(@Inject(BrandsService) private readonly brands: BrandsService) {}

  @Get()
  async list() {
    return ok(await this.brands.list());
  }

  @Post()
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async create(@Req() request: unknown, @Body() body: unknown) {
    const auth = requireAuth(request);
    const input = parseBody(createBrandSchema, body);
    return ok(await this.brands.create(auth.tenantId, auth.userId, input, clientAddress(request)));
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    const brandId = parseBrandId(id);
    return ok(await this.brands.getById(brandId));
  }

  @Patch(':id')
  @UseGuards(TenantActiveGuard)
  async update(@Req() request: unknown, @Param('id') id: string, @Body() body: unknown) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(id);
    const input = parseBody(updateBrandSchema, body);
    return ok(
      await this.brands.update(auth.tenantId, auth.userId, brandId, input, clientAddress(request)),
    );
  }

  @Delete(':id')
  @UseGuards(TenantActiveGuard)
  async remove(@Req() request: unknown, @Param('id') id: string) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(id);
    return ok(await this.brands.remove(auth.tenantId, brandId));
  }

  @Post(':id/markets/:market')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
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

  @Patch(':id/markets/:market')
  @UseGuards(TenantActiveGuard)
  async updateMarket(
    @Req() request: unknown,
    @Param('id') id: string,
    @Param('market') rawMarket: string,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(id);
    const market = parseMarket(rawMarket);
    const input = parseBody(updateBrandMarketSchema, body);
    return ok(await this.brands.updateMarket(auth.tenantId, auth.userId, brandId, market, input));
  }
}
