// @vitest-environment jsdom

import { MARKETING_GUIDES, MARKETING_GUIDE_SLUGS } from '@geomix/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

import MarketingGuidesPage, {
  generateMetadata as generateEnGuidesMetadata,
} from '../../app/(marketing)/guides/page';
import MarketingGuideDetailPage, {
  generateMetadata as generateEnGuideDetailMetadata,
  generateStaticParams as generateEnGuideStaticParams,
} from '../../app/(marketing)/guides/[slug]/page';
import MarketingZhGuidesPage, {
  generateMetadata as generateZhGuidesMetadata,
} from '../../app/(marketing)/zh/guides/page';
import MarketingZhGuideDetailPage, {
  generateMetadata as generateZhGuideDetailMetadata,
  generateStaticParams as generateZhGuideStaticParams,
} from '../../app/(marketing)/zh/guides/[slug]/page';

afterEach(() => {
  cleanup();
  notFoundMock.mockClear();
});

function parseJsonLdScripts(container: HTMLElement): Array<Record<string, unknown>> {
  const scripts = Array.from(container.querySelectorAll('script[type="application/ld+json"]'));
  return scripts.map((el) => JSON.parse(el.textContent ?? '{}') as Record<string, unknown>);
}

describe('Guides Index & Detail Pages (EN & ZH)', () => {
  it('renders all 4 EN guides with /guides/<slug> links, CollectionPage JSON-LD, and reciprocal metadata', () => {
    const meta = generateEnGuidesMetadata();
    expect(meta.alternates?.canonical).toMatch(/\/guides$/);
    const langs = meta.alternates?.languages as Record<string, string> | undefined;
    expect(langs?.en).toMatch(/\/guides$/);
    expect(langs?.['zh-CN']).toMatch(/\/zh\/guides$/);
    expect(langs?.['x-default']).toBe(langs?.en);

    const { container } = render(<MarketingGuidesPage />);
    for (const guide of MARKETING_GUIDES) {
      expect(screen.getByRole('link', { name: guide.en.title }).getAttribute('href')).toBe(
        `/guides/${guide.slug}`,
      );
    }

    const schemas = parseJsonLdScripts(container);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.['@type']).toBe('CollectionPage');
    const itemList = schemas[0]?.mainEntity as {
      numberOfItems: number;
      itemListElement: Array<{ url: string }>;
    };
    expect(itemList.numberOfItems).toBe(4);
    expect(itemList.itemListElement).toHaveLength(4);
  });

  it('renders ZH /zh/guides wrapped in lang="zh-CN" with /zh/guides/<slug> links', () => {
    const meta = generateZhGuidesMetadata();
    expect(meta.alternates?.canonical).toMatch(/\/zh\/guides$/);

    const { container } = render(<MarketingZhGuidesPage />);
    expect(container.querySelector('[lang="zh-CN"]')).toBeTruthy();

    for (const guide of MARKETING_GUIDES) {
      expect(screen.getByRole('link', { name: guide.zh.title }).getAttribute('href')).toBe(
        `/zh/guides/${guide.slug}`,
      );
    }
  });

  it('exports generateStaticParams for all 4 slugs and renders TechArticle JSON-LD + code blocks on detail pages', async () => {
    expect(generateEnGuideStaticParams()).toEqual(MARKETING_GUIDE_SLUGS.map((slug) => ({ slug })));
    expect(generateZhGuideStaticParams()).toEqual(MARKETING_GUIDE_SLUGS.map((slug) => ({ slug })));

    const slug = 'llms-txt-and-jsonld-playbook';
    const enMeta = await generateEnGuideDetailMetadata({ params: Promise.resolve({ slug }) });
    expect(enMeta.alternates?.canonical).toMatch(new RegExp(`/guides/${slug}$`));
    const enLangs = enMeta.alternates?.languages as Record<string, string> | undefined;
    expect(enLangs?.['zh-CN']).toMatch(new RegExp(`/zh/guides/${slug}$`));

    const enJsx = await MarketingGuideDetailPage({ params: Promise.resolve({ slug }) });
    const { container: enContainer } = render(enJsx);
    expect(screen.getByRole('link', { name: /Back to GEO Guides/i }).getAttribute('href')).toBe(
      '/guides',
    );
    const codeBlocks = enContainer.querySelectorAll('pre.gm-mkt-code-pre.gm-mono');
    expect(codeBlocks.length).toBe(3);

    const enSchemas = parseJsonLdScripts(enContainer);
    expect(enSchemas).toHaveLength(1);
    expect(enSchemas[0]?.['@type']).toBe('TechArticle');
    expect(enSchemas[0]?.inLanguage).toBe('en');

    cleanup();

    const zhMeta = await generateZhGuideDetailMetadata({ params: Promise.resolve({ slug }) });
    expect(zhMeta.alternates?.canonical).toMatch(new RegExp(`/zh/guides/${slug}$`));

    const zhJsx = await MarketingZhGuideDetailPage({ params: Promise.resolve({ slug }) });
    const { container: zhContainer } = render(zhJsx);
    expect(zhContainer.querySelector('[lang="zh-CN"]')).toBeTruthy();
    expect(screen.getByRole('link', { name: /返回 GEO 实操指南/i }).getAttribute('href')).toBe(
      '/zh/guides',
    );
    const zhSchemas = parseJsonLdScripts(zhContainer);
    expect(zhSchemas[0]?.['@type']).toBe('TechArticle');
    expect(zhSchemas[0]?.inLanguage).toBe('zh-CN');
  });

  it('returns noindex metadata without broken canonical and invokes notFound() on unknown or non-exact-case slugs', async () => {
    for (const badSlug of ['unknown-guide', 'GEO-CITATION-VS-MENTION']) {
      const enMeta = await generateEnGuideDetailMetadata({
        params: Promise.resolve({ slug: badSlug }),
      });
      expect(enMeta.alternates).toBeUndefined();
      expect(enMeta.robots).toEqual({ index: false, follow: false });

      const zhMeta = await generateZhGuideDetailMetadata({
        params: Promise.resolve({ slug: badSlug }),
      });
      expect(zhMeta.alternates).toBeUndefined();
      expect(zhMeta.robots).toEqual({ index: false, follow: false });

      await expect(
        MarketingGuideDetailPage({ params: Promise.resolve({ slug: badSlug }) }),
      ).rejects.toThrow('NEXT_NOT_FOUND');
      await expect(
        MarketingZhGuideDetailPage({ params: Promise.resolve({ slug: badSlug }) }),
      ).rejects.toThrow('NEXT_NOT_FOUND');
    }

    expect(notFoundMock).toHaveBeenCalledTimes(4);
  });
});
