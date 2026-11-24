// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarketingDemoPage, {
  generateMetadata as generateEnDemoMetadata,
} from '../../app/(marketing)/demo/page';
import MarketingZhDemoPage, {
  generateMetadata as generateZhDemoMetadata,
} from '../../app/(marketing)/zh/demo/page';
import { sanitizeDemoSearchParams } from './demo-page-utils';
import { DemoRequestForm } from './demo-request-form';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function parseJsonLdScripts(container: HTMLElement): Array<Record<string, unknown>> {
  const scripts = Array.from(container.querySelectorAll('script[type="application/ld+json"]'));
  return scripts.map((el) => JSON.parse(el.textContent ?? '{}') as Record<string, unknown>);
}

describe('sanitizeDemoSearchParams', () => {
  it('accepts valid estimatedPts, targetMarket, and monthlyGoal and safely sanitizes hostile values', () => {
    expect(
      sanitizeDemoSearchParams({
        estimatedPts: '1200',
        targetMarket: 'both',
        monthlyGoal: '  Publish 12 articles/mo  ',
      }),
    ).toEqual({
      estimatedPts: 1200,
      targetMarket: 'BOTH',
      monthlyGoal: 'Publish 12 articles/mo',
    });

    // Rejects NaN, negative, decimal, scientific notation, out-of-range, invalid market
    expect(
      sanitizeDemoSearchParams({
        estimatedPts: 'NaN',
        targetMarket: 'INVALID',
        monthlyGoal: '\x00\x07<script>alert(1)</script>',
      }),
    ).toEqual({
      estimatedPts: undefined,
      targetMarket: 'GLOBAL',
      monthlyGoal: '<script>alert(1)</script>',
    });

    expect(sanitizeDemoSearchParams({ estimatedPts: '-5' }).estimatedPts).toBeUndefined();
    expect(sanitizeDemoSearchParams({ estimatedPts: '12.5' }).estimatedPts).toBeUndefined();
    expect(sanitizeDemoSearchParams({ estimatedPts: '1e4' }).estimatedPts).toBeUndefined();
    expect(sanitizeDemoSearchParams({ estimatedPts: '10000001' }).estimatedPts).toBeUndefined();

    // Clamps monthlyGoal to 160 characters
    const longGoal = 'A'.repeat(240);
    expect(sanitizeDemoSearchParams({ monthlyGoal: longGoal }).monthlyGoal?.length).toBe(160);
  });
});

describe('DemoRequestForm & /demo SSR Pages (EN & ZH)', () => {
  it('binds all 7 visible fields via label, exposes hidden honeypot without display:none, and validates locally in EN & ZH', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <DemoRequestForm locale="en" initialPrefill={{ targetMarket: 'GLOBAL' }} />,
    );

    expect(screen.getByLabelText(/Your Name/i)).toBeTruthy();
    expect(screen.getByLabelText(/Work Email/i)).toBeTruthy();
    expect(screen.getByLabelText(/Company or Brand Name/i)).toBeTruthy();
    expect(screen.getByLabelText(/Brand Website URL/i)).toBeTruthy();
    expect(screen.getByLabelText(/Target Market/i)).toBeTruthy();
    expect(screen.getByLabelText(/Monthly GEO Goal/i)).toBeTruthy();
    expect(screen.getByLabelText(/Additional Notes/i)).toBeTruthy();

    const hp = container.querySelector('input[name="honeypot"]') as HTMLInputElement | null;
    expect(hp).toBeTruthy();
    expect(hp?.tabIndex).toBe(-1);
    expect(hp?.getAttribute('autocomplete')).toBe('off');
    expect(hp?.getAttribute('aria-hidden')).toBe('true');
    expect(hp?.style.display).not.toBe('none');

    // Empty submit triggers localized EN errors and blocks fetch
    fireEvent.click(screen.getByRole('button', { name: /Submit 1,000-Point Trial Demo Request/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Please enter your name/i)).toBeTruthy();
    expect(screen.getByText(/Please enter a valid work email/i)).toBeTruthy();
    expect(screen.getByText(/Please enter your company or brand name/i)).toBeTruthy();

    // Invalid private IP URL blocked client-side
    fireEvent.change(screen.getByLabelText(/Your Name/i), { target: { value: 'Alex' } });
    fireEvent.change(screen.getByLabelText(/Work Email/i), {
      target: { value: 'alex@nordicaudio.example' },
    });
    fireEvent.change(screen.getByLabelText(/Company or Brand Name/i), {
      target: { value: 'NordicAudio' },
    });
    fireEvent.change(screen.getByLabelText(/Brand Website URL/i), {
      target: { value: 'http://127.0.0.1/admin' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit 1,000-Point Trial Demo Request/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/valid public http:\/\/ or https:\/\//i)).toBeTruthy();

    // ZH localized validation (zero raw English Zod error strings)
    cleanup();
    render(<DemoRequestForm locale="zh-CN" initialPrefill={{ targetMarket: 'CN' }} />);
    fireEvent.click(screen.getByRole('button', { name: /提交 1,000 点试用 Demo 申请/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('请填写您的姓名。')).toBeTruthy();
    expect(screen.getByText('请输入有效的工作邮箱地址。')).toBeTruthy();
    expect(screen.getByText('请填写您的公司或品牌名称。')).toBeTruthy();
  });

  it('prevents duplicate submit, sends estimatedPts as JS number, renders demo-submit-success, and NEVER exposes raw CUID id', async () => {
    let resolveFetch!: (res: Response) => void;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <DemoRequestForm
        locale="en"
        initialPrefill={{
          estimatedPts: 464,
          targetMarket: 'BOTH',
          monthlyGoal: '8 articles/mo',
        }}
      />,
    );

    expect(screen.getByTestId('demo-estimated-pts-banner').textContent).toContain('464');

    fireEvent.change(screen.getByLabelText(/Your Name/i), { target: { value: 'Alex Chen' } });
    fireEvent.change(screen.getByLabelText(/Work Email/i), {
      target: { value: 'alex@nordicaudio.example' },
    });
    fireEvent.change(screen.getByLabelText(/Company or Brand Name/i), {
      target: { value: 'NordicAudio' },
    });
    fireEvent.change(screen.getByLabelText(/Brand Website URL/i), {
      target: { value: 'https://nordicaudio.example' },
    });

    const submitBtn = screen.getByRole('button', {
      name: /Submit 1,000-Point Trial Demo Request/i,
    });
    fireEvent.click(submitBtn);
    fireEvent.click(submitBtn);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.estimatedPts).toBe(464);
    expect(typeof body.estimatedPts).toBe('number');
    expect(body.targetMarket).toBe('BOTH');
    expect(body.sourcePage).toBe('/demo');

    const rawCuid = 'cm3lead999secretcuid1234';
    resolveFetch(
      new Response(JSON.stringify({ code: 0, msg: 'ok', data: { accepted: true, id: rawCuid } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const successPanel = await screen.findByTestId('demo-submit-success');
    expect(successPanel.textContent).toContain('NordicAudio');
    expect(successPanel.textContent).not.toContain(rawCuid);
  });

  it('preserves user inputs and displays clear localized messages on 429 (with & without Retry-After), 400, and network failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 42901, msg: '尝试过于频繁，请稍后再试', data: null }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '45' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 42901, msg: '尝试过于频繁，请稍后再试', data: null }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 40001, msg: 'Invalid email domain', data: null }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    render(<DemoRequestForm locale="en" initialPrefill={{ targetMarket: 'GLOBAL' }} />);

    const nameInput = screen.getByLabelText(/Your Name/i) as HTMLInputElement;
    const emailInput = screen.getByLabelText(/Work Email/i) as HTMLInputElement;
    const brandInput = screen.getByLabelText(/Company or Brand Name/i) as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: 'Alex Chen' } });
    fireEvent.change(emailInput, { target: { value: 'alex@nordicaudio.example' } });
    fireEvent.change(brandInput, { target: { value: 'NordicAudio' } });

    const submitBtn = screen.getByRole('button', {
      name: /Submit 1,000-Point Trial Demo Request/i,
    });

    // 1. 429 with Retry-After
    fireEvent.click(submitBtn);
    await waitFor(() => {
      expect(screen.getByTestId('demo-submit-error').textContent).toContain('45 seconds');
    });
    expect(nameInput.value).toBe('Alex Chen');
    expect(brandInput.value).toBe('NordicAudio');

    // 2. 429 without Retry-After (CORS hidden) — graceful English fallback, no Chinese leak
    fireEvent.click(submitBtn);
    await waitFor(() => {
      const errText = screen.getByTestId('demo-submit-error').textContent ?? '';
      expect(errText).toContain('wait a few minutes');
      expect(errText).not.toMatch(/[\u3400-\u9fff]/);
    });

    // 3. 400 validation error
    fireEvent.click(submitBtn);
    await waitFor(() => {
      expect(screen.getByTestId('demo-submit-error').textContent).toContain('Invalid email domain');
    });

    // 4. Network error
    fireEvent.click(submitBtn);
    await waitFor(() => {
      expect(screen.getByTestId('demo-submit-error').textContent).toContain('Network error');
    });
    expect(emailInput.value).toBe('alex@nordicaudio.example');
  });

  it('renders /demo and /zh/demo SSR pages with ContactPage JSON-LD, XSS-safe query prefill, lang="zh-CN", and reciprocal metadata', async () => {
    const enMeta = generateEnDemoMetadata();
    const zhMeta = generateZhDemoMetadata();
    expect(enMeta.alternates?.canonical).toMatch(/\/demo$/);
    expect(zhMeta.alternates?.canonical).toMatch(/\/zh\/demo$/);

    const enJsx = await MarketingDemoPage({
      searchParams: Promise.resolve({
        estimatedPts: '1200',
        monthlyGoal: '<script>alert(1)</script>',
        targetMarket: 'BOTH',
      }),
    });
    const { container: enContainer } = render(enJsx);
    expect(enContainer.querySelector('script:not([type="application/ld+json"])')).toBeNull();
    expect((screen.getByLabelText(/Monthly GEO Goal/i) as HTMLInputElement).value).toBe(
      '<script>alert(1)</script>',
    );
    const enSchemas = parseJsonLdScripts(enContainer);
    expect(enSchemas).toHaveLength(1);
    expect(enSchemas[0]?.['@type']).toBe('ContactPage');
    expect(enSchemas[0]?.inLanguage).toBe('en');

    cleanup();

    const zhJsx = await MarketingZhDemoPage({
      searchParams: Promise.resolve({ estimatedPts: '464' }),
    });
    const { container: zhContainer } = render(zhJsx);
    expect(zhContainer.querySelector('[lang="zh-CN"]')).toBeTruthy();
    const zhSchemas = parseJsonLdScripts(zhContainer);
    expect(zhSchemas[0]?.['@type']).toBe('ContactPage');
    expect(zhSchemas[0]?.inLanguage).toBe('zh-CN');
  });
});
