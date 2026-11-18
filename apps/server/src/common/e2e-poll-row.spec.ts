import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type MockLocator = {
  count: () => Promise<number>;
  first: () => { textContent: (opts?: { timeout?: number }) => Promise<string | null> };
};

type MockButton = {
  isVisible: () => Promise<boolean>;
  click: (opts?: { timeout?: number }) => Promise<void>;
};

const req = createRequire(__filename);
const { runNonBlockingRowPollStep } = req(
  resolve(__dirname, '../../../../e2e/support/poll-row.cjs'),
) as {
  runNonBlockingRowPollStep: (input: {
    row: MockLocator;
    refreshBtn: MockButton;
    drawerCloseBtn?: MockButton;
    expectedText: string;
    readTimeoutMs?: number;
    clickTimeoutMs?: number;
  }) => Promise<string>;
};

describe('runNonBlockingRowPollStep', () => {
  it('returns immediately without clicking refresh when row already contains expectedText', async () => {
    const refreshClick = vi.fn(async () => undefined);
    const result = await runNonBlockingRowPollStep({
      row: {
        count: async () => 1,
        first: () => ({ textContent: async () => '春季任务 创作完成 1 / 1' }),
      },
      refreshBtn: {
        isVisible: async () => true,
        click: refreshClick,
      },
      expectedText: '创作完成',
    });

    expect(result).toContain('创作完成');
    expect(refreshClick).not.toHaveBeenCalled();
  });

  it('skips blocking textContent when row count is 0, closes open drawer, and refreshes with bounded timeout', async () => {
    let refreshed = false;
    const textContentSpy = vi.fn(async () =>
      refreshed ? '钣金保养批量复刻 已完成 1 / 1 篇' : '排队中',
    );
    const drawerClick = vi.fn(async () => undefined);
    const refreshClick = vi.fn(async () => {
      refreshed = true;
    });

    const result = await runNonBlockingRowPollStep({
      row: {
        count: async () => (refreshed ? 1 : 0),
        first: () => ({ textContent: textContentSpy }),
      },
      drawerCloseBtn: {
        isVisible: async () => true,
        click: drawerClick,
      },
      refreshBtn: {
        isVisible: async () => true,
        click: refreshClick,
      },
      expectedText: '已完成',
      readTimeoutMs: 600,
      clickTimeoutMs: 1200,
    });

    expect(drawerClick).toHaveBeenCalledWith({ timeout: 1200 });
    expect(refreshClick).toHaveBeenCalledWith({ timeout: 1200 });
    expect(textContentSpy).toHaveBeenCalledTimes(1);
    expect(textContentSpy).toHaveBeenCalledWith({ timeout: 600 });
    expect(result).toContain('已完成');
  });
});
