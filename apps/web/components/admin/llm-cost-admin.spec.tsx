// @vitest-environment jsdom

import type { LlmDailyCostReport } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmCostAdmin } from './llm-cost-admin';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function sampleReport(overrides?: Partial<LlmDailyCostReport>): LlmDailyCostReport {
  return {
    days: 14,
    includeFake: true,
    rateConfigured: true,
    windowStartDate: '2026-11-04',
    windowEndDate: '2026-11-17',
    totals: {
      calls: 12,
      realCalls: 10,
      fakeCalls: 2,
      tokensIn: 8000,
      tokensOut: 4000,
      totalTokens: 12000,
      costMicro: 24000,
      costYuan: '0.0240',
    },
    daily: [
      {
        date: '2026-11-17',
        calls: 12,
        realCalls: 10,
        fakeCalls: 2,
        tokensIn: 8000,
        tokensOut: 4000,
        totalTokens: 12000,
        costMicro: 24000,
        costYuan: '0.0240',
      },
    ],
    byScene: [
      {
        scene: 'body',
        label: '文章正文',
        calls: 8,
        tokensIn: 6000,
        tokensOut: 3000,
        totalTokens: 9000,
        costMicro: 18000,
        costYuan: '0.0180',
      },
    ],
    byModel: [
      {
        provider: 'deepseek',
        model: 'deepseek-chat',
        fake: false,
        calls: 10,
        tokensIn: 7500,
        tokensOut: 3800,
        totalTokens: 11300,
        costMicro: 23300,
        costYuan: '0.0233',
      },
    ],
    byTenant: [
      {
        tenantId: 'tenant-a',
        tenantName: '商户甲',
        calls: 12,
        tokensIn: 8000,
        tokensOut: 4000,
        totalTokens: 12000,
        costMicro: 24000,
        costYuan: '0.0240',
      },
    ],
    ...overrides,
  };
}

describe('LlmCostAdmin (#24)', () => {
  it('renders daily LLM cost metrics, switches filters, and exports CSV', async () => {
    const llmCosts = vi.fn(async (query?: { days?: number; includeFake?: boolean }) =>
      sampleReport({
        days: query?.days ?? 14,
        includeFake: query?.includeFake ?? true,
      }),
    );

    const createObjectUrl = vi.fn(() => 'blob:geomix-llm-costs');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeObjectUrl,
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    render(<LlmCostAdmin client={{ llmCosts }} />);

    expect(await screen.findByText('2026-11-17')).toBeTruthy();
    expect(screen.getAllByText('¥0.0240').length).toBeGreaterThanOrEqual(1);
    expect(llmCosts).toHaveBeenCalledWith({ days: 14, includeFake: true });

    fireEvent.click(screen.getByRole('switch', { name: '含占位假调用' }));
    await waitFor(() => {
      expect(llmCosts).toHaveBeenCalledWith({ days: 14, includeFake: false });
    });

    fireEvent.mouseDown(screen.getByRole('combobox', { name: '统计周期' }));
    fireEvent.click(await screen.findByText('近 7 天'));
    await waitFor(() => {
      expect(llmCosts).toHaveBeenCalledWith({ days: 7, includeFake: false });
    });

    fireEvent.click(screen.getByRole('tab', { name: '按场景分布' }));
    expect(await screen.findByText('文章正文')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /导出\s*CSV/ }));
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    await waitFor(
      () => {
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:geomix-llm-costs');
      },
      { timeout: 2000 },
    );
  });
});
