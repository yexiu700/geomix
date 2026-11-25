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
import { createProductLineSchema, ok, updateProductLineSchema } from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { parseBody } from '../common/parse-body';
import { BrandProductLinesService } from './brand-product-lines.service';
import { parseBrandId, parseProductLineId, requireAuth } from './brands.http-utils';

@Controller({ path: 'brands', version: '2' })
@UseGuards(AuthGuard)
export class BrandProductLinesController {
  constructor(
    @Inject(BrandProductLinesService)
    private readonly productLines: BrandProductLinesService,
  ) {}

  @Get(':id/product-lines')
  async list(@Param('id') id: string) {
    const brandId = parseBrandId(id);
    return ok(await this.productLines.list(brandId));
  }

  @Post(':id/product-lines')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async create(@Req() request: unknown, @Param('id') id: string, @Body() body: unknown) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(id);
    const input = parseBody(createProductLineSchema, body);
    return ok(await this.productLines.create(auth.tenantId, auth.userId, brandId, input));
  }

  @Patch(':id/product-lines/:lineId')
  @UseGuards(TenantActiveGuard)
  async update(
    @Req() request: unknown,
    @Param('id') id: string,
    @Param('lineId') rawLineId: string,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(id);
    const lineId = parseProductLineId(rawLineId);
    const input = parseBody(updateProductLineSchema, body);
    return ok(await this.productLines.update(auth.tenantId, auth.userId, brandId, lineId, input));
  }

  @Delete(':id/product-lines/:lineId')
  @UseGuards(TenantActiveGuard)
  async remove(@Param('id') id: string, @Param('lineId') rawLineId: string) {
    const brandId = parseBrandId(id);
    const lineId = parseProductLineId(rawLineId);
    return ok(await this.productLines.remove(brandId, lineId));
  }
}
