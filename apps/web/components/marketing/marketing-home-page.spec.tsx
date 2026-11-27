// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import MarketingZhHomePage, {
  generateMetadata as generateZhMetadata,
} from '../../app/(marketing)/zh/page';
import { HOME_FAQ_ITEMS } from './marketing-home-data';
import { MarketingHomePage } from './marketing-home-page';

afterEach(() => {
  cleanup();
});

function parseJsonLdScripts(container: HTMLElement): Array<Record<string, unknown>> {
  const scripts = Array.from(container.querySelectorAll('script[type="application/ld+json"]'));
  return scripts.map((el) => JSON.parse(el.textContent ?? '{}') as Record<string, unknown>);
}

const FIAT_SYMBOL_OR_CODE_RE = /[$¥￥€£]|\b(?:USD|CNY|RMB|EUR|GBP)\b/i;

describe('MarketingHomePage (EN & ZH)', () => {
  it('renders EN homepage with hero, workflow, explicit v2.2 roadmap boundary, 4 security commitments, and verbatim-synced JSON-LD', () => {
    const { container } = render(<MarketingHomePage locale="en" />);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Make Your Brand the Source AI Cites — Not Just Mentions.',
      }),
    ).toBeTruthy();

    // Explicit GA v2.2 boundary
    const roadmap = screen.getByTestId('v22-roadmap-banner');
    expect(roadmap.textContent).toContain('GA v2.2');
    expect(roadmap.textContent).toContain('Near-Miss Citation Mining');
    expect(roadmap.textContent).toContain('Wilson 95% Confidence Intervals');

    // 4 Security & Engineering Trust Commitments
    expect(
      screen.getByRole('heading', { level: 3, name: /AES-256-GCM Credentials at Rest/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 3, name: /100% SSRF Outbound Protection/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: /Strict Tenant Isolation & Auditable Ledger/i,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 3, name: /Zero Automated Community Astroturfing/i }),
    ).toBeTruthy();

    // JSON-LD: Organization, SoftwareApplication (free Demo offer only), FAQPage verbatim sync
    const schemas = parseJsonLdScripts(container);
    expect(schemas).toHaveLength(3);
    const types = schemas.map((s) => s['@type']);
    expect(types).toEqual(['Organization', 'SoftwareApplication', 'FAQPage']);

    const appSchema = schemas[1] as { offers: Record<string, unknown> };
    expect('price' in appSchema.offers).toBe(false);
    expect('priceCurrency' in appSchema.offers).toBe(false);
    expect(appSchema.offers.availability).toBe('https://schema.org/InStock');
    expect(typeof appSchema.offers.description).toBe('string');
    expect(String(appSchema.offers.url)).toMatch(/\/demo$/);
    expect(FIAT_SYMBOL_OR_CODE_RE.test(JSON.stringify(schemas))).toBe(false);

    const faqSchema = schemas[2] as {
      mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
    };
    expect(faqSchema.mainEntity).toHaveLength(HOME_FAQ_ITEMS.en.length);
    for (let i = 0; i < HOME_FAQ_ITEMS.en.length; i += 1) {
      const entity = faqSchema.mainEntity[i];
      const expected = HOME_FAQ_ITEMS.en[i];
      expect(entity?.name).toBe(expected?.question);
      expect(entity?.acceptedAnswer.text).toBe(expected?.answer);
    }
  });

  it('renders ZH mirror page wrapped in lang="zh-CN" with reciprocal hreflang metadata and verbatim ZH FAQPage JSON-LD', () => {
    const { container } = render(<MarketingZhHomePage />);

    const zhWrapper = container.querySelector('[lang="zh-CN"]');
    expect(zhWrapper).toBeTruthy();

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: '让品牌成为 AI 回答的「首选信源」，而不只是被顺带提及',
      }),
    ).toBeTruthy();

    expect(screen.getByTestId('v22-roadmap-banner').textContent).toContain('已上线 v2.2');

    // Reciprocal hreflang metadata
    const zhMetadata = generateZhMetadata();
    expect(zhMetadata.alternates?.canonical).toMatch(/\/zh$/);
    const languages = zhMetadata.alternates?.languages as Record<string, string> | undefined;
    expect(languages?.en).toMatch(/\/$/);
    expect(languages?.['zh-CN']).toMatch(/\/zh$/);
    expect(languages?.['x-default']).toBe(languages?.en);

    // Verbatim ZH FAQPage JSON-LD and zero-fiat SoftwareApplication Offer
    const schemas = parseJsonLdScripts(container);
    expect(schemas).toHaveLength(3);
    const zhAppSchema = schemas[1] as { offers: Record<string, unknown> };
    expect('price' in zhAppSchema.offers).toBe(false);
    expect('priceCurrency' in zhAppSchema.offers).toBe(false);
    expect(zhAppSchema.offers.availability).toBe('https://schema.org/InStock');
    expect(typeof zhAppSchema.offers.description).toBe('string');
    expect(String(zhAppSchema.offers.url)).toMatch(/\/zh\/demo$/);
    expect(FIAT_SYMBOL_OR_CODE_RE.test(JSON.stringify(schemas))).toBe(false);

    const faqSchema = schemas[2] as {
      inLanguage: string;
      mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
    };
    expect(faqSchema.inLanguage).toBe('zh-CN');
    expect(faqSchema.mainEntity).toHaveLength(HOME_FAQ_ITEMS['zh-CN'].length);
    for (let i = 0; i < HOME_FAQ_ITEMS['zh-CN'].length; i += 1) {
      const entity = faqSchema.mainEntity[i];
      const expected = HOME_FAQ_ITEMS['zh-CN'][i];
      expect(entity?.name).toBe(expected?.question);
      expect(entity?.acceptedAnswer.text).toBe(expected?.answer);
    }
  });
});
