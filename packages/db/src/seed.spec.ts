import { describe, expect, it } from 'vitest';
import { DEFAULT_BILLING_MODE } from '@geomix/shared/infra';
import { hashPassword, verifyPassword } from './password';
import {
  DEMO_TENANT_ID,
  DEMO_USER_ID,
  PLATFORM_EXPIRES_AT,
  PLATFORM_TENANT_ID,
  addUtcDays,
  buildSeedWrites,
  readSeedConfig,
} from './seed';

const NOW = new Date('2026-11-16T00:00:00.000Z');

describe('seed plan', () => {
  it('reads local placeholders and rejects unsafe overrides', () => {
    const config = readSeedConfig({});
    expect(config.adminUsername).toBe('admin');
    expect(config.demoUsername).toBe('demo');
    expect(config.demoPoints).toBe(1000);
    expect(config.demoValidDays).toBe(365);
    expect(() => readSeedConfig({ SEED_ADMIN_PASSWORD: 'short' })).toThrow(/8-128/);
    expect(() =>
      readSeedConfig({ SEED_ADMIN_USERNAME: 'admin', SEED_DEMO_USERNAME: 'admin' }),
    ).toThrow(/differ/);
    expect(() => readSeedConfig({ SEED_DEMO_POINTS: '0' })).toThrow(/between 1/);
    expect(() => readSeedConfig({ SEED_DEMO_POINTS: 'nope' })).toThrow(/positive integer/);
  });

  it('plans v2 prices, quotas, and the two seed accounts', () => {
    const writes = buildSeedWrites({
      config: readSeedConfig({}),
      now: NOW,
      hashPassword,
    });
    expect(writes.pricing.map((item) => [item.action, item.unitPoints])).toEqual([
      ['geo_write', 10],
      ['visibility_check', 2],
      ['inline_image_gen', 5],
      ['geo_variant', 2],
    ]);
    expect(writes.quotas).toHaveLength(12);
    expect(writes.quotas.filter((item) => item.tenantId === DEMO_TENANT_ID)).toHaveLength(6);

    const demo = writes.accounts.find((item) => item.tenantId === DEMO_TENANT_ID);
    const platform = writes.accounts.find((item) => item.tenantId === PLATFORM_TENANT_ID);
    expect(demo).toMatchObject({
      tenantName: 'GeoMix 演示',
      points: 1000,
      userId: DEMO_USER_ID,
      username: 'demo',
      role: 'MERCHANT',
    });
    expect(demo?.expiresAt.toISOString()).toBe(addUtcDays(NOW, 365).toISOString());
    expect(demo?.expiresAt.getTime()).toBe(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);
    expect(platform).toMatchObject({
      tenantName: 'GeoMix 平台',
      points: 0,
      role: 'ADMIN',
      username: 'admin',
    });
    expect(platform?.expiresAt.toISOString()).toBe(PLATFORM_EXPIRES_AT.toISOString());
    expect(verifyPassword('geomix-demo-dev', demo?.passwordHash ?? '')).toBe(true);
    expect(verifyPassword('geomix-admin-dev', platform?.passwordHash ?? '')).toBe(true);
  });

  it('leaves tenant billing empty so the global default stays SHADOW', () => {
    expect(DEFAULT_BILLING_MODE).toBe('SHADOW');
  });
});
