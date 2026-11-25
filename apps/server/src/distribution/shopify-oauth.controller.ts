import type { IncomingMessage, ServerResponse } from 'node:http';
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
  Res,
  UseGuards,
  type RawBodyRequest,
} from '@nestjs/common';
import { z } from 'zod';
import { GEO_MARKETS, ok, SUPPORTED_LOCALE_CODES } from '@geomix/shared';
import { AuthGuard } from '../auth/auth.guard';
import { TenantActiveGuard } from '../auth/tenant-active.guard';
import { parseBrandId, requireAuth } from '../brands/brands.http-utils';
import { parseBody } from '../common/parse-body';
import { ShopifyOAuthService } from './shopify-oauth.service';

const shopDomainInputSchema = z
  .string()
  .max(512)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), {
    message: 'Shopify 店铺域名包含非法控制字符',
  })
  .transform((v) => v.trim())
  .pipe(z.string().min(1).max(255));

const shopifyOAuthStartBodySchema = z
  .object({
    shop: shopDomainInputSchema.optional(),
    shopDomain: shopDomainInputSchema.optional(),
    market: z.enum(GEO_MARKETS).optional().default('GLOBAL'),
    displayName: z.string().trim().min(1, '请填写连接名称').max(80).optional(),
    targetLocale: z.enum(SUPPORTED_LOCALE_CODES).nullable().optional(),
  })
  .refine((v) => Boolean(v.shop || v.shopDomain), {
    message: '请填写 Shopify 店铺域名（*.myshopify.com）',
    path: ['shop'],
  });

function extractRawQueryString(req: IncomingMessage): string {
  const url = req.url ?? '';
  const idx = url.indexOf('?');
  return idx >= 0 ? url.slice(idx + 1) : '';
}

function prefersHtmlRedirect(req: IncomingMessage, query: Record<string, unknown>): boolean {
  const format = Array.isArray(query?.format) ? query.format[0] : query?.format;
  if (typeof format === 'string' && format.trim().toLowerCase() === 'json') {
    return false;
  }
  const acceptRaw = req.headers.accept;
  const accept = (Array.isArray(acceptRaw) ? acceptRaw.join(',') : (acceptRaw ?? '')).toLowerCase();
  return accept.includes('text/html') && !accept.includes('application/json');
}

@Controller({ version: '2' })
export class ShopifyOAuthController {
  constructor(@Inject(ShopifyOAuthService) private readonly shopifyOAuth: ShopifyOAuthService) {}

  @Post('brands/:brandId/connections/shopify/oauth/start')
  @HttpCode(200)
  @UseGuards(AuthGuard, TenantActiveGuard)
  async start(
    @Req() request: unknown,
    @Param('brandId') brandIdRaw: string,
    @Body() body: unknown,
  ) {
    const auth = requireAuth(request);
    const brandId = parseBrandId(brandIdRaw);
    const input = parseBody(shopifyOAuthStartBodySchema, body);
    const shop = input.shop ?? input.shopDomain ?? '';
    return ok(
      await this.shopifyOAuth.startOAuth(
        { tenantId: auth.tenantId, userId: auth.userId },
        brandId,
        {
          shop,
          market: input.market,
          displayName: input.displayName,
          targetLocale: input.targetLocale,
        },
      ),
    );
  }

  @Get('integrations/shopify/callback')
  async callback(
    @Req() req: IncomingMessage,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    const rawQuery = extractRawQueryString(req);
    const result = await this.shopifyOAuth.handleCallback(rawQuery);
    res.setHeader('Cache-Control', 'no-store');

    if (prefersHtmlRedirect(req, query)) {
      res.statusCode = 302;
      res.setHeader('Location', result.redirectUrl);
      res.end();
      return;
    }

    return ok({
      connection: result.connection,
      shop: result.shop,
      webhookRegistered: result.webhookRegistered,
    });
  }

  @Post('integrations/shopify/webhooks/app-uninstalled')
  @HttpCode(200)
  async appUninstalled(@Req() req: RawBodyRequest<IncomingMessage>) {
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : undefined;
    return ok(await this.shopifyOAuth.handleAppUninstalledWebhook(rawBody, req.headers));
  }
}
