// @vitest-environment jsdom
import type { PublicPrPacketDto } from '@geomix/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as distributionApi from '../../lib/distribution';
import { GatewayApiError } from '../../lib/envelope';
import * as studioApi from '../../lib/studio';
import { PrSharePacketView } from './pr-share-packet-view';

function makePacket(overrides?: Partial<PublicPrPacketDto>): PublicPrPacketDto {
  return {
    market: 'GLOBAL',
    locale: 'en-US',
    brandName: 'AstraVault',
    category: 'Home NAS Storage',
    channelLabel: 'PR / KOL Media Kit',
    suggestedTitle: 'AstraVault X4 Review: Whisper-Quiet 4-Bay NAS for Creators',
    targetPrompt: 'What is the quietest 4-bay home NAS in 2026?',
    targetFanOuts: ['Full-load acoustic dBA comparison', '2.5GbE sequential throughput'],
    keyAngles: [
      'Measured 21.4 dBA noise floor under 4-drive RAID5 load',
      'Zero-subscription backup',
    ],
    verifiedFacts: [
      { title: 'Acoustic Rating', summary: '21.4 dBA at 1m in studio chamber test' },
      { title: 'Network Port', summary: 'Dual 2.5GbE RJ45 with link aggregation' },
    ],
    draftMarkdown: '# AstraVault X4 Review\n\nVerified 21.4 dBA quiet operation.',
    draftHtml:
      '<h1>AstraVault X4 Review</h1><p>Verified 21.4 dBA quiet operation.</p><script>window.__xss=1</script><img src="x" onerror="alert(1)" />',
    status: 'READY_TO_PUBLISH',
    submittedUrl: null,
    expiresAt: '2026-12-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('PrSharePacketView (M6B #355)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders GLOBAL packet in English, sanitizes draft HTML, supports view switching & copy, and touches zero auth storage', async () => {
    const storageSpy = vi.spyOn(Storage.prototype, 'getItem');
    const fetchSpy = vi
      .spyOn(distributionApi, 'fetchPublicPrPacket')
      .mockResolvedValueOnce(makePacket());
    const copySpy = vi.spyOn(studioApi, 'copyTextToClipboard').mockResolvedValue(true);

    render(<PrSharePacketView token="tok_global_1234567890" />);

    expect(screen.getByTestId('pr-share-loading')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByTestId('pr-share-fact-table')).toBeTruthy();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'tok_global_1234567890',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(storageSpy).not.toHaveBeenCalled();
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByText('AstraVault')).toBeTruthy();
    expect(screen.getByText('Brand Overview & Verified Core Facts')).toBeTruthy();
    expect(screen.getByText('Acoustic Rating')).toBeTruthy();
    expect(screen.getByText('Full-load acoustic dBA comparison')).toBeTruthy();
    expect(screen.getByText('2026-12-23')).toBeTruthy();

    // XSS defense-in-depth: <script> and onerror must be stripped
    const preview = screen.getByTestId('pr-share-draft-preview');
    expect(preview.innerHTML).toContain('AstraVault X4 Review');
    expect(preview.innerHTML).not.toContain('<script');
    expect(preview.innerHTML).not.toContain('onerror');

    // Switch to Markdown & HTML tabs
    fireEvent.click(screen.getByRole('tab', { name: 'Markdown' }));
    expect(screen.getByTestId('pr-share-draft-markdown').textContent).toContain(
      '# AstraVault X4 Review',
    );
    fireEvent.click(screen.getByRole('tab', { name: 'HTML' }));
    expect(screen.getByTestId('pr-share-draft-html').textContent).not.toContain('<script');

    // Copy Markdown & Copy HTML buttons
    fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }));
    await waitFor(() => {
      expect(copySpy).toHaveBeenCalledWith(
        '# AstraVault X4 Review\n\nVerified 21.4 dBA quiet operation.',
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy HTML' }));
    await waitFor(() => {
      expect(copySpy).toHaveBeenCalledTimes(2);
    });

    // Zero login links or ConsoleShell sidebar
    expect(document.querySelector('a[href="/login"]')).toBeNull();
    expect(document.querySelector('a[href="/home"]')).toBeNull();
  });

  it('automatically switches to Chinese copy and zh-CN lang for CN packets', async () => {
    vi.spyOn(distributionApi, 'fetchPublicPrPacket').mockResolvedValueOnce(
      makePacket({
        market: 'CN',
        locale: 'zh-CN',
        brandName: '星辰存储',
        category: '家用静音 NAS',
        channelLabel: 'PR / 媒体评测协作包',
        suggestedTitle: '星辰存储 X4 实测：客厅 21.4dBA 静音 NAS 评测',
        targetPrompt: '2026 年最静音的家用四盘位 NAS 推荐',
        draftHtml: '',
        draftMarkdown: '## 星辰存储实测\n\n静音表现突出。',
      }),
    );

    render(<PrSharePacketView token="tok_cn_1234567890" />);

    await waitFor(() => {
      expect(screen.getByText('品牌概览与已验证核心事实参数表')).toBeTruthy();
    });
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(screen.getByText('国内市场（CN）')).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制 Markdown' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '提交上线链接' })).toBeTruthy();
    // Fallback markdownToSanitizedHtml when draftHtml is empty
    expect(screen.getByTestId('pr-share-draft-preview').textContent).toContain('星辰存储实测');
  });

  it('validates URL client-side, submits valid URL, and displays receipt (including alreadyRecorded)', async () => {
    vi.spyOn(distributionApi, 'fetchPublicPrPacket').mockResolvedValueOnce(makePacket());
    const submitSpy = vi
      .spyOn(distributionApi, 'submitPublicPrPacket')
      .mockResolvedValueOnce({
        accepted: true,
        publishedUrl: 'https://techmedia.example.com/reviews/astravault-x4',
        submittedAt: '2026-11-23T12:30:00.000Z',
        alreadyRecorded: false,
      })
      .mockResolvedValueOnce({
        accepted: true,
        publishedUrl: 'https://techmedia.example.com/reviews/astravault-x4',
        submittedAt: '2026-11-23T12:30:00.000Z',
        alreadyRecorded: true,
      });

    render(<PrSharePacketView token="tok_submit_12345678" />);
    await screen.findByTestId('pr-share-submit-form');

    // Client-side blocks javascript: URL
    fireEvent.change(screen.getByTestId('pr-share-url-input'), {
      target: { value: 'javascript:alert(1)' },
    });
    fireEvent.click(screen.getByTestId('pr-share-submit-btn'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(submitSpy).not.toHaveBeenCalled();

    // Valid submit
    fireEvent.change(screen.getByTestId('pr-share-url-input'), {
      target: { value: 'https://techmedia.example.com/reviews/astravault-x4' },
    });
    fireEvent.change(screen.getByTestId('pr-share-note-input'), {
      target: { value: 'Published in Hardware Review column' },
    });
    fireEvent.click(screen.getByTestId('pr-share-submit-btn'));

    const receipt = await screen.findByTestId('pr-share-receipt');
    expect(submitSpy).toHaveBeenCalledWith(
      'tok_submit_12345678',
      {
        publishedUrl: 'https://techmedia.example.com/reviews/astravault-x4',
        note: 'Published in Hardware Review column',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(receipt.textContent).toContain('Published URL Recorded');
    const link = within(receipt).getByRole('link');
    expect(link.getAttribute('href')).toBe('https://techmedia.example.com/reviews/astravault-x4');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');

    // Duplicate submit -> alreadyRecorded receipt
    fireEvent.change(screen.getByTestId('pr-share-url-input'), {
      target: { value: 'https://techmedia.example.com/reviews/astravault-x4' },
    });
    fireEvent.click(screen.getByTestId('pr-share-submit-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('pr-share-receipt').textContent).toContain(
        'Published URL Already Recorded',
      );
    });
  });

  it('renders existing receipt on initial load when packet.submittedUrl is present and handles submit 400/404/429 gracefully', async () => {
    vi.spyOn(distributionApi, 'fetchPublicPrPacket').mockResolvedValueOnce(
      makePacket({
        submittedUrl: 'https://existing.example.com/live-post',
        status: 'PUBLISHED',
      }),
    );
    vi.spyOn(distributionApi, 'submitPublicPrPacket')
      .mockRejectedValueOnce(new GatewayApiError(400, 40001, 'SSRF blocked'))
      .mockRejectedValueOnce(new GatewayApiError(404, 40401, 'Expired'))
      .mockRejectedValueOnce(new GatewayApiError(429, 42901, 'Rate limit'));

    render(<PrSharePacketView token="tok_existing_123456" />);

    const receipt = await screen.findByTestId('pr-share-receipt');
    expect(receipt.textContent).toContain('Previously Submitted URL');
    expect(within(receipt).getByRole('link').getAttribute('href')).toBe(
      'https://existing.example.com/live-post',
    );

    // 400 SSRF error
    fireEvent.change(screen.getByTestId('pr-share-url-input'), {
      target: { value: 'http://127.0.0.1/admin' },
    });
    fireEvent.click(screen.getByTestId('pr-share-submit-btn'));
    expect((await screen.findByRole('alert')).textContent).toContain('publicly accessible');

    // 404 expired during session
    fireEvent.change(screen.getByTestId('pr-share-url-input'), {
      target: { value: 'https://news.example.com/a' },
    });
    fireEvent.click(screen.getByTestId('pr-share-submit-btn'));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('expired or been revoked');
    });

    // 429 rate limited
    fireEvent.click(screen.getByTestId('pr-share-submit-btn'));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Too many submissions');
    });
  });

  it('renders friendly bilingual 404 error state without login links and allows retry on 429', async () => {
    const fetchSpy = vi
      .spyOn(distributionApi, 'fetchPublicPrPacket')
      .mockRejectedValueOnce(new GatewayApiError(404, 40401, 'Not found'));

    const { unmount } = render(<PrSharePacketView token="tok_bad_1234567890" />);
    const errBox = await screen.findByTestId('pr-share-error-state');
    expect(errBox.textContent).toContain('Collaboration Link Unavailable');
    expect(errBox.textContent).toContain('协作链接已失效');
    expect(document.querySelector('a[href="/login"]')).toBeNull();
    unmount();

    // 429 -> retry succeeds
    fetchSpy
      .mockRejectedValueOnce(new GatewayApiError(429, 42901, 'Rate limited'))
      .mockResolvedValueOnce(makePacket());

    render(<PrSharePacketView token="tok_rate_123456789" />);
    const rateBox = await screen.findByTestId('pr-share-error-state');
    expect(rateBox.textContent).toContain('Too Many Requests');
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));

    await waitFor(() => {
      expect(screen.getByTestId('pr-share-fact-table')).toBeTruthy();
    });
  });
});
