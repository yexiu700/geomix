import 'reflect-metadata';
import { API_ERROR } from '@geomix/shared';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { AccountService, sanitizeUiPrefs } from './account.service';

describe('AccountService uiPrefs persistence (#66)', () => {
  it('sanitizes stored uiPrefs in profile and merges valid patches on updateUiPrefs', async () => {
    let storedUiPrefs: unknown = { multiTab: false, extraNoise: 'ignored' };
    const updateMock = vi
      .fn()
      .mockImplementation(async ({ data }: { data: { uiPrefs: unknown } }) => {
        storedUiPrefs = data.uiPrefs;
        return { id: 'u_demo' };
      });

    const prisma = {
      scoped: {
        user: {
          findFirst: vi.fn().mockImplementation(async () => ({
            id: 'u_demo',
            username: 'demo',
            nickname: '演示商户',
            role: 'MERCHANT' as const,
            uiPrefs: storedUiPrefs,
            tenant: {
              id: 't_demo',
              name: '演示租户',
              expiresAt: new Date('2027-12-31T00:00:00.000Z'),
              isActive: true,
            },
          })),
          update: updateMock,
        },
      },
    } as unknown as PrismaService;

    const service = new AccountService(prisma);
    const initial = await service.profile('u_demo');
    expect(initial.uiPrefs).toEqual({ multiTab: false });

    const updated = await service.updateUiPrefs('u_demo', {
      menuCollapsed: true,
      submenusAlwaysVisible: true,
    });
    expect(updated.uiPrefs).toEqual({
      multiTab: false,
      menuCollapsed: true,
      submenusAlwaysVisible: true,
    });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'u_demo' },
      data: {
        uiPrefs: {
          multiTab: false,
          menuCollapsed: true,
          submenusAlwaysVisible: true,
        },
      },
    });

    const reloaded = await service.profile('u_demo');
    expect(reloaded.uiPrefs).toEqual({
      multiTab: false,
      menuCollapsed: true,
      submenusAlwaysVisible: true,
    });
  });

  it('rejects unknown or non-boolean fields in updateUiPrefs', async () => {
    const prisma = {
      scoped: { user: { findFirst: vi.fn(), update: vi.fn() } },
    } as unknown as PrismaService;
    const service = new AccountService(prisma);

    await expect(service.updateUiPrefs('u_demo', { multiTab: 'no' })).rejects.toMatchObject({
      status: 400,
      code: API_ERROR.BAD_REQUEST,
    });

    await expect(service.updateUiPrefs('u_demo', { unknownKey: true })).rejects.toMatchObject({
      status: 400,
      code: API_ERROR.BAD_REQUEST,
    });

    expect(sanitizeUiPrefs(null)).toBeNull();
    expect(sanitizeUiPrefs({})).toBeNull();
  });
});
