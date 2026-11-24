// @vitest-environment jsdom

import {
  FREE_RATE_LIMITED_ACTIONS,
  PRICING_DEFAULTS,
  PUBLIC_PRICING_FALLBACK,
  type PublicPricingPayload,
} from '@geomix/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarketingPricingPage, {
  generateMetadata as generateEnPricingMetadata,
} from '../../app/(marketing)/pricing/page';
import MarketingZhPricingPage, {
  generateMetadata as generateZhPricingMetadata,
} from '../../app/(marketing)/zh/pricing/page';
import { PricingPageView, buildPricingFaqItems } from './pricing-page-view';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FIAT_PATTERN = /[$¥￥€£]|\b(USD|CNY)\b/i;

function parseJsonLdScripts(container: HTMLElement): Array<Record<string, unknown>> {
  const scripts = Array.from(container.querySelectorAll('script[type="application/ld+json"]'));
  return scripts.map((el) => JSON.parse(el.textContent ?? '{}') as Record<string, unknown>);
}

describe('PricingPageView & /pricing routes (EN & ZH)', () => {
  it('renders 3 plans, 4 paid actions, 7 free actions, bundled JSON-LD/llms.txt highlight, verbatim FAQ JSON-LD, and ZERO fiat currency on EN', () => {
    const { container } = render(<PricingPageView locale="en" pricing={PUBLIC_PRICING_FALLBACK} />);

    const plans = screen.getByTestId('pricing-plans');
    expect(plans.textContent).toContain('Trial Demo');
    expect(plans.textContent).toContain('Growth Brand Team');
    expect(plans.textContent).toContain('Agency & Enterprise');

    const table = screen.getByTestId('pricing-actions-table');
    for (const item of PRICING_DEFAULTS) {
      expect(table.textContent).toContain(item.action);
    }

    const freeGrid = screen.getByTestId('pricing-free-actions');
    for (const freeAction of FREE_RATE_LIMITED_ACTIONS) {
      expect(freeGrid.textContent).toContain(freeAction);
    }
    const bundled = screen.getByTestId('pricing-bundled-export');
    expect(bundled.textContent).toContain('JSON-LD');
    expect(bundled.textContent).toContain('/llms.txt');

    // ZERO fiat currency symbols or codes anywhere in visible DOM or JSON-LD
    expect(container.textContent ?? '').not.toMatch(FIAT_PATTERN);
    const scripts = Array.from(container.querySelectorAll('script[type="application/ld+json"]'));
    expect(scripts).toHaveLength(2);
    for (const script of scripts) {
      expect(script.textContent ?? '').not.toMatch(FIAT_PATTERN);
    }

    const schemas = parseJsonLdScripts(container);
    expect(schemas.map((s) => s['@type'])).toEqual(['SoftwareApplication', 'FAQPage']);

    const appOffer = (schemas[0] as { offers: Record<string, unknown> }).offers;
    expect('price' in appOffer).toBe(false);
    expect('priceCurrency' in appOffer).toBe(false);
    expect(String(appOffer.url)).toMatch(/\/demo$/);

    const expectedFaq = buildPricingFaqItems('en', PUBLIC_PRICING_FALLBACK);
    const faqEntities = (
      schemas[1] as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> }
    ).mainEntity;
    expect(faqEntities).toHaveLength(expectedFaq.length);
    for (let i = 0; i < expectedFaq.length; i += 1) {
      expect(faqEntities[i]?.name).toBe(expectedFaq[i]?.question);
      expect(faqEntities[i]?.acceptedAnswer.text).toBe(expectedFaq[i]?.answer);
    }
  });

  it('renders live geo_variant=0 cleanly and enforces zero fiat symbols on ZH', () => {
    const liveZeroVariant: PublicPricingPayload = {
      ...PUBLIC_PRICING_FALLBACK,
      items: PUBLIC_PRICING_FALLBACK.items.map((item) =>
        item.action === 'geo_variant' ? { ...item, unitPoints: 0 } : { ...item },
      ),
    };

    const { container } = render(<PricingPageView locale="zh-CN" pricing={liveZeroVariant} />);

    expect(screen.getByTestId('pricing-actions-table').textContent).toContain('0 点（限流免费）');
    expect(screen.getByTestId('calculator-total-points').textContent).toBe('432');
    expect(container.textContent ?? '').not.toMatch(FIAT_PATTERN);

    const scripts = Array.from(container.querySelectorAll('script[type="application/ld+json"]'));
    for (const script of scripts) {
      expect(script.textContent ?? '').not.toMatch(FIAT_PATTERN);
    }
  });

  it('exports dynamic generateMetadata with reciprocal hreflang and wraps /zh/pricing in lang="zh-CN"', async () => {
    const enMeta = generateEnPricingMetadata();
    const zhMeta = generateZhPricingMetadata();

    expect(enMeta.alternates?.canonical).toMatch(/\/pricing$/);
    expect(zhMeta.alternates?.canonical).toMatch(/\/zh\/pricing$/);
    const zhLangs = zhMeta.alternates?.languages as Record<string, string> | undefined;
    expect(zhLangs?.en).toMatch(/\/pricing$/);
    expect(zhLangs?.['zh-CN']).toMatch(/\/zh\/pricing$/);
    expect(zhLangs?.['x-default']).toBe(zhLangs?.en);

    const enJsx = await MarketingPricingPage();
    render(enJsx);
    expect(screen.getByTestId('calculator-total-points').textContent).toBe('464');
    cleanup();

    const zhJsx = await MarketingZhPricingPage();
    const { container } = render(zhJsx);
    expect(container.querySelector('[lang="zh-CN"]')).toBeTruthy();
    expect(container.textContent ?? '').not.toMatch(FIAT_PATTERN);
  });
});
