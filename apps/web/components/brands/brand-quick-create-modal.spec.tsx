// @vitest-environment jsdom

import {
  GLOBAL_CJK_BRAND_NAME_ERROR,
  type BrandRecord,
  type GeoMarket,
  type UpdateBrandMarketInput,
} from '@geomix/shared';
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

  it('Tier 5 #5: resets allowCjkGlobalIdentity checkbox when CJK is cleared and later re-entered in another GLOBAL field', async () => {
    render(
      <BrandQuickCreateModal
        open={true}
        onClose={vi.fn()}
        onCreateBrand={vi.fn(async () => createdBrandStub)}
        onExtractFacts={vi.fn()}
        onSaveFacts={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole('dialog', { name: '60 秒创建品牌' });
    fireEvent.change(within(dialog).getByLabelText('品牌名称'), { target: { value: '绿联' } });
    fireEvent.click(within(dialog).getByLabelText(/海外市场/));

    const cjkCheckbox = (await within(dialog).findByTestId(
      'quick-create-allow-cjk-global-checkbox',
    )) as HTMLInputElement;
    fireEvent.click(cjkCheckbox);
    expect(cjkCheckbox.checked).toBe(true);

    // Clear CJK by providing English global local brand name -> checkbox unmounts and resets
    fireEvent.change(within(dialog).getByLabelText('海外英文品牌名'), {
      target: { value: 'UGREEN' },
    });
    await waitFor(() => {
      expect(within(dialog).queryByTestId('quick-create-allow-cjk-global-checkbox')).toBeNull();
    });

    // Re-enter CJK in global local category -> checkbox MUST reappear UNCHECKED
    fireEvent.change(within(dialog).getByLabelText('海外英文品类'), {
      target: { value: '氮化镓快充' },
    });
    const reappeared = (await within(dialog).findByTestId(
      'quick-create-allow-cjk-global-checkbox',
    )) as HTMLInputElement;
    expect(reappeared.checked).toBe(false);
  });

  it('auto-triggers Step 3 AI market prefill after Step 2 facts save and persists merged config via PATCH (#405)', async () => {
    const onCreateBrand = vi.fn(async () => createdBrandStub);
    const onExtractFacts = vi.fn(async () => ({
      sourceType: 'URL_EXTRACT' as const,
      sourceUrl: 'https://qingsong.cn',
      fileName: null,
      extractedChars: 120,
      fake: true,
      facts: [
        {
          slot: 'PRODUCT_SPECS' as const,
          title: '核心参数',
          content: '四盘位 NAS PV-400，28dB 静音',
        },
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
    const onSuggestMarketConfig = vi.fn(async () => ({
      market: 'CN' as const,
      aliases: ['PV-400', 'PV-800'],
      competitors: [{ name: '极光盘盒', aliases: [], domains: ['aurorabox.example.com'] }],
      seedPrompts: [
        { prompt: '四盘位静音家用 NAS 怎么挑？', intent: 'BUYING_GUIDE' as const },
        { prompt: '青松存储 PV-400 静音实测怎么样？', intent: 'SKU_REVIEW' as const },
      ],
      controlPrompts: ['家用路由器选购要点'],
      fallbackUsed: false,
    }));
    const onSaveMarketConfig = vi.fn(async () => createdBrandStub);
    const onClose = vi.fn();

    render(
      <BrandQuickCreateModal
        open={true}
        onClose={onClose}
        onCreateBrand={onCreateBrand}
        onExtractFacts={onExtractFacts}
        onSaveFacts={onSaveFacts}
        onSuggestMarketConfig={onSuggestMarketConfig}
        onSaveMarketConfig={onSaveMarketConfig}
      />,
    );

    const dialog = await screen.findByRole('dialog', { name: '60 秒创建品牌' });
    fireEvent.change(within(dialog).getByLabelText('品牌名称'), { target: { value: '青松存储' } });
    fireEvent.change(within(dialog).getByLabelText('所属品类'), { target: { value: '家用 NAS' } });
    fireEvent.change(within(dialog).getByLabelText('官网域名'), {
      target: { value: 'qingsong.cn' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建并进入工作区' }));

    // Step 2: extract and save facts
    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'AI 提炼 4 块事实卡（免费）' }),
    );
    const saveFactsBtn = await within(dialog).findByRole('button', { name: '保存事实卡并完成' });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(saveFactsBtn);

    // Step 3 opens automatically via onSuggestMarketConfig
    await waitFor(() => {
      expect(onSuggestMarketConfig).toHaveBeenCalledWith('brand_new_1', 'CN', {});
    });
    expect(onClose).not.toHaveBeenCalled();

    const prefillModal = await screen.findByTestId('brand-ai-suggest-modal');
    expect(within(prefillModal).getByTestId('ai-suggest-group-seedPrompts')).toBeTruthy();

    // Uncheck PV-800 before saving
    fireEvent.click(within(prefillModal).getByLabelText('勾选别名建议 2'));
    fireEvent.click(within(prefillModal).getByRole('button', { name: '保存市场配置并完成' }));

    await waitFor(() => {
      expect(onSaveMarketConfig).toHaveBeenCalledWith(
        'brand_new_1',
        'CN',
        expect.objectContaining({
          aliases: ['DXP4800', 'PV-400'],
          competitors: [
            { name: '群晖', aliases: [], domains: ['synology.com'] },
            { name: '极光盘盒', aliases: [], domains: ['aurorabox.example.com'] },
          ],
          seedPrompts: [
            '2026年家用 NAS哪个品牌好？',
            '四盘位静音家用 NAS 怎么挑？',
            '青松存储 PV-400 静音实测怎么样？',
          ],
          controlPrompts: ['家用路由器选购要点'],
        }),
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('allows skipping Step 3 AI market prefill directly into workspace without PATCH', async () => {
    const onCreateBrand = vi.fn(async () => createdBrandStub);
    const onExtractFacts = vi.fn(async () => ({
      sourceType: 'URL_EXTRACT' as const,
      sourceUrl: 'https://qingsong.cn',
      fileName: null,
      extractedChars: 120,
      fake: true,
      facts: [
        { slot: 'PRODUCT_SPECS' as const, title: '核心参数', content: '四盘位 NAS' },
        { slot: 'DIFFERENTIATORS' as const, title: '差异卖点', content: '免工具盘架' },
        { slot: 'CREDENTIALS' as const, title: '权威资质', content: 'ISO9001' },
        { slot: 'CASE_STUDIES' as const, title: '客户案例', content: '家庭备份' },
      ],
    }));
    const onSaveFacts = vi.fn(async () => ({
      brandId: 'brand_new_1',
      truthAgreementSignedAt: '2026-11-20T01:00:00.000Z',
      totalChars: 30,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [],
    }));
    const onSuggestMarketConfig = vi.fn(async () => ({
      market: 'CN' as const,
      aliases: ['PV-400'],
      competitors: [],
      seedPrompts: [{ prompt: '四盘位静音家用 NAS 怎么挑？', intent: 'BUYING_GUIDE' as const }],
      controlPrompts: [],
      fallbackUsed: false,
    }));
    const onSaveMarketConfig = vi.fn();
    const onClose = vi.fn();

    render(
      <BrandQuickCreateModal
        open={true}
        onClose={onClose}
        onCreateBrand={onCreateBrand}
        onExtractFacts={onExtractFacts}
        onSaveFacts={onSaveFacts}
        onSuggestMarketConfig={onSuggestMarketConfig}
        onSaveMarketConfig={onSaveMarketConfig}
      />,
    );

    const dialog = await screen.findByRole('dialog', { name: '60 秒创建品牌' });
    fireEvent.change(within(dialog).getByLabelText('品牌名称'), { target: { value: '青松存储' } });
    fireEvent.change(within(dialog).getByLabelText('所属品类'), { target: { value: '家用 NAS' } });
    fireEvent.change(within(dialog).getByLabelText('官网域名'), {
      target: { value: 'qingsong.cn' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建并进入工作区' }));

    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'AI 提炼 4 块事实卡（免费）' }),
    );
    const saveFactsBtn = await within(dialog).findByRole('button', { name: '保存事实卡并完成' });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(saveFactsBtn);

    const prefillModal = await screen.findByTestId('brand-ai-suggest-modal');
    fireEvent.click(within(prefillModal).getByRole('button', { name: '跳过，直接进入' }));

    expect(onSaveMarketConfig).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits unchanged CJK localBrandName when saving Step 3 GLOBAL market prefill after Step 1 CJK opt-in (#385 x #405)', async () => {
    const globalCjkBrandStub: BrandRecord = {
      id: 'brand_global_cjk_1',
      name: '茶颜悦色',
      category: '新茶饮',
      truthAgreementSignedAt: null,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
      markets: [
        {
          id: 'bm_global_1',
          brandId: 'brand_global_cjk_1',
          market: 'GLOBAL',
          locale: 'en-US',
          region: 'US',
          localBrandName: '茶颜悦色',
          localCategory: 'Specialty Tea',
          aliases: [],
          ownedDomains: ['chayanyuese.example.com'],
          competitors: [],
          seedPrompts: [],
          createdAt: '2026-11-20T00:00:00.000Z',
          updatedAt: '2026-11-20T00:00:00.000Z',
        },
      ],
    };
    const onCreateBrand = vi.fn(async () => globalCjkBrandStub);
    const onExtractFacts = vi.fn(async () => ({
      sourceType: 'URL_EXTRACT' as const,
      sourceUrl: 'https://chayanyuese.example.com',
      fileName: null,
      extractedChars: 120,
      fake: true,
      facts: [
        { slot: 'PRODUCT_SPECS' as const, title: '核心参数', content: 'Fresh milk tea craft' },
        { slot: 'DIFFERENTIATORS' as const, title: '差异卖点', content: 'Signature oolong cream' },
        { slot: 'CREDENTIALS' as const, title: '权威资质', content: 'ISO22000 certified' },
        { slot: 'CASE_STUDIES' as const, title: '客户案例', content: '500+ stores' },
      ],
    }));
    const onSaveFacts = vi.fn(async () => ({
      brandId: 'brand_global_cjk_1',
      truthAgreementSignedAt: '2026-11-20T01:00:00.000Z',
      totalChars: 60,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [],
    }));
    const onSuggestMarketConfig = vi.fn(async () => ({
      market: 'GLOBAL' as const,
      localBrandName: 'Chayan Tea',
      aliases: ['Chayan'],
      competitors: [],
      seedPrompts: [
        { prompt: 'Best Chinese milk tea brand in US?', intent: 'BUYING_GUIDE' as const },
      ],
      controlPrompts: [],
      fallbackUsed: false,
    }));
    const onSaveMarketConfig = vi.fn<
      (brandId: string, market: GeoMarket, input: UpdateBrandMarketInput) => Promise<BrandRecord>
    >(async () => globalCjkBrandStub);
    const onClose = vi.fn();

    render(
      <BrandQuickCreateModal
        open={true}
        onClose={onClose}
        onCreateBrand={onCreateBrand}
        onExtractFacts={onExtractFacts}
        onSaveFacts={onSaveFacts}
        onSuggestMarketConfig={onSuggestMarketConfig}
        onSaveMarketConfig={onSaveMarketConfig}
      />,
    );

    const dialog = await screen.findByRole('dialog', { name: '60 秒创建品牌' });
    fireEvent.change(within(dialog).getByLabelText('品牌名称'), { target: { value: '茶颜悦色' } });
    fireEvent.change(within(dialog).getByLabelText('所属品类'), { target: { value: '新茶饮' } });
    fireEvent.change(within(dialog).getByLabelText('官网域名'), {
      target: { value: 'chayanyuese.example.com' },
    });
    // Switch from default CN to GLOBAL only
    fireEvent.click(within(dialog).getByLabelText(/海外市场/));
    fireEvent.click(within(dialog).getByLabelText(/国内市场/));
    fireEvent.change(within(dialog).getByLabelText('海外英文品类'), {
      target: { value: 'Specialty Tea' },
    });
    fireEvent.change(within(dialog).getByLabelText('海外官网域名'), {
      target: { value: 'chayanyuese.example.com' },
    });

    const cjkCheckbox = (await within(dialog).findByTestId(
      'quick-create-allow-cjk-global-checkbox',
    )) as HTMLInputElement;
    fireEvent.click(cjkCheckbox);
    expect(cjkCheckbox.checked).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: '创建并进入工作区' }));

    // Step 2: extract and save facts -> auto-enters Step 3 for GLOBAL
    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'AI 提炼 4 块事实卡（免费）' }),
    );
    const saveFactsBtn = await within(dialog).findByRole('button', { name: '保存事实卡并完成' });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(saveFactsBtn);

    await waitFor(() => {
      expect(onSuggestMarketConfig).toHaveBeenCalledWith('brand_global_cjk_1', 'GLOBAL', {});
    });

    const prefillModal = await screen.findByTestId('brand-ai-suggest-modal');
    // Uncheck suggested English localBrandName so CJK localBrandName remains unchanged
    fireEvent.click(within(prefillModal).getByLabelText('勾选建议海外英文品牌名'));
    fireEvent.click(within(prefillModal).getByRole('button', { name: '保存市场配置并完成' }));

    await waitFor(() => {
      expect(onSaveMarketConfig).toHaveBeenCalledTimes(1);
    });
    const [savedBrandId, savedMarket, savedPayload] = onSaveMarketConfig.mock.calls[0]!;
    expect(savedBrandId).toBe('brand_global_cjk_1');
    expect(savedMarket).toBe('GLOBAL');
    expect(savedPayload).not.toHaveProperty('localBrandName');
    expect(savedPayload).toMatchObject({
      localCategory: 'Specialty Tea',
      aliases: ['Chayan'],
      seedPrompts: ['Best Chinese milk tea brand in US?'],
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Step 3 form mounted and editable on GLOBAL CJK rejection or save error so user can fix and succeed on retry (Bug #1B)', async () => {
    const globalBrandStub: BrandRecord = {
      id: 'brand_global_err_1',
      name: '茶颜悦色',
      category: '新茶饮',
      truthAgreementSignedAt: null,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
      markets: [
        {
          id: 'bm_global_err_1',
          brandId: 'brand_global_err_1',
          market: 'GLOBAL',
          locale: 'en-US',
          region: 'US',
          localBrandName: '茶颜悦色',
          localCategory: 'Specialty Tea',
          aliases: [],
          ownedDomains: ['chayan.example.com'],
          competitors: [],
          seedPrompts: [],
          createdAt: '2026-11-20T00:00:00.000Z',
          updatedAt: '2026-11-20T00:00:00.000Z',
        },
      ],
    };
    const onCreateBrand = vi.fn(async () => globalBrandStub);
    const onExtractFacts = vi.fn(async () => ({
      sourceType: 'URL_EXTRACT' as const,
      sourceUrl: 'https://chayan.example.com',
      fileName: null,
      extractedChars: 100,
      fake: true,
      facts: [
        { slot: 'PRODUCT_SPECS' as const, title: '核心参数', content: 'Fresh tea' },
        { slot: 'DIFFERENTIATORS' as const, title: '差异卖点', content: 'Oolong cream' },
        { slot: 'CREDENTIALS' as const, title: '权威资质', content: 'ISO22000' },
        { slot: 'CASE_STUDIES' as const, title: '客户案例', content: '500 stores' },
      ],
    }));
    const onSaveFacts = vi.fn(async () => ({
      brandId: 'brand_global_err_1',
      truthAgreementSignedAt: '2026-11-20T01:00:00.000Z',
      totalChars: 40,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [],
    }));
    const onSuggestMarketConfig = vi.fn(async () => ({
      market: 'GLOBAL' as const,
      localBrandName: 'Chayan Tea',
      localCategory: 'Specialty Tea',
      aliases: ['Chayan'],
      competitors: [],
      seedPrompts: [{ prompt: 'Best Chinese milk tea brand?', intent: 'BUYING_GUIDE' as const }],
      controlPrompts: [],
      fallbackUsed: false,
    }));
    const onSaveMarketConfig = vi
      .fn<
        (brandId: string, market: GeoMarket, input: UpdateBrandMarketInput) => Promise<BrandRecord>
      >()
      .mockRejectedValueOnce(new Error('临时保存失败，请重试'))
      .mockResolvedValueOnce(globalBrandStub);
    const onClose = vi.fn();

    render(
      <BrandQuickCreateModal
        open={true}
        onClose={onClose}
        onCreateBrand={onCreateBrand}
        onExtractFacts={onExtractFacts}
        onSaveFacts={onSaveFacts}
        onSuggestMarketConfig={onSuggestMarketConfig}
        onSaveMarketConfig={onSaveMarketConfig}
      />,
    );

    const dialog = await screen.findByRole('dialog', { name: '60 秒创建品牌' });
    fireEvent.change(within(dialog).getByLabelText('品牌名称'), { target: { value: '茶颜悦色' } });
    fireEvent.change(within(dialog).getByLabelText('所属品类'), { target: { value: '新茶饮' } });
    fireEvent.change(within(dialog).getByLabelText('官网域名'), {
      target: { value: 'chayan.example.com' },
    });
    fireEvent.click(within(dialog).getByLabelText(/海外市场/));
    fireEvent.click(within(dialog).getByLabelText(/国内市场/));
    fireEvent.change(within(dialog).getByLabelText('海外英文品类'), {
      target: { value: 'Specialty Tea' },
    });
    const cjkCheckbox = await within(dialog).findByTestId('quick-create-allow-cjk-global-checkbox');
    fireEvent.click(cjkCheckbox);
    fireEvent.click(within(dialog).getByRole('button', { name: '创建并进入工作区' }));

    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'AI 提炼 4 块事实卡（免费）' }),
    );
    const saveFactsBtn = await within(dialog).findByRole('button', { name: '保存事实卡并完成' });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(saveFactsBtn);

    const prefillModal = await screen.findByTestId('brand-ai-suggest-modal');
    expect(within(prefillModal).getByTestId('ai-suggest-group-localIdentity')).toBeTruthy();

    // 1. User edits GLOBAL localBrandName to include CJK Extension B -> blocked inline, form stays mounted!
    const nameInput = within(prefillModal).getByLabelText(
      '编辑建议海外英文品牌名',
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Chayan 𠀀' } });
    fireEvent.click(within(prefillModal).getByTestId('brand-ai-suggest-confirm-btn'));

    const cjkAlert = await within(prefillModal).findByTestId('brand-ai-suggest-error');
    expect(cjkAlert.textContent).toContain(GLOBAL_CJK_BRAND_NAME_ERROR);
    expect(onSaveMarketConfig).not.toHaveBeenCalled();
    expect(within(prefillModal).getByTestId('ai-suggest-group-localIdentity')).toBeTruthy();

    // 2. Fix name back to English -> server save fails once -> alert shown above STILL mounted form
    fireEvent.change(nameInput, { target: { value: 'Chayan Tea' } });
    fireEvent.click(within(prefillModal).getByTestId('brand-ai-suggest-confirm-btn'));

    await waitFor(() => {
      expect(onSaveMarketConfig).toHaveBeenCalledTimes(1);
    });
    const saveAlert = await within(prefillModal).findByTestId('brand-ai-suggest-error');
    expect(saveAlert.textContent).toContain('临时保存失败，请重试');
    expect(within(prefillModal).getByTestId('ai-suggest-group-localIdentity')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    // 3. Retry save succeeds cleanly
    fireEvent.click(within(prefillModal).getByTestId('brand-ai-suggest-confirm-btn'));
    await waitFor(() => {
      expect(onSaveMarketConfig).toHaveBeenCalledTimes(2);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('disables confirm button and shows retry action when Step 3 suggestion fetch fails with !suggestion (Bug #1B)', async () => {
    const onCreateBrand = vi.fn(async () => createdBrandStub);
    const onExtractFacts = vi.fn(async () => ({
      sourceType: 'URL_EXTRACT' as const,
      sourceUrl: 'https://qingsong.cn',
      fileName: null,
      extractedChars: 60,
      fake: true,
      facts: [
        { slot: 'PRODUCT_SPECS' as const, title: '核心参数', content: '四盘位 NAS' },
        { slot: 'DIFFERENTIATORS' as const, title: '差异卖点', content: '静音风道' },
        { slot: 'CREDENTIALS' as const, title: '权威资质', content: 'ISO9001' },
        { slot: 'CASE_STUDIES' as const, title: '客户案例', content: '家庭备份' },
      ],
    }));
    const onSaveFacts = vi.fn(async () => ({
      brandId: 'brand_new_1',
      truthAgreementSignedAt: '2026-11-20T01:00:00.000Z',
      totalChars: 40,
      vectorIndexRequired: false,
      vectorIndexed: false,
      items: [],
    }));
    const onSuggestMarketConfig = vi.fn().mockRejectedValueOnce(new Error('AI 接口暂不可用'));
    const onSaveMarketConfig = vi.fn();

    render(
      <BrandQuickCreateModal
        open={true}
        onClose={vi.fn()}
        onCreateBrand={onCreateBrand}
        onExtractFacts={onExtractFacts}
        onSaveFacts={onSaveFacts}
        onSuggestMarketConfig={onSuggestMarketConfig}
        onSaveMarketConfig={onSaveMarketConfig}
      />,
    );

    const dialog = await screen.findByRole('dialog', { name: '60 秒创建品牌' });
    fireEvent.change(within(dialog).getByLabelText('品牌名称'), { target: { value: '青松存储' } });
    fireEvent.change(within(dialog).getByLabelText('所属品类'), { target: { value: '家用 NAS' } });
    fireEvent.change(within(dialog).getByLabelText('官网域名'), {
      target: { value: 'qingsong.cn' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建并进入工作区' }));

    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'AI 提炼 4 块事实卡（免费）' }),
    );
    const saveFactsBtn = await within(dialog).findByRole('button', { name: '保存事实卡并完成' });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(saveFactsBtn);

    const prefillModal = await screen.findByTestId('brand-ai-suggest-modal');
    const errAlert = await within(prefillModal).findByTestId('brand-ai-suggest-error');
    expect(errAlert.textContent).toContain('AI 接口暂不可用');
    expect(within(prefillModal).getByRole('button', { name: /重\s*试/ })).toBeTruthy();

    const confirmBtn = within(prefillModal).getByTestId(
      'brand-ai-suggest-confirm-btn',
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    expect(onSaveMarketConfig).not.toHaveBeenCalled();
  });
});
