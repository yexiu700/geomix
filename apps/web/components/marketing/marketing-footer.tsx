'use client';

import { SITE_NAME } from '@geomix/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  getMarketingLocaleFromPath,
  switchMarketingPathLocale,
  type MarketingLocale,
} from '../../lib/marketing-i18n';
import { MarketingBrandMark } from './marketing-brand-mark';

function getFooterCopy(locale: MarketingLocale) {
  const isZh = locale === 'zh-CN';
  return {
    homeHref: isZh ? '/zh' : '/',
    tagline: isZh
      ? '面向海外与中文双市场的 GEO 内容创作与 AI 可见度平台。从品牌事实库、引用拓扑诊断到双轨合规门禁与 T+1/7/14/30 归因复测。'
      : 'Dual-market GEO content studio & AI visibility platform (Global + CN). From verified brand facts and citation diagnosis to preflight compliance gates and T+1/7/14/30 attribution.',
    productTitle: isZh ? '产品与页面' : 'Product',
    selfGeoTitle: isZh ? 'Self-GEO 与索引' : 'Self-GEO & Crawlers',
    languageTitle: isZh ? '语言版本' : 'Languages',
    productLinks: isZh
      ? [
          { label: '产品闭环', href: '/zh#workflow' },
          { label: '交互沙盒', href: '/zh#sandbox' },
          { label: '定价与点数', href: '/zh/pricing' },
          { label: 'GEO 指南', href: '/zh/guides' },
          { label: '申请 1,000 点试用', href: '/zh/demo' },
          { label: '登录工作台', href: '/login' },
        ]
      : [
          { label: '4-Step Workflow', href: '/#workflow' },
          { label: 'Interactive Sandbox', href: '/#sandbox' },
          { label: 'Pricing & Points', href: '/pricing' },
          { label: 'GEO Guides', href: '/guides' },
          { label: 'Request 1,000-Pt Trial', href: '/demo' },
          { label: 'Sign In', href: '/login' },
        ],
    selfGeoLinks: [
      { label: 'llms.txt', href: '/llms.txt' },
      { label: 'sitemap.xml', href: '/sitemap.xml' },
      { label: 'robots.txt', href: '/robots.txt' },
    ],
    copyright: isZh
      ? `© 2026 ${SITE_NAME}. 保留所有权利。`
      : `© 2026 ${SITE_NAME}. All rights reserved.`,
    complianceNote: isZh
      ? '严格禁止自动化刷屏与未披露水军发帖 · 仅支持官方连接器与人工复核工作流'
      : 'Strictly zero automated astroturfing or bot posting · Official connectors & human-reviewed workflows only',
  };
}

export function MarketingFooter() {
  const pathname = usePathname() || '/';
  const locale = getMarketingLocaleFromPath(pathname);
  const copy = getFooterCopy(locale);

  const enHref = switchMarketingPathLocale(pathname, 'en');
  const zhHref = switchMarketingPathLocale(pathname, 'zh-CN');

  return (
    <footer className="gm-mkt-footer">
      <div className="gm-mkt-container">
        <div className="gm-mkt-footer-grid">
          <div className="gm-mkt-footer-brand-col">
            <Link href={copy.homeHref} className="gm-mkt-brand">
              <MarketingBrandMark size={20} />
              <span>{SITE_NAME}</span>
            </Link>
            <p className="gm-mkt-footer-tagline">{copy.tagline}</p>
          </div>

          <div className="gm-mkt-footer-col">
            <h2 className="gm-mkt-footer-heading">{copy.productTitle}</h2>
            <ul className="gm-mkt-footer-list">
              {copy.productLinks.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="gm-mkt-footer-link">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="gm-mkt-footer-col">
            <h2 className="gm-mkt-footer-heading">{copy.selfGeoTitle}</h2>
            <ul className="gm-mkt-footer-list">
              {copy.selfGeoLinks.map((item) => (
                <li key={item.href}>
                  <a href={item.href} className="gm-mkt-footer-link gm-mono">
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div className="gm-mkt-footer-col">
            <h2 className="gm-mkt-footer-heading">{copy.languageTitle}</h2>
            <ul className="gm-mkt-footer-list">
              <li>
                <Link
                  href={enHref}
                  hrefLang="en"
                  className={`gm-mkt-footer-link${locale === 'en' ? ' is-active' : ''}`}
                >
                  English (Global Default)
                </Link>
              </li>
              <li>
                <Link
                  href={zhHref}
                  hrefLang="zh-CN"
                  className={`gm-mkt-footer-link${locale === 'zh-CN' ? ' is-active' : ''}`}
                >
                  简体中文 (/zh)
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="gm-mkt-footer-bottom">
          <span>{copy.copyright}</span>
          <span>{copy.complianceNote}</span>
        </div>
      </div>
    </footer>
  );
}
