import type { MarketingLocale } from '@geomix/shared';

export type { MarketingLocale };

export const DEFAULT_MARKETING_LOCALE: MarketingLocale = 'en';
export const ZH_LOCALE_PREFIX = '/zh' as const;
export const DEFAULT_MARKETING_SITE_URL = 'http://localhost:3000' as const;

/** Canonical EN static marketing paths (dynamic /guides/[slug] handled separately). */
export const MARKETING_STATIC_PATHS = ['/', '/pricing', '/guides', '/demo'] as const;

/** Next.js Metadata['alternates'] & sitemap alternates.languages compatible shape. */
export type MarketingAlternates = {
  canonical: string;
  languages: {
    en: string;
    'zh-CN': string;
    'x-default': string;
  };
};

const MARKETING_STATIC_PATH_SET = new Set<string>(MARKETING_STATIC_PATHS);
const GUIDE_DETAIL_PATH_RE = /^\/guides\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

interface ParsedSafePath {
  pathname: string;
  suffix: string;
}

function parseSafePath(raw: string | null | undefined): ParsedSafePath | null {
  if (raw === null || raw === undefined) return null;
  if (hasControlChar(raw)) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const suffixIndex = trimmed.search(/[?#]/);
  const rawPathname = suffixIndex === -1 ? trimmed : trimmed.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : trimmed.slice(suffixIndex);

  if (!rawPathname.startsWith('/') || rawPathname.startsWith('//') || rawPathname.includes('\\')) {
    return null;
  }

  const collapsed = rawPathname.replace(/\/{2,}/g, '/');
  const segments = collapsed.split('/');
  for (const segment of segments) {
    if (!segment) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (
      segment === '.' ||
      segment === '..' ||
      decoded === '.' ||
      decoded === '..' ||
      /\s/.test(segment) ||
      /\s/.test(decoded) ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      hasControlChar(decoded)
    ) {
      return null;
    }
  }

  const pathname =
    collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;

  return { pathname, suffix };
}

function isZhPrefixedPathname(pathname: string): boolean {
  return pathname === ZH_LOCALE_PREFIX || pathname.startsWith(`${ZH_LOCALE_PREFIX}/`);
}

function stripAllZhPrefixes(pathname: string): string {
  let normalized = pathname;
  while (isZhPrefixedPathname(normalized)) {
    normalized = normalized.slice(ZH_LOCALE_PREFIX.length) || '/';
  }
  return normalized;
}

function isCanonicalEnMarketingPath(pathname: string): boolean {
  return MARKETING_STATIC_PATH_SET.has(pathname) || GUIDE_DETAIL_PATH_RE.test(pathname);
}

function normalizeSiteUrl(raw: string | undefined): string | null {
  if (!raw || hasControlChar(raw)) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    const cleanPath = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    return `${url.origin}${cleanPath}`;
  } catch {
    return null;
  }
}

export function getMarketingLocaleFromPath(pathname: string | null | undefined): MarketingLocale {
  const parsed = parseSafePath(pathname);
  if (!parsed) return DEFAULT_MARKETING_LOCALE;
  return isZhPrefixedPathname(parsed.pathname) ? 'zh-CN' : DEFAULT_MARKETING_LOCALE;
}

export function stripMarketingLocalePrefix(path: string): string {
  const parsed = parseSafePath(path);
  if (!parsed) return '/';
  const basePath = stripAllZhPrefixes(parsed.pathname);
  return `${basePath}${parsed.suffix}`;
}

export function isMarketingPath(path: string): boolean {
  const parsed = parseSafePath(path);
  if (!parsed) return false;
  const basePath = stripAllZhPrefixes(parsed.pathname);
  return isCanonicalEnMarketingPath(basePath);
}

export function toLocalizedMarketingPath(path: string, targetLocale: MarketingLocale): string {
  const fallbackRoot = targetLocale === 'zh-CN' ? ZH_LOCALE_PREFIX : '/';
  const parsed = parseSafePath(path);
  if (!parsed) return fallbackRoot;

  const basePath = stripAllZhPrefixes(parsed.pathname);
  if (!isCanonicalEnMarketingPath(basePath)) {
    return fallbackRoot;
  }

  if (targetLocale === 'en') {
    return `${basePath}${parsed.suffix}`;
  }

  const localizedBase = basePath === '/' ? ZH_LOCALE_PREFIX : `${ZH_LOCALE_PREFIX}${basePath}`;
  return `${localizedBase}${parsed.suffix}`;
}

export function switchMarketingPathLocale(path: string, targetLocale?: MarketingLocale): string {
  const nextLocale: MarketingLocale =
    targetLocale ?? (getMarketingLocaleFromPath(path) === 'zh-CN' ? 'en' : 'zh-CN');
  return toLocalizedMarketingPath(path, nextLocale);
}

export function getMarketingSiteUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const fromPublicUrl = normalizeSiteUrl(env.PUBLIC_APP_URL);
  if (fromPublicUrl) return fromPublicUrl;

  for (const entry of (env.WEB_ORIGIN ?? '').split(',')) {
    const normalized = normalizeSiteUrl(entry);
    if (normalized) return normalized;
  }

  return DEFAULT_MARKETING_SITE_URL;
}

export function buildMarketingCanonical(path: string, baseUrl?: string): string {
  const origin = normalizeSiteUrl(baseUrl) ?? getMarketingSiteUrl();
  const parsed = parseSafePath(path);
  if (!parsed) {
    return `${origin}/`;
  }

  const isZh = isZhPrefixedPathname(parsed.pathname);
  const basePath = stripAllZhPrefixes(parsed.pathname);
  const normalizedPath = isZh
    ? basePath === '/'
      ? ZH_LOCALE_PREFIX
      : `${ZH_LOCALE_PREFIX}${basePath}`
    : basePath;

  return `${origin}${normalizedPath}`;
}

export function buildMarketingAlternates(path: string, baseUrl?: string): MarketingAlternates {
  const origin = normalizeSiteUrl(baseUrl) ?? getMarketingSiteUrl();
  const locale = getMarketingLocaleFromPath(path);
  const parsed = parseSafePath(path);
  const cleanPathname = parsed?.pathname ?? '/';

  const enPath = toLocalizedMarketingPath(cleanPathname, 'en');
  const zhPath = toLocalizedMarketingPath(cleanPathname, 'zh-CN');
  const enUrl = buildMarketingCanonical(enPath, origin);
  const zhUrl = buildMarketingCanonical(zhPath, origin);

  return {
    canonical: locale === 'zh-CN' ? zhUrl : enUrl,
    languages: {
      en: enUrl,
      'zh-CN': zhUrl,
      'x-default': enUrl,
    },
  };
}
