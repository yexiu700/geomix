// @vitest-environment jsdom

import {
  BRAND_MAX_PRODUCT_LINES,
  type BrandProductLineDto,
  type BrandRecord,
} from '@geomix/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiError } from '../../lib/envelope';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { BrandProductLinesSection } from './brand-product-lines-section';

const createProductLineMock = vi.fn();
const updateProductLineMock = vi.fn();
const deleteProductLineMock = vi.fn();

vi.mock('../../lib/brands', () => ({
  createBrandProductLine: (...args: unknown[]) => createProductLineMock(...args),
  updateBrandProductLine: (...args: unknown[]) => updateProductLineMock(...args),
  deleteBrandProductLine: (...args: unknown[]) => deleteProductLineMock(...args),
  listBrands: vi.fn(),
  listBrandProductLines: vi.fn(),
}));

const confirmMock = vi.fn();
const notifySuccessMock = vi.fn();
const notifyErrorMock = vi.fn();

vi.mock('../crud/ux-feedback', () => ({
  useUxFeedback: () => ({
    confirm: confirmMock,
    notifySuccess: notifySuccessMock,
    notifyWarning: vi.fn(),
    notifyError: notifyErrorMock,
  }),
}));

function makeBrand(): BrandRecord {
  const now = '2026-11-20T00:00:00.000Z';
  return {
    id: 'b-pl-1',
    name: 'VanguardGroup',
    category: 'Smart Hardware',
    truthAgreementSignedAt: null,
    createdAt: now,
    updatedAt: now,
    markets: [
      {
        id: 'b-pl-1-GLOBAL',
        brandId: 'b-pl-1',
        market: 'GLOBAL',
        locale: 'en-US',
        region: 'US',
        localBrandName: 'VanguardGroup',
        aliases: [],
        ownedDomains: [],
        competitors: [],
        seedPrompts: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function makeLine(id: string, name: string, category: string, sortOrder = 0): BrandProductLineDto {
  const now = '2026-11-20T00:00:00.000Z';
  return {
    id,
    brandId: 'b-pl-1',
    name,
    localNamesJson: {},
    category,
    localCategoriesJson: {},
    seedPromptsJson: {},
    competitorsJson: {},
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
}

describe('BrandProductLinesSection (#387)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/brands');
    useWorkspaceStore.getState().reset(window.localStorage);
    useWorkspaceStore
      .getState()
      .upsertBrand(makeBrand(), { activate: true, persistStorage: window.localStorage });
    createProductLineMock.mockReset();
    updateProductLineMock.mockReset();
    deleteProductLineMock.mockReset();
    confirmMock.mockReset();
    notifySuccessMock.mockReset();
    notifyErrorMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('creates a product line via modal with exact E2E input/button contract and syncs store', async () => {
    const created = makeLine('pl-1', 'Power Station Series', 'Portable Power Station', 0);
    createProductLineMock.mockResolvedValueOnce(created);
    const onChanged = vi.fn();

    render(
      <BrandProductLinesSection
        brand={makeBrand()}
        activeMarket="GLOBAL"
        productLines={[]}
        loading={false}
        error={null}
        readOnly={false}
        onRetry={vi.fn()}
        onProductLinesChanged={onChanged}
      />,
    );

    const section = screen.getByTestId('brand-product-lines-section');
    expect(section.id).toBe('brand-section-product-lines');
    expect(section.textContent).toContain('单品类品牌无需配置产品线');

    fireEvent.click(within(section).getByRole('button', { name: '新增产品线' }));
    const modal = await screen.findByTestId('brand-pl-modal');

    fireEvent.change(within(modal).getByLabelText('产品线名称'), {
      target: { value: 'Power Station Series' },
    });
    fireEvent.change(within(modal).getByLabelText('默认品类'), {
      target: { value: 'Portable Power Station' },
    });

    fireEvent.click(screen.getByTestId('brand-pl-submit-btn'));

    await waitFor(() => {
      expect(createProductLineMock).toHaveBeenCalledWith(
        'b-pl-1',
        expect.objectContaining({
          name: 'Power Station Series',
          category: 'Portable Power Station',
        }),
        expect.anything(),
      );
    });

    expect(useWorkspaceStore.getState().productLines.map((l) => l.id)).toEqual(['pl-1']);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(notifySuccessMock).toHaveBeenCalledWith('已创建产品线「Power Station Series」');
  });

  it('surfaces 409 duplicate product line name error inline inside modal without closing', async () => {
    createProductLineMock.mockRejectedValueOnce(
      new GatewayApiError(409, 40901, '同品牌下已存在同名产品线'),
    );

    render(
      <BrandProductLinesSection
        brand={makeBrand()}
        activeMarket="GLOBAL"
        productLines={[makeLine('pl-1', 'Power Station Series', 'Portable Power Station')]}
        loading={false}
        error={null}
        readOnly={false}
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('brand-add-product-line-btn'));
    const modal = await screen.findByTestId('brand-pl-modal');

    fireEvent.change(within(modal).getByLabelText('产品线名称'), {
      target: { value: 'Power Station Series' },
    });
    fireEvent.change(within(modal).getByLabelText('默认品类'), {
      target: { value: 'Portable Power Station' },
    });
    fireEvent.click(screen.getByTestId('brand-pl-submit-btn'));

    const errAlert = await screen.findByTestId('brand-pl-modal-error');
    expect(errAlert.textContent).toContain('同品牌下已存在同名产品线');
    expect(screen.getByTestId('brand-pl-modal')).toBeTruthy();
  });

  it('edits and deletes a product line gated behind useUxFeedback().confirm()', async () => {
    const line = makeLine('pl-1', 'Home NAS Series', 'Home NAS');
    const updated = makeLine('pl-1', 'Home NAS Pro', 'Desktop NAS');
    useWorkspaceStore.getState().upsertProductLine(line);
    useWorkspaceStore.getState().setActiveProductLine('pl-1');

    updateProductLineMock.mockResolvedValueOnce(updated);
    deleteProductLineMock.mockResolvedValueOnce({ deleted: 1, id: 'pl-1' });
    confirmMock.mockImplementationOnce(({ onOk }: { onOk?: () => Promise<void> | void }) => {
      void onOk?.();
    });

    render(
      <BrandProductLinesSection
        brand={makeBrand()}
        activeMarket="GLOBAL"
        productLines={[line]}
        loading={false}
        error={null}
        readOnly={false}
        onRetry={vi.fn()}
      />,
    );

    // Edit
    fireEvent.click(screen.getByTestId('brand-pl-edit-pl-1'));
    const modal = await screen.findByTestId('brand-pl-modal');
    fireEvent.change(within(modal).getByLabelText('产品线名称'), {
      target: { value: 'Home NAS Pro' },
    });
    fireEvent.change(within(modal).getByLabelText('默认品类'), {
      target: { value: 'Desktop NAS' },
    });
    fireEvent.click(screen.getByTestId('brand-pl-submit-btn'));

    await waitFor(() => {
      expect(updateProductLineMock).toHaveBeenCalledWith(
        'b-pl-1',
        'pl-1',
        expect.objectContaining({ name: 'Home NAS Pro', category: 'Desktop NAS' }),
        expect.anything(),
      );
    });

    // Delete gated behind useUxFeedback().confirm()
    fireEvent.click(screen.getByTestId('brand-pl-delete-pl-1'));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const confirmArg = confirmMock.mock.calls[0]?.[0] as { content?: string };
    expect(confirmArg.content).toContain('品牌通用');

    await waitFor(() => {
      expect(deleteProductLineMock).toHaveBeenCalledWith('b-pl-1', 'pl-1', expect.anything());
    });
    expect(useWorkspaceStore.getState().activeProductLineId).toBeNull();
  });

  it('disables 新增产品线 button and displays limit alert at BRAND_MAX_PRODUCT_LINES (20)', () => {
    const twentyLines = Array.from({ length: BRAND_MAX_PRODUCT_LINES }, (_, idx) =>
      makeLine(`pl-${idx}`, `Line ${idx + 1}`, 'Hardware', idx),
    );

    render(
      <BrandProductLinesSection
        brand={makeBrand()}
        activeMarket="GLOBAL"
        productLines={twentyLines}
        loading={false}
        error={null}
        readOnly={false}
        onRetry={vi.fn()}
      />,
    );

    const addBtn = screen.getByTestId('brand-add-product-line-btn') as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
    expect(screen.getByTestId('brand-product-lines-section').textContent).toContain('20 / 20');
    expect(screen.getByTestId('brand-product-lines-section').textContent).toContain(
      '单品牌最多配置 20 条产品线',
    );
  });
});
