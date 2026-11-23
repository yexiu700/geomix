import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ok } from '@geomix/shared';
import { clientAddress } from '../auth/client-address';
import { PublicPrPacketService } from './public-pr-packet.service';

/**
 * 免登录外部 PR / KOL 协作包公开接口：
 * - 不挂 AuthGuard、不挂 TenantActiveGuard、绝不直接接触 prisma.base
 * - 安全控制由 PublicPrPacketService（SHA-256 令牌哈希、统一 404、IP 限流、SSRF 校验与严格白名单 DTO）统一把关
 */
@Controller({ path: 'public/pr-packets', version: '2' })
export class PublicPrPacketController {
  constructor(@Inject(PublicPrPacketService) private readonly publicPr: PublicPrPacketService) {}

  @Get(':token')
  async getPacket(@Req() request: unknown, @Param('token') token: string) {
    const ip = clientAddress(request);
    return ok(await this.publicPr.getPacket(token, ip));
  }

  @Post(':token/submit')
  @HttpCode(200)
  async submitPublishedUrl(
    @Req() request: unknown,
    @Param('token') token: string,
    @Body() body: unknown,
  ) {
    const ip = clientAddress(request);
    return ok(await this.publicPr.submitPublishedUrl(token, body, ip));
  }
}
