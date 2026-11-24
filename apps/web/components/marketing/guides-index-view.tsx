import { MARKETING_GUIDES, SITE_NAME, type MarketingLocale } from '@geomix/shared';
import Link from 'next/link';
import { buildMarketingCanonical, getMarketingSiteUrl } from '../../lib/marketing-i18n';
import { JsonLdScript, type JsonLdData } from './json-ld-script';

export interface GuidesIndexViewProps {
  locale: MarketingLocale;
}

export function buildGuidesCollectionJsonLd(
  locale: MarketingLocale,
  siteUrl: string = getMarketingSiteUrl(),
): JsonLdData {
  const isZh = locale === 'zh-CN';
  const indexPath = isZh ? '/zh/guides' : '/guides';
  const canonicalUrl = buildMarketingCanonical(indexPath, siteUrl);

  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: isZh
      ? `GEO 实操指南与技术架构专栏 · ${SITE_NAME}`
      : `GEO Engineering Guides & Playbooks · ${SITE_NAME}`,
    description: isZh
      ? '面向出海与国内增长团队的 GEO 工程方法论专栏：涵盖 AI 引用分类、llms.txt 与 JSON-LD、零封号社区分发与 T+7/14/30 归因复测。'
      : 'Technical GEO playbooks covering AI citation taxonomy, llms.txt & JSON-LD architecture, zero-ban community distribution, and T+7/14/30 attribution.',
    url: canonicalUrl,
    inLanguage: locale,
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: siteUrl,
    },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: MARKETING_GUIDES.length,
      itemListElement: MARKETING_GUIDES.map((guide, index) => {
        const content = isZh ? guide.zh : guide.en;
        const guidePath = isZh ? `/zh/guides/${guide.slug}` : `/guides/${guide.slug}`;
        return {
          '@type': 'ListItem',
          position: index + 1,
          url: buildMarketingCanonical(guidePath, siteUrl),
          name: content.title,
          description: content.description,
        };
      }),
    },
  };
}

export function GuidesIndexView({ locale }: GuidesIndexViewProps) {
  const isZh = locale === 'zh-CN';
  const siteUrl = getMarketingSiteUrl();
  const demoPath = isZh ? '/zh/demo' : '/demo';
  const pricingPath = isZh ? '/zh/pricing' : '/pricing';
  const collectionSchema = buildGuidesCollectionJsonLd(locale, siteUrl);

  return (
    <div className="gm-mkt-page">
      <JsonLdScript id={`gm-jsonld-guides-collection-${locale}`} data={collectionSchema} />

      <section className="gm-mkt-section gm-mkt-section-hero">
        <div className="gm-mkt-container">
          <div className="gm-mkt-section-head">
            <span className="gm-mkt-eyebrow">
              {isZh ? 'GEO 方法论与工程实操专栏' : 'GEO Engineering Playbooks'}
            </span>
            <h1 className="gm-mkt-hero-title">
              {isZh ? 'GEO 实操指南与技术架构专栏' : 'GEO Engineering Guides & Playbooks'}
            </h1>
            <p className="gm-mkt-lead">
              {isZh
                ? '拒绝空泛概念——围绕双市场 AI 引用拓扑诊断、可抓取结构化信号、合规社区分发与 T+7/14/30 归因复测，提供可直接落地的工程手册。'
                : 'Field-tested engineering guides for dual-market AI citation diagnosis, crawlable structured signals, compliant community distribution, and T+7/14/30 attribution.'}
            </p>
          </div>

          <div className="gm-mkt-guides-grid" data-testid="guides-list">
            {MARKETING_GUIDES.map((guide) => {
              const content = isZh ? guide.zh : guide.en;
              const href = isZh ? `/zh/guides/${guide.slug}` : `/guides/${guide.slug}`;

              return (
                <article key={guide.slug} className="gm-mkt-guide-card">
                  <div className="gm-mkt-guide-meta">
                    <span className="gm-mkt-badge gm-mkt-badge-cited">{content.category}</span>
                    <span className="gm-mkt-muted gm-num">
                      {isZh
                        ? `约 ${guide.readingMinutes} 分钟`
                        : `${guide.readingMinutes} min read`}
                    </span>
                    <time className="gm-mkt-muted gm-mono" dateTime={guide.publishedAt}>
                      {guide.publishedAt}
                    </time>
                  </div>

                  <h2 className="gm-mkt-guide-title">
                    <Link href={href} className="gm-mkt-guide-title-link">
                      {content.title}
                    </Link>
                  </h2>

                  <p className="gm-mkt-guide-subtitle">{content.subtitle}</p>
                  <p className="gm-mkt-card-desc">{content.description}</p>

                  <ul className="gm-mkt-guide-tags" aria-label={isZh ? '主题标签' : 'Topics'}>
                    {content.tags.map((tag) => (
                      <li key={tag} className="gm-mkt-chip-item">
                        {tag}
                      </li>
                    ))}
                  </ul>

                  <div className="gm-mkt-guide-footer">
                    <Link href={href} className="gm-mkt-text-link">
                      {isZh ? '阅读全文 →' : 'Read Guide →'}
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="gm-mkt-section">
        <div className="gm-mkt-container">
          <div className="gm-mkt-cta-banner">
            <div className="gm-mkt-cta-copy">
              <span className="gm-mkt-eyebrow">
                {isZh ? '把方法论变成自动化工作流' : 'Put the Playbooks Into Production'}
              </span>
              <h2 className="gm-mkt-cta-title">
                {isZh
                  ? '申请 1,000 点试用 Demo，用真实品牌问句跑通首轮引用诊断'
                  : 'Request Your 1,000-Point Trial Demo to Run Live Citation Diagnostics'}
              </h2>
            </div>
            <div className="gm-mkt-cta-actions">
              <Link href={demoPath} className="gm-mkt-btn gm-mkt-btn-primary">
                {isZh ? '预约演示并申请试用' : 'Request Trial Demo'}
              </Link>
              <Link href={pricingPath} className="gm-mkt-btn gm-mkt-btn-secondary">
                {isZh ? '查看点数定价与计算器' : 'Explore Points Pricing'}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
