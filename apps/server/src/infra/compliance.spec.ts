import { describe, expect, it } from 'vitest';
import { API_ERROR } from '@geomix/shared';
import { ApiError } from '../common/api-error';
import { ComplianceService, scanCompliance } from './compliance';
import { ProviderError, providerToApi } from './provider-error';

describe('compliance scan', () => {
  it('blocks a self-written industry list and records an audit without the raw text', async () => {
    const writes: Array<{ action: string; payload: Record<string, unknown> }> = [];
    const service = new ComplianceService({
      async write(entry) {
        writes.push({ action: entry.action, payload: entry.payload });
      },
    });
    const text = '这是一条赌博推广';
    await expect(
      service.assertAllowed({ text, action: 'image_prompt', tenantId: 'tenant_demo' }),
    ).rejects.toMatchObject({
      status: 403,
      code: API_ERROR.FORBIDDEN_INDUSTRY,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.action).toBe('forbidden_blocked');
    expect(JSON.stringify(writes[0]?.payload)).not.toContain(text);
    expect(writes[0]?.payload.labels).toEqual(['赌博']);
    const clean = await service.assertAllowed({
      text: '苏州华信精密机械制造有限公司工业医疗级洁净结构件注塑制造',
      action: 'image_prompt',
    });
    expect(clean.blocked).toBe(false);
    expect(writes).toHaveLength(1);
    await expect(
      service.assertAllowed({ text: '民营男科医院网贷推广', action: 'keyword_create' }),
    ).rejects.toMatchObject({
      status: 403,
      code: API_ERROR.FORBIDDEN_INDUSTRY,
    });
    expect(writes).toHaveLength(2);
  });

  it('replaces explicit extreme claims and leaves ordinary words alone', () => {
    const report = scanCompliance(
      '我们提供顶级方案，最近更新，不是第一品牌，也不说100%。绝对永久。',
    );
    expect(report.blocked).toBe(false);
    expect(report.text).toContain('高水平');
    expect(report.text).toContain('最近更新');
    expect(report.text).toContain('较为靠前');
    expect(report.text).toContain('较高比例');
    expect(report.text).not.toContain('顶级');
    expect(report.text).not.toContain('100%');
    expect(report.flags.map((flag) => flag.label)).toEqual(['绝对', '永久']);
  });

  it('still blocks when the audit writer fails', async () => {
    const service = new ComplianceService({
      async write() {
        throw new Error('db down');
      },
    });
    await expect(service.assertAllowed({ text: '毒品', action: 'keyword' })).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('maps a blocked fetch to the public upstream code without the private address', () => {
    const mapped = providerToApi(new ProviderError('ssrf', '目标地址不允许访问', 'ipv4_special'));
    expect(mapped.status).toBe(422);
    expect(mapped.code).toBe(API_ERROR.UPSTREAM_UNAVAILABLE);
    expect(mapped.message).toBe('无法公开访问');
    expect(mapped.message).not.toContain('10.');
  });
});
