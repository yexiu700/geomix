import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthStore, AuthUser, UserRoleName } from './auth.types';

const REVOKE_ACTION = 'auth_revoke';

@Injectable()
export class PrismaAuthStore implements AuthStore {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findUserByUsername(username: string): Promise<AuthUser | null> {
    const user = await this.prisma.base.user.findUnique({
      where: { username },
      include: { tenant: true },
    });
    return user ? toAuthUser(user) : null;
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    const user = await this.prisma.base.user.findUnique({
      where: { id },
      include: { tenant: true },
    });
    return user ? toAuthUser(user) : null;
  }

  async touchLogin(id: string, at: Date): Promise<void> {
    await this.prisma.base.user.update({ where: { id }, data: { lastLoginAt: at } });
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.prisma.base.user.update({ where: { id }, data: { passwordHash } });
  }

  async revoke(userId: string, tenantId: string, atMs: number): Promise<void> {
    await this.prisma.base.auditLog.create({
      data: { userId, tenantId, action: REVOKE_ACTION, payload: { at: atMs } },
    });
  }

  async latestRevokeAt(userId: string): Promise<number | null> {
    const rows = await this.prisma.base.auditLog.findMany({
      where: { userId, action: REVOKE_ACTION },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { payload: true },
    });
    let latest: number | null = null;
    for (const row of rows) {
      const at = readRevokeAt(row.payload);
      if (at !== null && (latest === null || at > latest)) latest = at;
    }
    return latest;
  }
}

function readRevokeAt(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const at = (payload as { at?: unknown }).at;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

function toAuthUser(user: {
  id: string;
  tenantId: string;
  username: string;
  passwordHash: string;
  nickname: string | null;
  role: UserRoleName;
  tenant: { name: string; expiresAt: Date; isActive: boolean };
}): AuthUser {
  return {
    id: user.id,
    tenantId: user.tenantId,
    username: user.username,
    passwordHash: user.passwordHash,
    nickname: user.nickname,
    role: user.role,
    tenantName: user.tenant.name,
    expiresAt: user.tenant.expiresAt,
    isActive: user.tenant.isActive,
  };
}
