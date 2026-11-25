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
  Res,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  GEO_MARKETS,
  createGeoRoiReportSchema,
  createGeoRoiReportShareSchema,
  ok,
  type GeoMarket,
} from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { parseBrandId, requireAuth } from '../brands/brands.http-utils';
import { parseBody } from '../common/parse-body';
import { flattenQuery, parseEntityId } from '../studio/studio.controller';
import { RoiReportsService } from './roi-reports.service';

const optionalMarketQuerySchema = z.object({
  market: z.enum(GEO_MARKETS).optional(),
});

const listRoiReportsQuerySchema = z.object({
  market: z.enum(GEO_MARKETS).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const EXPORT_HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

type HtmlExportResponseLike = {
  setHeader(name: string, value: string): unknown;
  status(code: number): { send(body: Buffer): unknown };
};

function normalizeOptionalBody(body: unknown): unknown {
  return body === undefined || body === null || body === '' ? {} : body;
}

@Controller({ path: 'brands/:brandId/roi-reports', version: '2' })
@UseGuards(AuthGuard)
export class BrandRoiReportsController {
  constructor(@Inject(RoiReportsService) private readonly reports: RoiReportsService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async createReport(
    @Req() request: unknown,
    @Param('brandId') brandIdRaw: string,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(brandIdRaw);
    const parsedQuery = parseBody(optionalMarketQuerySchema, flattenQuery(query));
    const input = parseBody(createGeoRoiReportSchema, body);
    const queryMarket: GeoMarket | undefined = parsedQuery.market;
    return ok(await this.reports.createReport(brandId, input, auth, queryMarket));
  }

  @Get()
  async listReports(@Param('brandId') brandIdRaw: string, @Query() query: Record<string, unknown>) {
    const brandId = parseBrandId(brandIdRaw);
    const parsedQuery = parseBody(listRoiReportsQuerySchema, flattenQuery(query));
    return ok(await this.reports.listReports(brandId, parsedQuery));
  }
}

@Controller({ path: 'roi-reports', version: '2' })
@UseGuards(AuthGuard)
export class RoiReportsController {
  constructor(@Inject(RoiReportsService) private readonly reports: RoiReportsService) {}

  @Get(':id')
  async getReport(@Param('id') idRaw: string) {
    const reportId = parseEntityId(idRaw, '报告编号');
    return ok(await this.reports.getReport(reportId));
  }

  @Get(':id/export.html')
  async exportReportHtml(
    @Req() request: unknown,
    @Param('id') idRaw: string,
    @Res() res: HtmlExportResponseLike,
  ) {
    const auth = requireAuth(request);
    const reportId = parseEntityId(idRaw, '报告编号');
    const exported = await this.reports.exportReportHtml(reportId, auth);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', exported.contentDisposition);
    res.setHeader('Content-Security-Policy', EXPORT_HTML_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.status(200).send(exported.buffer);
  }

  @Post(':id/share')
  @HttpCode(200)
  @UseGuards(TenantActiveGuard)
  async createShareLink(
    @Req() request: unknown,
    @Param('id') idRaw: string,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const reportId = parseEntityId(idRaw, '报告编号');
    const input = parseBody(createGeoRoiReportShareSchema, normalizeOptionalBody(body));
    return ok(await this.reports.createShareLink(reportId, input, auth));
  }

  @Delete(':id/share')
  @UseGuards(TenantActiveGuard)
  async revokeShareLink(@Param('id') idRaw: string) {
    const reportId = parseEntityId(idRaw, '报告编号');
    return ok(await this.reports.revokeShareLink(reportId));
  }
}
