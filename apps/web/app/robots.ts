import type { MetadataRoute } from 'next';
import { buildMarketingCanonical, getMarketingSiteUrl } from '../lib/marketing-i18n';

export const dynamic = 'force-dynamic';

const ALLOWED_CRAWLERS = [
  '*',
  'Googlebot',
  'GPTBot',
  'OAI-SearchBot',
  'PerplexityBot',
  'ClaudeBot',
  'Bingbot',
  'Applebot-Extended',
];

const DISALLOWED_PRIVATE_PATHS = [
  '/admin',
  '/home',
  '/brands',
  '/visibility',
  '/studio',
  '/publish',
  '/account',
  '/share/',
  '/api/',
];

export default function robots(): MetadataRoute.Robots {
  const siteUrl = getMarketingSiteUrl();

  return {
    rules: [
      {
        userAgent: ALLOWED_CRAWLERS,
        allow: '/',
        disallow: DISALLOWED_PRIVATE_PATHS,
      },
    ],
    sitemap: buildMarketingCanonical('/sitemap.xml', siteUrl),
    host: siteUrl,
  };
}
