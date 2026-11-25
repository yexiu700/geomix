import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { API_ERROR, AUTH_ERROR } from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { runInTenant } from '../tenant/tenant-context';
import type { ExtensionRequestAuth } from './extension-auth.types';

export const EXTENSION_REQUIRED_SCOPE = 'extension:distribution' as const;
export const EXTENSION_RAW_TOKEN_RE = /^gmext_[A-Za-z0-9_-]{32,128}$/;

export function hashExtensionToken(plainToken: string): string {
  return createHash('sha256').update(plainToken, 'utf8').digest('hex');
}

/**
 * 扩展配对令牌鉴权查询服务：
 * - `apps/server/src/extension/` 中唯一登记 `prisma.base` 白名单的文件（direct: 1, txOrRaw: 0）；
 * - 先校验 `gmext_` 令牌格式，再计算 SHA-256 哈希查询 `ExtensionAccessToken`；
 * - 校验未吊销、未过期、包含 `extension:distribution` 作用域、所属租户启用且未到期；
 * - 鉴权通过后在 `runInTenant` 内经 `prisma.scoped` 容错刷新 `lastUsedAt`。
 */
@Injectable()
export class ExtensionTokenLookupService {
  private readonly logger = new Logger(ExtensionTokenLookupService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async authenticate(
    plainToken: string,
    nowMs: number = Date.now(),
  ): Promise<ExtensionRequestAuth> {
    if (typeof plainToken !== 'string' || !EXTENSION_RAW_TOKEN_RE.test(plainToken)) {
      throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '扩展配对令牌无效或已失效');
    }

    const tokenHash = hashExtensionToken(plainToken);
    const record = await this.prisma.base.extensionAccessToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        label: true,
        tokenPrefix: true,
        scopes: true,
        expiresAt: true,
        revokedAt: true,
        tenant: {
          select: {
            name: true,
            isActive: true,
            expiresAt: true,
          },
        },
      },
    });

    if (!record || record.revokedAt !== null || record.expiresAt.getTime() <= nowMs) {
      throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '扩展配对令牌无效或已失效');
    }

    if (!Array.isArray(record.scopes) || !record.scopes.includes(EXTENSION_REQUIRED_SCOPE)) {
      throw new ApiError(401, AUTH_ERROR.UNAUTHORIZED, '扩展配对令牌缺少所需权限');
    }

    if (!record.tenant?.isActive) {
      throw new ApiError(403, API_ERROR.TENANT_EXPIRED, '账号已停用');
    }

    if (record.tenant.expiresAt.getTime() <= nowMs) {
      throw new ApiError(403, API_ERROR.TENANT_EXPIRED, '账号已到期，扩展桥接不可用');
    }

    try {
      await runInTenant(record.tenantId, () =>
        this.prisma.scoped.extensionAccessToken.updateMany({
          where: { id: record.id, revokedAt: null },
          data: { lastUsedAt: new Date(nowMs) },
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to update extension token lastUsedAt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      tokenId: record.id,
      tenantId: record.tenantId,
      userId: record.userId,
      tokenLabel: record.label,
      tokenPrefix: record.tokenPrefix,
      scopes: [...record.scopes],
      expiresAt: record.expiresAt,
      tenantName: record.tenant.name,
    };
  }
}
