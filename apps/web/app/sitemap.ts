import { MARKETING_GUIDES } from '@geomix/shared';
import type { MetadataRoute } from 'next';
import {
  MARKETING_STATIC_PATHS,
  buildMarketingAlternates,
  getMarketingSiteUrl,
} from '../lib/marketing-i18n';

const STATIC_LAST_MODIFIED = new Date('2026-11-24T00:00:00.000Z');

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getMarketingSiteUrl();
  const entries: MetadataRoute.Sitemap = [];

  for (const basePath of MARKETING_STATIC_PATHS) {
    const alternates = buildMarketingAlternates(basePath, siteUrl);
    const priority = basePath === '/' ? 1.0 : basePath === '/pricing' ? 0.9 : 0.8;
    const changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'] =
      basePath === '/' ? 'weekly' : 'monthly';

    entries.push(
      {
        url: alternates.languages.en,
        lastModified: STATIC_LAST_MODIFIED,
        changeFrequency,
        priority,
        alternates: {
          languages: alternates.languages,
        },
      },
      {
        url: alternates.languages['zh-CN'],
        lastModified: STATIC_LAST_MODIFIED,
        changeFrequency,
        priority: Math.max(0.7, Number((priority - 0.05).toFixed(2))),
        alternates: {
          languages: alternates.languages,
        },
      },
    );
  }

  for (const guide of MARKETING_GUIDES) {
    const basePath = `/guides/${guide.slug}`;
    const alternates = buildMarketingAlternates(basePath, siteUrl);
    const lastModified = new Date(`${guide.updatedAt}T00:00:00.000Z`);

    entries.push(
      {
        url: alternates.languages.en,
        lastModified,
        changeFrequency: 'monthly',
        priority: 0.75,
        alternates: {
          languages: alternates.languages,
        },
      },
      {
        url: alternates.languages['zh-CN'],
        lastModified,
        changeFrequency: 'monthly',
        priority: 0.7,
        alternates: {
          languages: alternates.languages,
        },
      },
    );
  }

  return entries;
}
