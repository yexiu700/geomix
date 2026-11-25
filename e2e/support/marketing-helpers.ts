import { expect, type Locator, type Page } from '@playwright/test';
import { requestV1, unwrapOk } from '../v2/support/api-client';
import { assertValidJsonLd } from '../v2/support/assertions';

export type MarketingLocale = 'en' | 'zh-CN';
export type MarketingLeadMarket = 'GLOBAL' | 'CN' | 'BOTH';
export type MarketingLeadStatus = 'NEW' | 'CONTACTED' | 'TRIAL_PROVISIONED' | 'ARCHIVED';

export interface MarketingGuideMeta {
  slug: string;
  enTitle: string;
  zhTitle: string;
}

export interface PublicRouteSpec {
  path: string;
  enPath: string;
  zhPath: string;
  locale: MarketingLocale;
  requiredJsonLdTypes: readonly string[];
  expectedHeadingFragment?: string;
}

export interface PublicPricingItemDto {
  action: string;
  unitPoints: number;
  label?: string;
  labelEn?: string;
  unitZh?: string;
  unitEn?: string;
}

export interface PublicFreeActionDto {
  action: string;
  labelEn?: string;
  labelZh?: string;
}

export interface PublicPricingPayload {
  items: PublicPricingItemDto[];
  freeActions: PublicFreeActionDto[];
  demoTrial: {
    points: number;
    validDays: number;
  };
}

export interface MarketingLeadDto {
  id: string;
  locale: string;
  name: string;
  email: string;
  companyBrand: string;
  websiteUrl: string | null;
  targetMarket: MarketingLeadMarket;
  monthlyGoal: string | null;
  estimatedPts: number | null;
  notes: string | null;
  sourcePage: string | null;
  status: MarketingLeadStatus;
  adminNote: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface AdminLeadListPayload {
  items: MarketingLeadDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DemoFormInput {
  name: string;
  email: string;
  companyBrand: string;
  websiteUrl?: string;
  targetMarket?: MarketingLeadMarket;
  monthlyGoal?: string;
  notes?: string;
}

export const MARKETING_VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

export const MARKETING_GUIDE_CATALOG: readonly MarketingGuideMeta[] = [
  {
    slug: 'geo-citation-vs-mention',
    enTitle: 'From Brand Mention to Source Citation: Why GEO Replaces Guesswork',
    zhTitle: '从品牌提及到信源引用：GEO 的衡量基准',
  },
  {
    slug: 'llms-txt-and-jsonld-playbook',
    enTitle: 'Engineering AI Crawlability: robots.txt, JSON-LD, and llms.txt',
    zhTitle: 'AI 可抓取工程指南：robots.txt、JSON-LD 与 llms.txt',
  },
  {
    slug: 'zero-ban-community-geo',
    enTitle: 'Zero-Ban Community GEO: Reddit, Quora, and Login-Free PR Media Kits',
    zhTitle: '零封号社区 GEO 与免登录 PR/KOL 协作实践',
  },
  {
    slug: 't7-t14-t30-attribution',
    enTitle: 'Measuring Real GEO Impact with T+1 Crawl Probes & T+7/14/30 Retests',
    zhTitle: 'T+1 抓取体检与 T+7/14/30 归因复测方法论',
  },
] as const;

export const PUBLIC_ROUTE_MATRIX: readonly PublicRouteSpec[] = [
  {
    path: '/',
    enPath: '/',
    zhPath: '/zh',
    locale: 'en',
    requiredJsonLdTypes: ['Organization', 'SoftwareApplication', 'FAQPage'],
  },
  {
    path: '/zh',
    enPath: '/',
    zhPath: '/zh',
    locale: 'zh-CN',
    requiredJsonLdTypes: ['Organization', 'SoftwareApplication', 'FAQPage'],
  },
  {
    path: '/pricing',
    enPath: '/pricing',
    zhPath: '/zh/pricing',
    locale: 'en',
    requiredJsonLdTypes: ['SoftwareApplication', 'FAQPage'],
  },
  {
    path: '/zh/pricing',
    enPath: '/pricing',
    zhPath: '/zh/pricing',
    locale: 'zh-CN',
    requiredJsonLdTypes: ['SoftwareApplication', 'FAQPage'],
  },
  {
    path: '/guides',
    enPath: '/guides',
    zhPath: '/zh/guides',
    locale: 'en',
    requiredJsonLdTypes: ['CollectionPage'],
  },
  {
    path: '/zh/guides',
    enPath: '/guides',
    zhPath: '/zh/guides',
    locale: 'zh-CN',
    requiredJsonLdTypes: ['CollectionPage'],
  },
  ...MARKETING_GUIDE_CATALOG.flatMap<PublicRouteSpec>((guide) => [
    {
      path: `/guides/${guide.slug}`,
      enPath: `/guides/${guide.slug}`,
      zhPath: `/zh/guides/${guide.slug}`,
      locale: 'en',
      requiredJsonLdTypes: ['TechArticle'],
      expectedHeadingFragment: guide.enTitle,
    },
    {
      path: `/zh/guides/${guide.slug}`,
      enPath: `/guides/${guide.slug}`,
      zhPath: `/zh/guides/${guide.slug}`,
      locale: 'zh-CN',
      requiredJsonLdTypes: ['TechArticle'],
      expectedHeadingFragment: guide.zhTitle,
    },
  ]),
  {
    path: '/demo',
    enPath: '/demo',
    zhPath: '/zh/demo',
    locale: 'en',
    requiredJsonLdTypes: ['ContactPage'],
  },
  {
    path: '/zh/demo',
    enPath: '/demo',
    zhPath: '/zh/demo',
    locale: 'zh-CN',
    requiredJsonLdTypes: ['ContactPage'],
  },
];

export const PROTECTED_CONSOLE_ROUTES = [
  '/home',
  '/brands',
  '/visibility',
  '/studio',
  '/account',
] as const;

export const PRIVATE_ROBOTS_DISALLOW_PATHS = [
  '/admin',
  '/home',
  '/brands',
  '/visibility',
  '/studio',
  '/account',
  '/share/',
  '/api/',
] as const;

export const PRIVATE_SITEMAP_FORBIDDEN_PATHS = [
  '/admin',
  '/home',
  '/brands',
  '/visibility',
  '/studio',
  '/account',
  '/login',
  '/share/',
  '/api/',
] as const;

export const EXPECTED_PRICING_DEFAULTS: Readonly<Record<string, number>> = {
  geo_write: 10,
  visibility_check: 2,
  inline_image_gen: 5,
  geo_variant: 2,
};

export const EXPECTED_FREE_ACTION_KEYS = [
  'geo_brief',
  'brand_fact_extract',
  'geo_evaluate',
  'rewrite_section',
  'distribution_preflight',
  'crawl_probe',
  'pr_packet_share',
  'near_miss_boost',
  'roi_report_export',
  'roi_report_share',
  'extension_token_issue',
  'extension_sync',
] as const;

export const LEAD_STATUS_LABELS: Readonly<Record<MarketingLeadStatus, string>> = {
  NEW: '待跟进',
  CONTACTED: '已联系',
  TRIAL_PROVISIONED: '已开通试用',
  ARCHIVED: '已归档',
};

export function getMarketingOrigin(): string {
  return (
    process.env.PUBLIC_APP_URL?.trim() ||
    process.env.E2E_BASE_URL?.trim() ||
    'http://127.0.0.1:3000'
  ).replace(/\/+$/, '');
}

export function getMarketingWebBase(): string {
  return (process.env.E2E_BASE_URL?.trim() || 'http://127.0.0.1:3000').replace(/\/+$/, '');
}

export function normalizeSeoUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.pathname === '/') {
    return `${parsed.origin}/${parsed.search}`;
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
}

export function expectedCanonicalUrl(origin: string, routePath: string): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  if (routePath === '/' || routePath === '') {
    return normalizeSeoUrl(`${cleanOrigin}/`);
  }
  const normalized = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return normalizeSeoUrl(`${cleanOrigin}${normalized}`);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const FORBIDDEN_LEAD_DTO_KEYS = ['sourceIpHash', 'ip', 'sourceIp', 'clientIp'] as const;

export function assertNoForbiddenLeadDtoKeys(
  dto: Record<string, unknown>,
  contextLabel: string,
): void {
  for (const forbiddenKey of FORBIDDEN_LEAD_DTO_KEYS) {
    expect(
      Object.prototype.hasOwnProperty.call(dto, forbiddenKey),
      `${contextLabel}: Admin lead DTO must never expose "${forbiddenKey}"`,
    ).toBe(false);
  }
}

// ---------- SEO, Head, JSON-LD, Robots & Sitemap Helpers ----------

export interface ExtractedHeadSeo {
  title: string;
  htmlLang: string;
  hasZhLangScope: boolean;
  canonical: string | null;
  alternates: Record<string, string>;
  jsonLdRawScripts: string[];
}

export async function extractHeadSeo(page: Page): Promise<ExtractedHeadSeo> {
  return page.evaluate(() => {
    const canonicalEl = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const alternateEls = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="alternate"][hreflang]'),
    );
    const alternates: Record<string, string> = {};
    for (const el of alternateEls) {
      const lang = el.getAttribute('hreflang')?.trim();
      const href = el.getAttribute('href')?.trim();
      if (lang && href) {
        alternates[lang] = href;
      }
    }
    const jsonLdRawScripts = Array.from(
      document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
    ).map((el) => (el.textContent ?? '').trim());

    const htmlLang = (document.documentElement.getAttribute('lang') ?? '').trim();
    const hasZhLangScope =
      htmlLang.toLowerCase() === 'zh-cn' || document.querySelector('[lang="zh-CN"]') !== null;

    return {
      title: (document.title ?? '').trim(),
      htmlLang,
      hasZhLangScope,
      canonical: canonicalEl?.getAttribute('href')?.trim() ?? null,
      alternates,
      jsonLdRawScripts,
    };
  });
}

function collectJsonLdTypes(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectJsonLdTypes(entry, out);
    }
    return;
  }
  const record = node as Record<string, unknown>;
  const rawType = record['@type'];
  if (typeof rawType === 'string' && rawType.trim().length > 0) {
    out.add(rawType.trim());
  } else if (Array.isArray(rawType)) {
    for (const entry of rawType) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        out.add(entry.trim());
      }
    }
  }
  if (Array.isArray(record['@graph'])) {
    collectJsonLdTypes(record['@graph'], out);
  }
}

function findJsonLdNodeByType(node: unknown, targetType: string): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') {
    return null;
  }
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findJsonLdNodeByType(entry, targetType);
      if (found) {
        return found;
      }
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  const rawType = record['@type'];
  if (
    rawType === targetType ||
    (Array.isArray(rawType) && rawType.some((entry) => entry === targetType))
  ) {
    return record;
  }
  if (Array.isArray(record['@graph'])) {
    return findJsonLdNodeByType(record['@graph'], targetType);
  }
  return null;
}

export async function assertRouteSeoAndJsonLd(
  page: Page,
  spec: PublicRouteSpec,
  origin: string,
): Promise<void> {
  const seo = await extractHeadSeo(page);

  expect(seo.title.length, `${spec.path}: <title> must be non-empty`).toBeGreaterThan(0);

  const heading = page.locator('h1').first();
  await expect(heading, `${spec.path}: <h1> must be visible`).toBeVisible();
  const headingText = ((await heading.textContent()) ?? '').trim();
  expect(headingText.length, `${spec.path}: <h1> must be non-empty`).toBeGreaterThan(0);

  if (spec.expectedHeadingFragment) {
    expect(headingText, `${spec.path}: <h1> should match expected guide title`).toContain(
      spec.expectedHeadingFragment,
    );
  }

  const expectedCanonical = expectedCanonicalUrl(origin, spec.path);
  const expectedEnUrl = expectedCanonicalUrl(origin, spec.enPath);
  const expectedZhUrl = expectedCanonicalUrl(origin, spec.zhPath);

  expect(seo.canonical, `${spec.path}: missing <link rel="canonical">`).toBeTruthy();
  expect(normalizeSeoUrl(seo.canonical!), `${spec.path}: self-referencing canonical mismatch`).toBe(
    normalizeSeoUrl(expectedCanonical),
  );
  expect(seo.alternates.en, `${spec.path}: missing hreflang="en"`).toBeTruthy();
  expect(normalizeSeoUrl(seo.alternates.en!), `${spec.path}: hreflang="en" mismatch`).toBe(
    normalizeSeoUrl(expectedEnUrl),
  );
  expect(seo.alternates['zh-CN'], `${spec.path}: missing hreflang="zh-CN"`).toBeTruthy();
  expect(normalizeSeoUrl(seo.alternates['zh-CN']!), `${spec.path}: hreflang="zh-CN" mismatch`).toBe(
    normalizeSeoUrl(expectedZhUrl),
  );
  expect(seo.alternates['x-default'], `${spec.path}: missing hreflang="x-default"`).toBeTruthy();
  expect(
    normalizeSeoUrl(seo.alternates['x-default']!),
    `${spec.path}: hreflang="x-default" must equal en`,
  ).toBe(normalizeSeoUrl(expectedEnUrl));

  if (spec.locale === 'zh-CN') {
    expect(seo.hasZhLangScope, `${spec.path}: expected lang="zh-CN" on html or page wrapper`).toBe(
      true,
    );
  } else {
    expect(
      seo.htmlLang.toLowerCase(),
      `${spec.path}: expected <html lang="en"> on English route`,
    ).toMatch(/^en(?:-|$)/);
  }

  expect(
    seo.jsonLdRawScripts.length,
    `${spec.path}: expected at least one <script type="application/ld+json">`,
  ).toBeGreaterThan(0);

  const declaredTypes = new Set<string>();
  const parsedRoots: Array<Record<string, unknown>> = [];
  for (const raw of seo.jsonLdRawScripts) {
    const parsed = assertValidJsonLd(raw);
    parsedRoots.push(parsed);
    collectJsonLdTypes(parsed, declaredTypes);
  }

  for (const requiredType of spec.requiredJsonLdTypes) {
    expect(
      declaredTypes.has(requiredType),
      `${spec.path}: missing required JSON-LD @type "${requiredType}" (found: [${[...declaredTypes].join(', ')}])`,
    ).toBe(true);
  }

  if (spec.requiredJsonLdTypes.includes('FAQPage')) {
    const faqNode = parsedRoots
      .map((root) => findJsonLdNodeByType(root, 'FAQPage'))
      .find((node) => node !== null);
    expect(faqNode, `${spec.path}: FAQPage node not found`).toBeTruthy();
    const mainEntity = faqNode?.mainEntity;
    expect(
      Array.isArray(mainEntity) && mainEntity.length > 0,
      `${spec.path}: FAQPage.mainEntity must contain at least one Question/Answer pair`,
    ).toBe(true);
  }

  if (spec.requiredJsonLdTypes.includes('TechArticle')) {
    const articleNode = parsedRoots
      .map((root) => findJsonLdNodeByType(root, 'TechArticle'))
      .find((node) => node !== null);
    expect(articleNode, `${spec.path}: TechArticle node not found`).toBeTruthy();
    const headline = articleNode?.headline;
    expect(
      typeof headline === 'string' && headline.trim().length > 0,
      `${spec.path}: TechArticle.headline must be non-empty`,
    ).toBe(true);
  }
}

export interface RobotsGroupRules {
  allows: string[];
  disallows: string[];
}

export interface ParsedRobotsTxt {
  groups: Record<string, RobotsGroupRules>;
  sitemaps: string[];
}

export function parseRobotsTxt(text: string): ParsedRobotsTxt {
  const groups: Record<string, RobotsGroupRules> = {};
  const sitemaps: string[] = [];
  let activeAgents: string[] = [];
  let seenNonAgentRule = false;

  const ensureGroup = (agent: string): RobotsGroupRules => {
    if (!groups[agent]) {
      groups[agent] = { allows: [], disallows: [] };
    }
    return groups[agent];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) {
      continue;
    }
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }
    const directive = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();

    if (directive === 'sitemap') {
      if (value) {
        sitemaps.push(value);
      }
      continue;
    }

    if (directive === 'user-agent') {
      const agent = value.toLowerCase();
      if (!agent) {
        continue;
      }
      if (seenNonAgentRule) {
        activeAgents = [agent];
        seenNonAgentRule = false;
      } else if (!activeAgents.includes(agent)) {
        activeAgents.push(agent);
      }
      ensureGroup(agent);
      continue;
    }

    if (activeAgents.length === 0) {
      continue;
    }

    seenNonAgentRule = true;
    if (directive === 'allow') {
      for (const agent of activeAgents) {
        ensureGroup(agent).allows.push(value);
      }
    } else if (directive === 'disallow') {
      for (const agent of activeAgents) {
        ensureGroup(agent).disallows.push(value);
      }
    }
  }
  return { groups, sitemaps };
}

export interface ParsedSitemapEntry {
  loc: string;
  hreflangs: string[];
}

export interface ParsedSitemapXml {
  locs: string[];
  hreflangs: string[];
  entries: ParsedSitemapEntry[];
}

function parseTagAttributes(tagText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z0-9:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null = attrRe.exec(tagText);
  while (match) {
    attrs[match[1].toLowerCase()] = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    match = attrRe.exec(tagText);
  }
  return attrs;
}

export function parseSitemapXml(xml: string): ParsedSitemapXml {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  const locs: string[] = [];
  const hreflangs: string[] = [];
  const entries: ParsedSitemapEntry[] = [];

  const urlBlockRe = /<(?:[a-z0-9_-]+:)?url\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_-]+:)?url>/gi;
  const locRe =
    /<(?:[a-z0-9_-]+:)?loc\b[^>]*>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+))\s*<\/(?:[a-z0-9_-]+:)?loc>/i;
  const linkTagRe = /<(?:[a-z0-9_-]+:)?link\b[^>]*>/gi;

  let blockMatch: RegExpExecArray | null = urlBlockRe.exec(withoutComments);
  while (blockMatch) {
    const blockBody = blockMatch[1];
    const locMatch = locRe.exec(blockBody);
    const rawLoc = (locMatch?.[1] ?? locMatch?.[2] ?? '').trim();

    const entryHreflangs: string[] = [];
    linkTagRe.lastIndex = 0;
    let linkMatch: RegExpExecArray | null = linkTagRe.exec(blockBody);
    while (linkMatch) {
      const attrs = parseTagAttributes(linkMatch[0]);
      if ((attrs.rel ?? '').toLowerCase() === 'alternate' && attrs.hreflang && attrs.href) {
        entryHreflangs.push(attrs.hreflang);
        hreflangs.push(attrs.hreflang);
      }
      linkMatch = linkTagRe.exec(blockBody);
    }

    if (rawLoc) {
      locs.push(rawLoc);
      entries.push({ loc: rawLoc, hreflangs: entryHreflangs });
    }

    blockMatch = urlBlockRe.exec(withoutComments);
  }

  return { locs, hreflangs, entries };
}

export interface ParsedHtmlSeo {
  canonical: string | null;
  alternates: Record<string, string>;
  jsonLdRawScripts: string[];
}

export function extractHtmlSeoFromMarkup(html: string): ParsedHtmlSeo {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(withoutComments);
  const headMarkup = headMatch ? headMatch[1] : withoutComments;

  let canonical: string | null = null;
  const alternates: Record<string, string> = {};

  const linkTagRe = /<link\b[^>]*>/gi;
  let linkMatch: RegExpExecArray | null = linkTagRe.exec(headMarkup);
  while (linkMatch) {
    const attrs = parseTagAttributes(linkMatch[0]);
    const rel = (attrs.rel ?? '').toLowerCase();
    const href = attrs.href ?? '';
    if (rel === 'canonical' && href) {
      canonical = href;
    } else if (rel === 'alternate' && attrs.hreflang && href) {
      alternates[attrs.hreflang] = href;
    }
    linkMatch = linkTagRe.exec(headMarkup);
  }

  const jsonLdRawScripts: string[] = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let scriptMatch: RegExpExecArray | null = scriptRe.exec(withoutComments);
  while (scriptMatch) {
    const attrs = parseTagAttributes(scriptMatch[1]);
    if ((attrs.type ?? '').toLowerCase() === 'application/ld+json') {
      const content = scriptMatch[2].trim();
      if (content) {
        jsonLdRawScripts.push(content);
      }
    }
    scriptMatch = scriptRe.exec(withoutComments);
  }

  return { canonical, alternates, jsonLdRawScripts };
}

// ---------- Header & Locale Helpers ----------

export async function clickHeaderLocaleSwitcher(
  page: Page,
  targetLocale: MarketingLocale,
): Promise<void> {
  const header = page.locator('header').first();
  await expect(header).toBeVisible();

  const labelPattern = targetLocale === 'zh-CN' ? /中文|简体中文|ZH/i : /^EN$|English/i;
  const switcher = header
    .getByRole('link', { name: labelPattern })
    .or(header.getByRole('button', { name: labelPattern }))
    .first();

  await expect(switcher).toBeVisible();
  await switcher.click();
}

export function getHeaderAuthCta(page: Page): Locator {
  const header = page.locator('header').first();
  return header
    .getByRole('link', { name: /Sign In|登录|Enter Console|进入控制台/i })
    .or(header.getByRole('button', { name: /Sign In|登录|Enter Console|进入控制台/i }))
    .first();
}

// ---------- Calculator Helpers ----------

export function parseDisplayedInteger(rawText: string): number | null {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }
  if (/NaN|Infinity/i.test(trimmed)) {
    return null;
  }
  if (/(?<!\w)[-\u2212]\s*\d/.test(trimmed)) {
    return null;
  }
  if (/\d+\.\d+/.test(trimmed)) {
    return null;
  }
  const match = trimmed.match(/(?<!\d)(?:\d{1,3}(?:,\d{3})+|\d+)(?!\d)/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[0].replace(/,/g, ''), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function readCalculatorTotalPoints(page: Page): Promise<number> {
  const totalEl = page.getByTestId('calculator-total-points');
  await expect(totalEl).toBeVisible();
  const raw = (await totalEl.textContent()) ?? '';
  const parsed = parseDisplayedInteger(raw);
  expect(
    parsed,
    `Displayed numeric text must be a non-negative integer without NaN/Infinity/decimals/minus: "${raw.trim()}"`,
  ).not.toBeNull();
  return parsed!;
}

function getCalculatorContainer(page: Page): Locator {
  return page
    .locator('section, form, article, div')
    .filter({ has: page.getByTestId('calculator-total-points') })
    .filter({ has: page.locator('input:not([type="hidden"]), [role="slider"], [role="switch"]') })
    .last();
}

const CALCULATOR_FIELD_PATTERNS: Readonly<
  Record<
    'articles' | 'channels' | 'prompts' | 'engines',
    { label: RegExp; nameHint: string; fallbackIndex: number }
  >
> = {
  articles: {
    label: /monthly articles|articles\s*\/?\s*month|月度.*母稿|月度.*篇|每月.*篇|文章数/i,
    nameHint: 'monthlyArticles',
    fallbackIndex: 0,
  },
  channels: {
    label: /variant|channels?\s*per\s*article|派生.*渠道|变体.*渠道|分发渠道/i,
    nameHint: 'variantChannelsPerArticle',
    fallbackIndex: 1,
  },
  prompts: {
    label: /tracked prompts|prompts|监测问句|核心问句|追踪.*问句|问题数/i,
    nameHint: 'trackedPrompts',
    fallbackIndex: 2,
  },
  engines: {
    label: /monitored engines|ai engines|engines|监测引擎|引擎数/i,
    nameHint: 'monitoredEngines',
    fallbackIndex: 3,
  },
};

async function setSliderOrNumberValue(control: Locator, targetValue: number): Promise<void> {
  const tagInfo = await control.evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type')?.toLowerCase() ?? '',
    role: el.getAttribute('role')?.toLowerCase() ?? '',
  }));

  if (
    tagInfo.tag === 'input' &&
    (tagInfo.type === 'range' ||
      tagInfo.type === 'number' ||
      tagInfo.type === 'text' ||
      tagInfo.type === '')
  ) {
    await control.fill(String(targetValue));
    if (tagInfo.type !== 'range') {
      await control.press('Tab').catch(() => undefined);
    }
    return;
  }

  if (tagInfo.role === 'slider') {
    await control.focus();
    const min = Number((await control.getAttribute('aria-valuemin')) ?? '0');
    const max = Number((await control.getAttribute('aria-valuemax')) ?? '100');
    if (targetValue <= min) {
      await control.press('Home');
    } else if (targetValue >= max) {
      await control.press('End');
    } else {
      for (let step = 0; step < 120; step += 1) {
        const current = Number((await control.getAttribute('aria-valuenow')) ?? String(min));
        if (current === targetValue) {
          break;
        }
        await control.press(current < targetValue ? 'ArrowRight' : 'ArrowLeft');
      }
    }
    await expect
      .poll(async () => Number(await control.getAttribute('aria-valuenow')), {
        timeout: 3_000,
        message: `Custom slider aria-valuenow must equal ${targetValue}`,
      })
      .toBe(targetValue);
    return;
  }

  await control.fill(String(targetValue));
}

export async function setCalculatorNumericInput(
  page: Page,
  field: 'articles' | 'channels' | 'prompts' | 'engines',
  value: number,
): Promise<void> {
  const container = getCalculatorContainer(page);
  const spec = CALCULATOR_FIELD_PATTERNS[field];

  const byName = container
    .locator(
      `input[name="${spec.nameHint}"], input[id*="${spec.nameHint}"], input[data-field="${spec.nameHint}"]`,
    )
    .first();
  if ((await byName.count()) > 0 && (await byName.isVisible())) {
    await setSliderOrNumberValue(byName, value);
    return;
  }

  const byLabel = container.getByLabel(spec.label).first();
  if ((await byLabel.count()) > 0 && (await byLabel.isVisible())) {
    await setSliderOrNumberValue(byLabel, value);
    return;
  }

  // Keep homogeneous fallback groups separate so paired slider + InputNumber controls never mis-index.
  const fallbackGroups = [
    container.locator('input[type="range"]'),
    container.locator('input[type="number"], [role="spinbutton"]'),
    container.locator('[role="slider"]'),
  ];
  for (const group of fallbackGroups) {
    if ((await group.count()) > spec.fallbackIndex) {
      const candidate = group.nth(spec.fallbackIndex);
      if (await candidate.isVisible()) {
        await setSliderOrNumberValue(candidate, value);
        return;
      }
    }
  }

  expect(
    0,
    `Expected calculator numeric/range control for "${field}" (index ${spec.fallbackIndex}) inside calculator container`,
  ).toBeGreaterThan(spec.fallbackIndex);
}

export async function setCalculatorAutoRetest(page: Page, enabled: boolean): Promise<void> {
  const container = getCalculatorContainer(page);

  const labeledSwitch = container
    .getByRole('switch', { name: /retest|auto|T\+7|复测/i })
    .or(container.getByRole('checkbox', { name: /retest|auto|T\+7|复测/i }))
    .or(
      container.locator(
        'input[type="checkbox"][name*="retest" i], input[type="checkbox"][id*="retest" i]',
      ),
    )
    .first();

  const toggle =
    (await labeledSwitch.count()) > 0
      ? labeledSwitch
      : container.locator('[role="switch"], input[type="checkbox"]').first();

  await expect(toggle, 'Auto-retest toggle must be visible in calculator').toBeVisible();

  const state = await toggle.evaluate((el) => {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      return el.checked;
    }
    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked !== null) {
      return ariaChecked === 'true';
    }
    const ariaPressed = el.getAttribute('aria-pressed');
    if (ariaPressed !== null) {
      return ariaPressed === 'true';
    }
    return false;
  });

  if (state !== enabled) {
    await toggle.click();
  }
}

async function locateFirstVisibleMatch(candidates: Locator[]): Promise<Locator | null> {
  for (const candidate of candidates) {
    const count = await candidate.count();
    for (let i = 0; i < count; i += 1) {
      const item = candidate.nth(i);
      if (await item.isVisible()) {
        return item;
      }
    }
  }
  return null;
}

export async function setCalculatorSamples(page: Page, samples: 1 | 3): Promise<void> {
  const container = getCalculatorContainer(page);

  const pattern =
    samples === 3
      ? /(?:^|[^\d])3\s*(?:x|×|samples?|runs?|次)|\b3x\b|高置信/i
      : /(?:^|[^\d])1\s*(?:x|×|samples?|runs?|次)|\b1x\b|标准/i;

  const nativeSelect = container
    .locator('select[name*="sample" i], select[id*="sample" i]')
    .first();
  if ((await nativeSelect.count()) > 0 && (await nativeSelect.isVisible())) {
    await nativeSelect.selectOption(String(samples));
    return;
  }

  const combobox = container.getByRole('combobox', { name: /sample|采样|置信/i }).first();
  if ((await combobox.count()) > 0 && (await combobox.isVisible())) {
    await pickAntdOrNativeSelectOption(page, combobox, pattern, String(samples));
    return;
  }

  // Sequential priority (never combine with DOM-ordered .or(label).first()):
  // 1) visible button, 2) radio wrapper label (AntD Radio.Button / Segmented / styled radios), 3) bare radio
  const optionControl = await locateFirstVisibleMatch([
    container.getByRole('button', { name: pattern }),
    container.locator('label:has(input[type="radio"])').filter({ hasText: pattern }),
    container.getByRole('radio', { name: pattern }),
  ]);

  expect(
    optionControl,
    `Calculator samples control for ${samples}x must be visible and selectable`,
  ).not.toBeNull();
  await optionControl!.click();
}

export async function clickPricingHandoffCta(page: Page, locale: MarketingLocale): Promise<void> {
  const expectedPrefix = locale === 'zh-CN' ? '/zh/demo' : '/demo';
  const container = getCalculatorContainer(page);

  // Prioritize calculator-generated handoff links carrying estimatedPts before generic /demo links
  const chosen = await locateFirstVisibleMatch([
    container.locator(`a[href^="${expectedPrefix}"][href*="estimatedPts"]`),
    page.locator(`main a[href^="${expectedPrefix}"][href*="estimatedPts"]`),
    container.locator(`a[href^="${expectedPrefix}"]`),
    container.getByRole('link', {
      name: /apply|request|trial|demo|estimate|带配置|申请试用|预约演示/i,
    }),
    page.locator(`main a[href^="${expectedPrefix}?"]`),
  ]);

  expect(
    chosen,
    `Pricing calculator handoff link to ${expectedPrefix} must be visible`,
  ).not.toBeNull();
  await chosen!.click();
}

// ---------- Demo Form Helpers ----------

async function locateFormField(
  form: Locator,
  name: string,
  labelPattern: RegExp,
): Promise<Locator> {
  const byName = form
    .locator(
      `input[name="${name}"], textarea[name="${name}"], select[name="${name}"], [id$="_${name}"], [id="${name}"]`,
    )
    .first();
  if ((await byName.count()) > 0 && (await byName.isVisible())) {
    return byName;
  }
  const byLabel = form.getByLabel(labelPattern).first();
  await expect(byLabel, `Demo form field "${name}" must be visible`).toBeVisible();
  return byLabel;
}

async function selectDemoMarket(
  page: Page,
  form: Locator,
  market: MarketingLeadMarket,
): Promise<void> {
  const nativeSelect = form
    .locator('select[name="targetMarket"], select[id$="targetMarket"]')
    .first();
  if ((await nativeSelect.count()) > 0 && (await nativeSelect.isVisible())) {
    await nativeSelect.selectOption(market);
    return;
  }

  const radioInput = form
    .locator(`input[type="radio"][name="targetMarket"][value="${market}"]`)
    .first();
  if ((await radioInput.count()) > 0) {
    const radioLabel = form
      .locator(`label:has(input[type="radio"][name="targetMarket"][value="${market}"])`)
      .or(form.locator(`label:has(input[type="radio"][value="${market}"])`))
      .first();
    if ((await radioLabel.count()) > 0 && (await radioLabel.isVisible())) {
      await radioLabel.click();
      return;
    }
    if (await radioInput.isVisible()) {
      await radioInput.check();
      return;
    }
  }

  const marketLabelPatterns: Record<MarketingLeadMarket, RegExp> = {
    GLOBAL: /^(?![\s\S]*(?:\+|both|双市场|国内|中国|\bChina\b))[\s\S]*(?:\bGlobal\b|海外)/i,
    CN: /^(?![\s\S]*(?:\+|both|双市场|海外|\bGlobal\b))[\s\S]*(?:\bChina\b|\bCN\b|国内|中国)/i,
    BOTH: /Global\s*\+\s*China|海外\s*\+\s*(?:国内|中国)|\bBoth\b|双市场/i,
  };
  const labelPattern = marketLabelPatterns[market];

  const combobox = form.getByRole('combobox', { name: /market|市场/i }).first();
  if ((await combobox.count()) > 0 && (await combobox.isVisible())) {
    await pickAntdOrNativeSelectOption(page, combobox, labelPattern, market);
    return;
  }

  const buttonOption = await locateFirstVisibleMatch([
    form.getByRole('button', { name: labelPattern }),
    form.locator('label:has(input[type="radio"])').filter({ hasText: labelPattern }),
    form.getByRole('radio', { name: labelPattern }),
  ]);

  expect(
    buttonOption,
    `Demo form targetMarket control for "${market}" must be visible and selectable`,
  ).not.toBeNull();
  await buttonOption!.click();
}

export async function fillAndSubmitDemoForm(
  page: Page,
  input: DemoFormInput,
): Promise<{
  status: number;
  envelope: { code: number; msg?: string; data?: { accepted?: boolean; id?: string } };
}> {
  const form = page.locator('main form').first();
  await expect(form).toBeVisible();

  const nameInput = await locateFormField(form, 'name', /name|姓名|联系人/i);
  await nameInput.fill(input.name);

  const emailInput = await locateFormField(form, 'email', /email|工作邮箱|邮箱/i);
  await emailInput.fill(input.email);

  const companyInput = await locateFormField(form, 'companyBrand', /company|brand|公司|品牌/i);
  await companyInput.fill(input.companyBrand);

  if (input.websiteUrl !== undefined) {
    const websiteInput = await locateFormField(form, 'websiteUrl', /website|url|官网|网址/i);
    await websiteInput.fill(input.websiteUrl);
  }

  if (input.targetMarket) {
    await selectDemoMarket(page, form, input.targetMarket);
  }

  if (input.monthlyGoal !== undefined) {
    const goalInput = await locateFormField(form, 'monthlyGoal', /monthly goal|goal|月度|目标/i);
    await goalInput.fill(input.monthlyGoal);
  }

  if (input.notes !== undefined) {
    const notesInput = await locateFormField(form, 'notes', /notes|需求|补充|备注/i);
    await notesInput.fill(input.notes);
  }

  const submitButton = form
    .locator('button[type="submit"]')
    .or(form.getByRole('button', { name: /request|submit|apply|提交|申请/i }))
    .first();
  await expect(submitButton).toBeVisible();

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().includes('/api/v2/public/leads'),
      { timeout: 15_000 },
    ),
    submitButton.click(),
  ]);

  const rawText = await response.text();
  const envelope = JSON.parse(rawText) as {
    code: number;
    msg?: string;
    data?: { accepted?: boolean; id?: string };
  };

  return { status: response.status(), envelope };
}

// ---------- Admin Leads API & UI Helpers ----------

export async function queryAdminLeadsApi(
  adminToken: string,
  params: Record<string, string | number | undefined>,
): Promise<AdminLeadListPayload> {
  const qs = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && String(val).length > 0) {
      qs.set(key, String(val));
    }
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await requestV1<AdminLeadListPayload>(`/admin/leads${suffix}`, {
    method: 'GET',
    token: adminToken,
  });
  return unwrapOk(res, `GET /admin/leads${suffix}`);
}

export async function searchAdminLeadsInUi(page: Page, keyword: string): Promise<Locator> {
  const main = page.locator('main').first();
  await expect(main).toBeVisible();

  // Sequential priority (never match AntD <Select>'s internal readonly <input type="search" role="combobox">)
  const searchCandidates = [
    main.locator('input[placeholder*="搜索"], input[placeholder*="关键词"]'),
    main.getByRole('textbox', { name: /搜索|关键词|keyword|search/i }),
    main.locator(
      'input[type="search"]:not([role="combobox"]):not([readonly]), input[type="text"]:not([readonly])',
    ),
  ];

  let searchInput: Locator | null = null;
  await expect
    .poll(
      async () => {
        searchInput = await locateFirstVisibleMatch(searchCandidates);
        return searchInput !== null;
      },
      { timeout: 10_000, message: 'Admin leads keyword search input must become visible' },
    )
    .toBe(true);

  await searchInput!.fill(keyword);
  await searchInput!.press('Enter').catch(() => undefined);

  const searchButton = main.getByRole('button', { name: /搜索|查询|筛选/i }).first();
  if ((await searchButton.count()) > 0 && (await searchButton.isVisible())) {
    await searchButton.click();
  }

  const matchingRow = main.locator('tbody tr').filter({ hasText: keyword }).first();
  await expect(
    matchingRow,
    `Expected lead row matching "${keyword}" to appear in /admin/leads table`,
  ).toBeVisible({ timeout: 15_000 });
  return matchingRow;
}

async function pickAntdOrNativeSelectOption(
  page: Page,
  selectContainer: Locator,
  optionLabelOrPattern: string | RegExp,
  optionValue: string,
): Promise<void> {
  const meta = await selectContainer.evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    isAntd: el.classList.contains('ant-select') || Boolean(el.closest('.ant-select')),
  }));
  if (meta.tag === 'select') {
    await selectContainer.selectOption(optionValue);
    return;
  }

  const labelPattern =
    optionLabelOrPattern instanceof RegExp
      ? optionLabelOrPattern
      : new RegExp(`${escapeRegExp(optionLabelOrPattern)}|${escapeRegExp(optionValue)}`, 'i');
  const labelDesc =
    optionLabelOrPattern instanceof RegExp ? optionLabelOrPattern.source : optionLabelOrPattern;

  const clickTarget = meta.isAntd
    ? selectContainer.locator(
        'xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
      )
    : selectContainer;
  await clickTarget.click();

  // AntD 5 rc-select renders a 0x0 screen-reader [role="listbox"] [role="option"] BEFORE
  // the visible .ant-select-item-option nodes. Never combine the two in one selector!
  const openAntdDropdown = page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    .last();

  if (meta.isAntd) {
    await expect(
      openAntdDropdown,
      `AntD select dropdown for "${labelDesc}" must open`,
    ).toBeVisible();
  }

  const antdDropdownVisible =
    meta.isAntd || ((await openAntdDropdown.count()) > 0 && (await openAntdDropdown.isVisible()));

  if (antdDropdownVisible) {
    const antdOptions = openAntdDropdown.locator('.ant-select-item-option');
    const byText = antdOptions.filter({ hasText: labelPattern }).first();
    if ((await byText.count()) > 0) {
      await expect(byText, `AntD select option "${labelDesc}" must be visible`).toBeVisible();
      await byText.click();
      return;
    }

    const optCount = await antdOptions.count();
    for (let i = 0; i < optCount; i += 1) {
      const opt = antdOptions.nth(i);
      const attrsText = await opt.evaluate((el) =>
        [el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '', el.textContent ?? '']
          .join(' ')
          .trim(),
      );
      if (labelPattern.test(attrsText)) {
        await expect(opt).toBeVisible();
        await opt.click();
        return;
      }
    }

    expect(false, `AntD select option matching "${labelDesc}" was not found in open dropdown`).toBe(
      true,
    );
    return;
  }

  // Only when NO AntD dropdown is present, fall back to visible WAI-ARIA listbox options
  const ariaOption = page
    .locator('[role="listbox"] [role="option"]:visible')
    .filter({ hasText: labelPattern })
    .first();
  await expect(ariaOption, `Option "${labelDesc}" must appear in listbox`).toBeVisible();
  await ariaOption.click();
}

export async function updateAdminLeadStatusAndNoteInUi(
  page: Page,
  row: Locator,
  opts: {
    status: MarketingLeadStatus;
    adminNote?: string;
  },
): Promise<void> {
  const statusLabel = LEAD_STATUS_LABELS[opts.status];

  const actionTrigger = row
    .getByRole('button', { name: /编辑|处理|跟进|更新|备注|详情|修改/i })
    .first();

  if ((await actionTrigger.count()) > 0 && (await actionTrigger.isVisible())) {
    await actionTrigger.click();
    const dialog = page.getByRole('dialog').last();
    await expect(dialog, 'Admin lead edit dialog/drawer must open').toBeVisible();

    const statusSelect = dialog
      .locator('select[name="status"], .ant-select')
      .or(dialog.getByRole('combobox', { name: /状态|status/i }))
      .first();
    await expect(statusSelect).toBeVisible();
    await pickAntdOrNativeSelectOption(page, statusSelect, statusLabel, opts.status);

    if (opts.adminNote !== undefined) {
      const noteInput = dialog
        .locator('textarea, input[name="adminNote"]')
        .or(dialog.getByRole('textbox', { name: /备注|note/i }))
        .first();
      await expect(noteInput).toBeVisible();
      await noteInput.fill(opts.adminNote);
    }

    const saveBtn = dialog.getByRole('button', { name: /保存|确定|提交|更新|确认/i }).first();
    await expect(saveBtn).toBeVisible();

    const [patchRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'PATCH' && res.url().includes('/api/v1/admin/leads/'),
        { timeout: 15_000 },
      ),
      saveBtn.click(),
    ]);
    expect(patchRes.status(), 'PATCH /api/v1/admin/leads/:id should return 200').toBe(200);
    const body = (await patchRes.json()) as { code: number; data?: Record<string, unknown> };
    expect(body.code).toBe(0);
    if (body.data && typeof body.data === 'object') {
      assertNoForbiddenLeadDtoKeys(body.data, 'PATCH /api/v1/admin/leads/:id (dialog)');
    }
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    return;
  }

  // Fallback for inline table status Select + inline note save
  const inlineSelect = row.locator('select, .ant-select').or(row.getByRole('combobox')).first();
  await expect(
    inlineSelect,
    'Expected either row action button or inline status selector',
  ).toBeVisible();

  const [patchRes] = await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'PATCH' && res.url().includes('/api/v1/admin/leads/'),
      { timeout: 15_000 },
    ),
    pickAntdOrNativeSelectOption(page, inlineSelect, statusLabel, opts.status),
  ]);
  expect(patchRes.status()).toBe(200);
  const body = (await patchRes.json()) as { code: number; data?: Record<string, unknown> };
  expect(body.code).toBe(0);
  if (body.data && typeof body.data === 'object') {
    assertNoForbiddenLeadDtoKeys(body.data, 'PATCH /api/v1/admin/leads/:id (inline status)');
  }

  if (opts.adminNote !== undefined) {
    const inlineNoteInput = row
      .locator(
        'textarea, input:not([role="combobox"]):not([readonly]):not([type="checkbox"]):not([type="radio"])',
      )
      .first();
    await expect(inlineNoteInput, 'Inline admin note input must be visible').toBeVisible();
    await inlineNoteInput.fill(opts.adminNote);
    const inlineSave = row.getByRole('button', { name: /保存|确定/i }).first();
    await expect(inlineSave, 'Inline admin note save button must be visible').toBeVisible();
    const [noteRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'PATCH' && res.url().includes('/api/v1/admin/leads/'),
        { timeout: 15_000 },
      ),
      inlineSave.click(),
    ]);
    expect(noteRes.status()).toBe(200);
    const noteBody = (await noteRes.json()) as { code: number; data?: Record<string, unknown> };
    expect(noteBody.code).toBe(0);
    if (noteBody.data && typeof noteBody.data === 'object') {
      assertNoForbiddenLeadDtoKeys(noteBody.data, 'PATCH /api/v1/admin/leads/:id (inline note)');
    }
  }
}
