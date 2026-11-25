// @vitest-environment jsdom

import type { BrandFactsResponse, ExtractBrandFactsResponse } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as brandsApi from '../../lib/brands';
import * as freshness from '../../lib/tab-freshness';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { QuickFactExtractModal } from './quick-fact-extract-modal';

vi.mock('../../lib/brands', async () => {
  const actual = await vi.importActual<typeof import('../../lib/brands')>('../../lib/brands');
  return {
    ...actual,
    extractBrandFacts: vi.fn(),
    saveBrandFacts: vi.fn(),
  };
});

const extractMock = vi.mocked(brandsApi.extractBrandFacts);
const saveMock = vi.mocked(brandsApi.saveBrandFacts);

const SAMPLE_EXTRACT_RES: ExtractBrandFactsResponse = {
  sourceType: 'URL_EXTRACT',
  sourceUrl: 'https://astravolt.io/product',
  fileName: null,
  extractedChars: 128,
  facts: [
    { slot: 'PRODUCT_SPECS', title: '产品与参数', content: '额定功率 2000W，满载噪音 28dB' },
    { slot: 'DIFFERENTIATORS', title: '核心卖点', content: '支持 1 小时快充至 80%' },
    { slot: 'CREDENTIALS', title: '资质认证', content: 'UL / CE 双认证' },
    { slot: 'CASE_STUDIES', title: '客户案例', content: '' },
  ],
  fake: true,
};

const SAMPLE_SAVED_RES: BrandFactsResponse = {
  brandId: 'brand_1',
  truthAgreementSignedAt: '2026-11-25T10:00:00.000Z',
  totalChars: 64,
  vectorIndexRequired: false,
  vectorIndexed: false,
  items: [
    {
      id: 'fact_1',
      brandId: 'brand_1',
      productLineId: null,
      slot: 'PRODUCT_SPECS',
      title: '产品与参数',
      content: '额定功率 2000W，满载噪音 28dB',
      sourceType: 'URL_EXTRACT',
      sourceUrl: 'https://astravolt.io/product',
      indexStatus: 'NONE',
      createdAt: '2026-11-25T10:00:00.000Z',
      updatedAt: '2026-11-25T10:00:00.000Z',
    },
  ],
};

describe('QuickFactExtractModal (#385)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractMock.mockResolvedValue(SAMPLE_EXTRACT_RES);
    saveMock.mockResolvedValue(SAMPLE_SAVED_RES);
  });

  afterEach(() => {
    cleanup();
  });

  it('prefills domain URL, supports URL extract -> review -> truth check -> save & resume, and triggers skip escape hatch', async () => {
    const onClose = vi.fn();
    const onSkipAndGenerate = vi.fn();
    const onSaved = vi.fn();
    const freshnessSpy = vi.spyOn(freshness, 'invalidateFreshness');
    const markTruthSpy = vi.spyOn(useWorkspaceStore.getState(), 'markBrandTruthSigned');

    render(
      <QuickFactExtractModal
        open
        brandId="brand_1"
        brandName="星曜智储"
        defaultDomain="astravolt.io"
        truthSignedAt={null}
        onClose={onClose}
        onSkipAndGenerate={onSkipAndGenerate}
        onSaved={onSaved}
      />,
    );

    const urlInput = screen.getByLabelText('官网链接') as HTMLInputElement;
    expect(urlInput.value).toBe('https://astravolt.io');

    // Escape hatch works immediately
    fireEvent.click(screen.getByTestId('quick-fact-skip-btn'));
    expect(onSkipAndGenerate).toHaveBeenCalledTimes(1);

    // Run URL extraction
    fireEvent.change(urlInput, { target: { value: 'https://astravolt.io/product' } });
    fireEvent.click(screen.getByTestId('quick-fact-extract-btn'));

    await waitFor(() => {
      expect(extractMock).toHaveBeenCalledWith(
        'brand_1',
        { sourceType: 'URL_EXTRACT', url: 'https://astravolt.io/product' },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    expect(await screen.findByTestId('quick-fact-review-list')).toBeTruthy();
    const specsArea = screen.getByLabelText('核心产品与参数') as HTMLTextAreaElement;
    expect(specsArea.value).toContain('2000W');

    // Attempt save without truth checkbox -> blocked
    fireEvent.click(screen.getByTestId('quick-fact-save-btn'));
    expect(await screen.findByText(/请先勾选品牌事实真实性与合规承诺/)).toBeTruthy();
    expect(saveMock).not.toHaveBeenCalled();

    // Check truth checkbox and submit
    fireEvent.click(screen.getByTestId('quick-fact-truth-checkbox'));
    fireEvent.click(screen.getByTestId('quick-fact-save-btn'));

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledTimes(1);
    });
    expect(saveMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        truthAgreed: true,
        facts: expect.arrayContaining([
          expect.objectContaining({
            slot: 'PRODUCT_SPECS',
            content: '额定功率 2000W，满载噪音 28dB',
            sourceType: 'URL_EXTRACT',
          }),
        ]),
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(SAMPLE_SAVED_RES);
    expect(markTruthSpy).toHaveBeenCalledWith('brand_1', SAMPLE_SAVED_RES.truthAgreementSignedAt);
    expect(freshnessSpy).toHaveBeenCalledWith('brand-facts');
  });

  it('validates MANUAL min length, DOC_UPLOAD extension, and surfaces 429 rate-limit copy', async () => {
    render(
      <QuickFactExtractModal
        open
        brandId="brand_1"
        onClose={vi.fn()}
        onSkipAndGenerate={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    // Switch to MANUAL paste tab
    fireEvent.click(screen.getByRole('tab', { name: '粘贴资料' }));
    fireEvent.change(screen.getByLabelText('粘贴产品资料'), { target: { value: '太短了' } });
    fireEvent.click(screen.getByTestId('quick-fact-extract-btn'));
    expect(await screen.findByText(/至少粘贴 10 个字/)).toBeTruthy();
    expect(extractMock).not.toHaveBeenCalled();

    // 429 rate-limit error copy
    extractMock.mockRejectedValueOnce(
      Object.assign(new Error('Too Many Requests'), { status: 429 }),
    );
    fireEvent.change(screen.getByLabelText('粘贴产品资料'), {
      target: { value: '这是一段超过十个字的真实产品规格与测试说明资料。' },
    });
    fireEvent.click(screen.getByTestId('quick-fact-extract-btn'));
    expect(await screen.findByText('提炼请求过于频繁，请稍后再试')).toBeTruthy();

    // Switch to DOC_UPLOAD and test invalid extension rejection
    fireEvent.click(screen.getByRole('tab', { name: '上传文档' }));
    const fileInput = screen.getByLabelText('上传品牌资料文档') as HTMLInputElement;
    const badFile = new File(['abc'], 'malware.exe', { type: 'application/octet-stream' });
    fireEvent.change(fileInput, { target: { files: [badFile] } });
    fireEvent.click(screen.getByTestId('quick-fact-extract-btn'));
    expect(await screen.findByText(/仅支持上传 TXT、MD、PDF/)).toBeTruthy();
  });
});
