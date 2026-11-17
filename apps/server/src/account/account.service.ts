import { Inject, Injectable } from '@nestjs/common';
import { AUTH_ERROR, parseEnv } from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';

const userSelect = {
  id: true,
  username: true,
  nickname: true,
  role: true,
  tenant: { select: { id: true, name: true, expiresAt: true, isActive: true } },
} as const;

@Injectable()
export class AccountService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async profile(userId: string) {
    const user = await this.prisma.scoped.user.findFirst({
      where: { id: userId },
      select: userSelect,
    });
    if (!user) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '账号不存在');
    return present(user);
  }

  /** 只返回当前租户里的用户。其他租户的 id 和数据库里不存在的 id 都是 404。 */
  async userInTenant(userId: string) {
    const user = await this.prisma.scoped.user.findFirst({
      where: { id: userId },
      select: { id: true, username: true, nickname: true, role: true },
    });
    if (!user) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '账号不存在');
    return user;
  }
}

function present(user: {
  id: string;
  username: string;
  nickname: string | null;
  role: 'ADMIN' | 'MERCHANT';
  tenant: { id: string; name: string; expiresAt: Date; isActive: boolean };
}) {
  const readOnly = !user.tenant.isActive || user.tenant.expiresAt.getTime() <= Date.now();
  const env = parseEnv(process.env);
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    features: {
      aiImage: env.FEATURE_AI_IMAGE,
    },
    tenant: {
      id: user.tenant.id,
      name: user.tenant.name,
      expiresAt: user.tenant.expiresAt.toISOString(),
      isActive: user.tenant.isActive,
      readOnly,
    },
  };
}
