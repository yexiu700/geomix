import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  AUTH_ERROR,
  EXTENSION_DEFAULT_SCOPES,
  EXTENSION_TOKEN_PREFIX,
  createExtensionTokenSchema,
  type CreateExtensionTokenResponseDto,
  type ExtensionTokenDto,
} from '@geomix/shared';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  readExtensionTokenIssueRateLimit,
} from '../common/free-action-rate-limiter';
import { parseBody } from '../common/parse-body';
import { PrismaService } from '../prisma/prisma.service';
import { hashExtensionToken } from './extension-token-lookup.service';

const DAY_MS = 86_400_000;
const TOKEN_RANDOM_BYTES = 32;
const TOKEN_PREFIX_DISPLAY_LEN = 12;

export type ExtensionTokenAuthContext = {
  tenantId: string;
  userId: string;
};

export type RevokeExtensionTokenResultDto = {
  id: string;
  revoked: true;
  revokedAt: string;
};

type ExtensionTokenRow = {
  id: string;
  label: string;
  tokenPrefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
};

function presentExtensionToken(row: ExtensionTokenRow): ExtensionTokenDto {
  return {
    id: row.id,
    label: row.label,
    tokenPrefix: row.tokenPrefix,
    scopes: [...row.scopes],
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 控制台扩展配对令牌管理服务（100% `prisma.scoped`，0 点数，按租户防刷限流）：
 * - 明文 `gmext_...` 仅在创建当次返回一次，库中仅落 SHA-256 哈希；
 * - 列表与日志绝不返回或打印明文与 `tokenHash`；
 * - 吊销支持幂等，跨租户访问返回 404。
 */
@Injectable()
export class ExtensionTokenService {
  private readonly rateLimiter: FreeActionRateLimiter;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(FreeActionRateLimiter) rateLimiter?: FreeActionRateLimiter,
  ) {
    this.rateLimiter = rateLimiter ?? new FreeActionRateLimiter();
  }

  async listTokens(): Promise<{ items: ExtensionTokenDto[] }> {
    const rows = await this.prisma.scoped.extensionAccessToken.findMany({
      select: {
        id: true,
        label: true,
        tokenPrefix: true,
        scopes: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return {
      items: rows.map(presentExtensionToken),
    };
  }

  async createToken(
    rawBody: unknown,
    auth: ExtensionTokenAuthContext,
  ): Promise<CreateExtensionTokenResponseDto> {
    this.rateLimiter.assertAllowed(
      'extension_token_issue',
      auth.tenantId,
      readExtensionTokenIssueRateLimit(),
    );

    const input = parseBody(createExtensionTokenSchema, rawBody);
    const secretPart = randomBytes(TOKEN_RANDOM_BYTES).toString('base64url');
    const plainToken = `${EXTENSION_TOKEN_PREFIX}${secretPart}`;
    const tokenHash = hashExtensionToken(plainToken);
    const tokenPrefix = plainToken.slice(0, TOKEN_PREFIX_DISPLAY_LEN);
    const expiresAt = new Date(Date.now() + input.ttlDays * DAY_MS);

    const created = await this.prisma.scoped.extensionAccessToken.create({
      data: {
        tenantId: auth.tenantId,
        userId: auth.userId,
        label: input.label,
        tokenPrefix,
        tokenHash,
        scopes: [...EXTENSION_DEFAULT_SCOPES],
        expiresAt,
      },
      select: {
        id: true,
        label: true,
        tokenPrefix: true,
        scopes: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });

    return {
      token: presentExtensionToken(created),
      plainToken,
    };
  }

  async revokeToken(tokenId: string): Promise<RevokeExtensionTokenResultDto> {
    const existing = await this.prisma.scoped.extensionAccessToken.findFirst({
      where: { id: tokenId },
      select: {
        id: true,
        revokedAt: true,
      },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '扩展配对令牌不存在');
    }

    if (existing.revokedAt !== null) {
      return {
        id: existing.id,
        revoked: true,
        revokedAt: existing.revokedAt.toISOString(),
      };
    }

    const revokedAt = new Date();
    await this.prisma.scoped.extensionAccessToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt },
    });

    return {
      id: existing.id,
      revoked: true,
      revokedAt: revokedAt.toISOString(),
    };
  }
}
