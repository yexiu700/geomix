// @vitest-environment jsdom

import type { BrandRecord } from '@geomix/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandQuickCreateModal } from './brand-quick-create-modal';

const createdBrandStub: BrandRecord = {
  id: 'brand_new_1',
  name: '青松存储',
  category: '家用 NAS',
  truthAgreementSignedAt: null,
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  markets: [
    {
      id: 'bm_1',
      brandId: 'brand_new_1',
      market: 'CN',
      locale: 'zh-CN',
      region: 'CN',
      localBrandName: '青松存储',
      aliases: ['DXP4800'],
      ownedDomains: ['qingsong.cn'],
      competitors: [{ name: '群晖', aliases: [], domains: ['synology.com'] }],
      seedPrompts: ['2026年家用 NAS哪个品牌好？'],
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    },
  ],
};

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.restoreAllMocks();
});

describe('BrandQuickCreateModal (60s 2-step brand wizard)', () => {
  it('validates Step 1 fields, submits aliases + normalized competitor domains, transitions to Step 2 AI extract, and saves facts with compliance checkbox', async () => {
    const onCreateBrand = vi.fn(async () => createdBrandStub);
    const onExtractFacts = vi.fn(async () => ({
      sourceType: 'URL_EXTRACT' as const,
      sourceUrl: 'https://qingsong.cn',
      fileName: null,
      extractedChars: 120,
      fake: true,
      facts: [
        { slot: 'PRODUCT_SPECS' as const, title: '核心参数', content: '四盘位 NAS，28dB 静音' },
        { slot: 'DIFFERENTIATORS' as const, title: '差异卖点', content: '免工具快拆盘架' },
        { slot: 'CREDENTIALS' as const, title: '权威资质', content: 'ISO9001 认证' },
        { slot: 'CASE_STUDIES' as const, title: '客户案例', content: '服务 12,000+ 家庭' },
      ],
    }));
    const onSaveFacts = vi.fn(async () => ({
      brandId: 'brand_new_1',
      truthAgreementSignedAt: '2026-11-20T01:00:00.000Z',
      totalChars: 60,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [],
    }));
    const onBrandFactsSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <BrandQuickCreateModal
        open={true}
        onClose={onClose}
        onCreateBrand={onCreateBrand}
        onExtractFacts={onExtractFacts}
        onSaveFacts={onSaveFacts}
        onBrandFactsSaved={onBrandFactsSaved}
      />,
    );

    const dialog = await screen.findByRole('dialog', { name: '60 秒创建品牌' });
    expect(within(dialog).getByTestId('brand-quick-create')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('品牌名称'), { target: { value: '青松存储' } });
    fireEvent.change(within(dialog).getByLabelText('品牌别名'), { target: { value: 'DXP4800' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '添加' }));
    fireEvent.change(within(dialog).getByLabelText('所属品类'), { target: { value: '家用 NAS' } });
    fireEvent.change(within(dialog).getByLabelText('官网域名'), {
      target: { value: 'https://www.qingsong.cn/products' },
    });

    // Add a competitor row with domain
    fireEvent.click(within(dialog).getByRole('button', { name: '+ 添加竞品' }));
    fireEvent.change(within(dialog).getByLabelText('竞品名称 1'), { target: { value: '群晖' } });
    fireEvent.change(within(dialog).getByLabelText('竞品官网域名 1'), {
      target: { value: 'https://www.synology.com' },
    });
    expect(
      within(dialog).getByRole('button', { name: '移除竞品 群晖' }).querySelector('svg'),
    ).toBeTruthy();
    expect(dialog.querySelectorAll('button.ant-btn-dangerous')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: '创建并进入工作区' }));

    await waitFor(() => {
      expect(onCreateBrand).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '青松存储',
          category: '家用 NAS',
          aliases: ['DXP4800'],
          ownedDomains: ['qingsong.cn'],
          competitors: [{ name: '群晖', aliases: [], domains: ['synology.com'] }],
        }),
      );
    });

    // Step 2: URL pre-filled with https://qingsong.cn
    const urlInput = await within(dialog).findByLabelText('官网链接');
    expect((urlInput as HTMLInputElement).value).toBe('https://qingsong.cn');

    fireEvent.click(within(dialog).getByRole('button', { name: 'AI 提炼 4 块事实卡（免费）' }));
    await waitFor(() => {
      expect(onExtractFacts).toHaveBeenCalledWith('brand_new_1', {
        sourceType: 'URL_EXTRACT',
        url: 'https://qingsong.cn',
      });
    });

    // Try saving before checking compliance checkbox -> shows warning, does not call onSaveFacts
    const saveBtn = await within(dialog).findByRole('button', { name: '保存事实卡并完成' });
    fireEvent.click(saveBtn);
    expect(await within(dialog).findByText(/请先勾选品牌事实真实性与合规承诺/)).toBeTruthy();
    expect(onSaveFacts).not.toHaveBeenCalled();

    // Check single lightweight compliance checkbox and save
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(onSaveFacts).toHaveBeenCalledTimes(1);
      expect(onBrandFactsSaved).toHaveBeenCalledWith('brand_new_1', '2026-11-20T01:00:00.000Z');
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('allows skipping Step 2 directly into the workspace', async () => {
    const onCreateBrand = vi.fn(async () => createdBrandStub);
    const onClose = vi.fn();

    render(
      <BrandQuickCreateModal
        open={true}
        onClose={onClose}
        onCreateBrand={onCreateBrand}
        onExtractFacts={vi.fn()}
        onSaveFacts={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole('dialog', { name: '60 秒创建品牌' });
    fireEvent.change(within(dialog).getByLabelText('品牌名称'), { target: { value: '青松存储' } });
    fireEvent.change(within(dialog).getByLabelText('所属品类'), { target: { value: '家用 NAS' } });
    fireEvent.change(within(dialog).getByLabelText('官网域名'), {
      target: { value: 'qingsong.cn' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建并进入工作区' }));

    const skipBtn = await within(dialog).findByRole('button', { name: '跳过，直接进入' });
    fireEvent.click(skipBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
