// @vitest-environment jsdom

import type { BrandProductLineDto, BrandRecord } from '@geomix/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { ProductLineSelectorPill } from './product-line-selector-pill';

function makeBrand(id: string): BrandRecord {
  const now = '2026-11-20T00:00:00.000Z';
  return {
    id,
    name: `Brand ${id}`,
    category: 'Hardware',
    truthAgreementSignedAt: null,
    createdAt: now,
    updatedAt: now,
    markets: [
      {
        id: `${id}-GLOBAL`,
        brandId: id,
        market: 'GLOBAL',
        locale: 'en-US',
        region: 'US',
        localBrandName: `Brand ${id}`,
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

function makeLine(
  id: string,
  brandId: string,
  name: string,
  sortOrder: number,
): BrandProductLineDto {
  const now = '2026-11-20T00:00:00.000Z';
  return {
    id,
    brandId,
    name,
    localNamesJson: {},
    category: name,
    localCategoriesJson: {},
    seedPromptsJson: {},
    competitorsJson: {},
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
}

describe('ProductLineSelectorPill (#387)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/home');
    useWorkspaceStore.getState().reset(window.localStorage);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders ZERO DOM nodes when brand has 0 product lines or productLines belong to another brand (Zero-Noise Rule)', () => {
    useWorkspaceStore
      .getState()
      .upsertBrand(makeBrand('b-1'), { activate: true, persistStorage: window.localStorage });

    const { container } = render(<ProductLineSelectorPill />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('product-line-switcher')).toBeNull();
    expect(screen.queryByText('全部产品线')).toBeNull();

    // Even if store holds lines for a different brandId, must render null
    useWorkspaceStore.setState({
      productLinesBrandId: 'b-other',
      productLines: [makeLine('pl-x', 'b-other', 'Foreign Line', 0)],
      productLinesLoaded: true,
    });
    const { container: c2 } = render(<ProductLineSelectorPill />);
    expect(c2.firstChild).toBeNull();
  });

  it('renders exact pills and switches activeProductLineId + URL when brand has >= 1 product line', () => {
    useWorkspaceStore
      .getState()
      .upsertBrand(makeBrand('b-1'), { activate: true, persistStorage: window.localStorage });
    useWorkspaceStore
      .getState()
      .upsertProductLine(makeLine('pl-1', 'b-1', 'Power Station Series', 0));
    useWorkspaceStore.getState().upsertProductLine(makeLine('pl-2', 'b-1', 'Home NAS Series', 1));

    render(<ProductLineSelectorPill />);

    const switcher = screen.getByTestId('product-line-switcher');
    expect(switcher.getAttribute('role')).toBe('radiogroup');

    const allBtn = screen.getByTestId('product-line-option-all');
    const line1Btn = screen.getByTestId('product-line-option-pl-1');
    const line2Btn = screen.getByTestId('product-line-option-pl-2');

    expect(allBtn.textContent).toBe('全部');
    expect(line1Btn.textContent).toBe('Power Station Series');
    expect(line2Btn.textContent).toBe('Home NAS Series');
    expect(allBtn.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(line1Btn);
    expect(useWorkspaceStore.getState().activeProductLineId).toBe('pl-1');
    expect(line1Btn.getAttribute('aria-checked')).toBe('true');
    expect(allBtn.getAttribute('aria-checked')).toBe('false');
    expect(new URLSearchParams(window.location.search).get('productLineId')).toBe('pl-1');

    fireEvent.click(allBtn);
    expect(useWorkspaceStore.getState().activeProductLineId).toBeNull();
    expect(allBtn.getAttribute('aria-checked')).toBe('true');
    expect(new URLSearchParams(window.location.search).get('productLineId')).toBeNull();
  });
});
