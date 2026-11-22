import { describe, expect, it } from 'vitest';
import {
  aggregateLlmDailyReport,
  estimateLlmCallCostMicro,
  llmDailyReportToCsv,
  parseLlmCostQuery,
  parseLlmCostRates,
  sceneDisplayLabel,
} from './ops';

describe('ops LLM daily cost report helpers (#24)', () => {
  it('parses model rate maps and computes configured vs placeholder micro-costs', () => {
    const rates = parseLlmCostRates(
      JSON.stringify({
        'deepseek/deepseek-chat': { inputMicroPer1k: 2000, outputMicroPer1k: 8000 },
        '*': { inputMicroPer1k: 1000, outputMicroPer1k: 2000 },
      }),
    );

    const exact = estimateLlmCallCostMicro({
      provider: 'deepseek',
      model: 'deepseek-chat',
      fake: false,
      tokensIn: 1000,
      tokensOut: 500,
      rates,
    });
    expect(exact).toEqual({ costMicro: 6000, costBasis: 'configured' });

    const fakeCall = estimateLlmCallCostMicro({
      provider: 'fake',
      model: 'fake-quality',
      fake: true,
      tokensIn: 300,
      tokensOut: 200,
      rates,
    });
    expect(fakeCall).toEqual({ costMicro: 500, costBasis: 'placeholder' });
  });

  it('validates query params and aggregates daily, scene, model, and tenant buckets in Asia/Shanghai', () => {
    const query = parseLlmCostQuery({ days: '7', includeFake: 'false', tenantId: 'tenant_01' });
    expect(query).toEqual({ days: 7, includeFake: false, tenantId: 'tenant_01' });

    const now = new Date('2026-11-17T10:00:00.000Z'); // 2026-11-17 18:00 CST
    const report = aggregateLlmDailyReport(
      [
        {
          tenantId: 'tenant_01',
          tenantName: '演示商户A',
          scene: 'body',
          provider: 'deepseek',
          model: 'deepseek-chat',
          fake: false,
          tokensIn: 2000,
          tokensOut: 1500,
          costMicro: 16000,
          createdAt: '2026-11-17T02:00:00.000Z',
        },
        {
          tenantId: 'tenant_01',
          tenantName: '演示商户A',
          scene: 'distill',
          provider: 'fake',
          model: 'fake-cheap',
          fake: true,
          tokensIn: 400,
          tokensOut: 100,
          costMicro: 500,
          createdAt: '2026-11-16T17:00:00.000Z', // 2026-11-17 01:00 CST!
        },
      ],
      { days: 3, includeFake: true, now },
    );

    expect(report.days).toBe(3);
    expect(report.windowStartDate).toBe('2026-11-15');
    expect(report.windowEndDate).toBe('2026-11-17');
    expect(report.totals.calls).toBe(2);
    expect(report.totals.realCalls).toBe(1);
    expect(report.totals.fakeCalls).toBe(1);
    expect(report.totals.totalTokens).toBe(4000);
    expect(report.totals.costMicro).toBe(16500);
    expect(report.totals.costYuan).toBe('0.0165');

    // Both timestamps fall on 2026-11-17 in Asia/Shanghai (UTC+8)
    const todayRow = report.daily.find((d) => d.date === '2026-11-17');
    expect(todayRow?.calls).toBe(2);
    expect(report.byScene.map((s) => s.label)).toEqual(['文章正文', '主词蒸馏']);
    expect(report.byTenant[0]?.tenantName).toBe('演示商户A');

    const csv = llmDailyReportToCsv(report);
    expect(csv).toContain('日期,总调用次数,真实模型调用');
    expect(csv).toContain('2026-11-17,2,1,1,2400,1600,4000,16500,0.0165');

    expect(sceneDisplayLabel('geo_write')).toBe('GEO 靶向写作');
    expect(sceneDisplayLabel('geo_brief')).toBe('GEO 写作意见');
    expect(sceneDisplayLabel('fact_extract')).toBe('事实卡提炼');
    expect(sceneDisplayLabel('geo_rewrite')).toBe('GEO 局部改写');
  });
});
