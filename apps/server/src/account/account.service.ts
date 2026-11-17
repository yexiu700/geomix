import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { API_ERROR, AUTH_ERROR, parseEnv } from '@geomix/shared';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { readVisibilityConfig } from '../visibility/visibility.config';

export const uiPrefsPatchSchema = z
  .object({
    multiTab: z.boolean().optional(),
    menuCollapsed: z.boolean().optional(),
    submenusAlwaysVisible: z.boolean().optional(),
    autoExpand: z.boolean().optional(),
    multiLevel: z.boolean().optional(),
  })
  .strict();

export type UiPrefsRecord = z.infer<typeof uiPrefsPatchSchema>;

const UI_PREF_KEYS = [
  'multiTab',
  'menuCollapsed',
  'submenusAlwaysVisible',
  'autoExpand',
  'multiLevel',
] as const;

const userSelect = {
  id: true,
  username: true,
  nickname: true,
  role: true,
  uiPrefs: true,
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

  async updateUiPrefs(userId: string, rawPatch: unknown): Promise<{ uiPrefs: UiPrefsRecord }> {
    const parsed = uiPrefsPatchSchema.safeParse(rawPatch);
    if (!parsed.success) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '布局偏好格式不正确');
    }
    const existing = await this.prisma.scoped.user.findFirst({
      where: { id: userId },
      select: { id: true, uiPrefs: true },
    });
    if (!existing) throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '账号不存在');

    const merged: UiPrefsRecord = {
      ...(sanitizeUiPrefs(existing.uiPrefs) ?? {}),
      ...parsed.data,
    };

    await this.prisma.scoped.user.update({
      where: { id: existing.id },
      data: { uiPrefs: merged as Prisma.InputJsonValue },
    });

    return { uiPrefs: merged };
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

export function sanitizeUiPrefs(raw: unknown): UiPrefsRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const out: UiPrefsRecord = {};
  let hasAny = false;
  for (const key of UI_PREF_KEYS) {
    if (typeof record[key] === 'boolean') {
      out[key] = record[key];
      hasAny = true;
    }
  }
  return hasAny ? out : null;
}

function present(user: {
  id: string;
  username: string;
  nickname: string | null;
  role: 'ADMIN' | 'MERCHANT';
  uiPrefs: Prisma.JsonValue;
  tenant: { id: string; name: string; expiresAt: Date; isActive: boolean };
}) {
  const readOnly = !user.tenant.isActive || user.tenant.expiresAt.getTime() <= Date.now();
  const env = parseEnv(process.env);
  const visibilityEnabled =
    process.env.FEATURE_VISIBILITY?.trim().toLowerCase() === 'false'
      ? false
      : (() => {
          try {
            return readVisibilityConfig(process.env).featureEnabled;
          } catch {
            return true;
          }
        })();
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    uiPrefs: sanitizeUiPrefs(user.uiPrefs),
    features: {
      aiImage: env.FEATURE_AI_IMAGE,
      visibility: visibilityEnabled,
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
