import {
  MARKETING_GUIDES,
  SITE_NAME,
  type MarketingGuide,
  type MarketingLocale,
} from '@geomix/shared';
import Link from 'next/link';
import { buildMarketingCanonical, getMarketingSiteUrl } from '../../lib/marketing-i18n';
import { JsonLdScript, type JsonLdData } from './json-ld-script';

export interface GuideDetailViewProps {
  guide: MarketingGuide;
  locale: MarketingLocale;
}

export function buildGuideTechArticleJsonLd(
  guide: MarketingGuide,
  locale: MarketingLocale,
  siteUrl: string = getMarketingSiteUrl(),
): JsonLdData {
  const isZh = locale === 'zh-CN';
  const content = isZh ? guide.zh : guide.en;
  const guidePath = isZh ? `/zh/guides/${guide.slug}` : `/guides/${guide.slug}`;
  const canonicalUrl = buildMarketingCanonical(guidePath, siteUrl);

  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: content.title,
    description: content.description,
    url: canonicalUrl,
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': canonicalUrl,
    },
    inLanguage: locale,
    datePublished: guide.publishedAt,
    dateModified: guide.updatedAt,
    articleSection: content.category,
    keywords: content.tags.join(', '),
    author: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: siteUrl,
    },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: siteUrl,
    },
  };
}

export function GuideDetailView({ guide, locale }: GuideDetailViewProps) {
  const isZh = locale === 'zh-CN';
  const content = isZh ? guide.zh : guide.en;
  const siteUrl = getMarketingSiteUrl();
  const guidesIndexPath = isZh ? '/zh/guides' : '/guides';
  const demoPath = isZh ? '/zh/demo' : '/demo';
  const pricingPath = isZh ? '/zh/pricing' : '/pricing';
  const techArticleSchema = buildGuideTechArticleJsonLd(guide, locale, siteUrl);
  const relatedGuides = MARKETING_GUIDES.filter((item) => item.slug !== guide.slug);

  return (
    <div className="gm-mkt-page">
      <JsonLdScript id={`gm-jsonld-guide-${guide.slug}-${locale}`} data={techArticleSchema} />

      <section className="gm-mkt-section gm-mkt-section-hero">
        <div className="gm-mkt-container">
          <nav className="gm-mkt-breadcrumb" aria-label={isZh ? '返回导航' : 'Breadcrumb'}>
            <Link href={guidesIndexPath} className="gm-mkt-text-link">
              {isZh ? '← 返回 GEO 实操指南' : '← Back to GEO Guides'}
            </Link>
          </nav>

          <header className="gm-mkt-article-header">
            <div className="gm-mkt-guide-meta">
              <span className="gm-mkt-badge gm-mkt-badge-cited">{content.category}</span>
              <span className="gm-mkt-muted gm-num">
                {isZh ? `约 ${guide.readingMinutes} 分钟阅读` : `${guide.readingMinutes} min read`}
              </span>
              <span className="gm-mkt-muted">
                {isZh ? '发布于 ' : 'Published '}
                <time className="gm-mono" dateTime={guide.publishedAt}>
                  {guide.publishedAt}
                </time>
              </span>
            </div>

            <h1 className="gm-mkt-hero-title">{content.title}</h1>
            <p className="gm-mkt-lead">{content.subtitle}</p>

            <ul className="gm-mkt-guide-tags" aria-label={isZh ? '文章标签' : 'Article tags'}>
              {content.tags.map((tag) => (
                <li key={tag} className="gm-mkt-chip-item">
                  {tag}
                </li>
              ))}
            </ul>
          </header>

          <div className="gm-mkt-article-layout">
            <article className="gm-mkt-article-body" data-testid="guide-article-body">
              <div className="gm-mkt-article-takeaways">
                <h2 className="gm-mkt-subhead">
                  {isZh ? '核心工程要点' : 'Key Engineering Takeaways'}
                </h2>
                <ul className="gm-mkt-check-list">
                  {content.keyTakeaways.map((item) => (
                    <li key={item}>
                      <span className="gm-mkt-check-mark" aria-hidden="true">
                        ✓
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {content.sections.map((section) => (
                <section key={section.id} id={section.id} className="gm-mkt-article-section">
                  <h2 className="gm-mkt-article-h2">{section.heading}</h2>
                  {section.paragraphs.map((paragraph, idx) => (
                    <p key={`${section.id}-p-${idx}`} className="gm-mkt-article-p">
                      {paragraph}
                    </p>
                  ))}

                  {section.bullets && section.bullets.length > 0 ? (
                    <ul className="gm-mkt-article-bullets">
                      {section.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  ) : null}

                  {section.codeSnippet ? (
                    <figure className="gm-mkt-draft-box gm-mkt-article-code">
                      <figcaption className="gm-mkt-draft-head">
                        <span>{section.codeSnippet.label}</span>
                        <span className="gm-mkt-badge gm-mkt-badge-info gm-mono">
                          {section.codeSnippet.language}
                        </span>
                      </figcaption>
                      <pre className="gm-mkt-code-pre gm-mono">
                        <code>{section.codeSnippet.code}</code>
                      </pre>
                    </figure>
                  ) : null}
                </section>
              ))}
            </article>

            <aside className="gm-mkt-article-toc">
              <nav aria-label={isZh ? '本文目录' : 'Table of contents'}>
                <span className="gm-mkt-eyebrow">{isZh ? '本文目录' : 'On This Page'}</span>
                <ol className="gm-mkt-toc-list">
                  {content.sections.map((section) => (
                    <li key={section.id}>
                      <a href={`#${section.id}`} className="gm-mkt-toc-link">
                        {section.heading}
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>

              <div className="gm-mkt-toc-cta">
                <p className="gm-mkt-card-desc">
                  {isZh
                    ? '想在您的真实品牌上验证这套 GEO 工程闭环？'
                    : 'Ready to test this GEO workflow on your own brand prompts?'}
                </p>
                <Link
                  href={demoPath}
                  className="gm-mkt-btn gm-mkt-btn-primary gm-mkt-btn-sm gm-mkt-btn-block"
                >
                  {isZh ? '申请 1,000 点 Demo' : 'Request 1,000-Pt Demo'}
                </Link>
              </div>
            </aside>
          </div>
        </div>
      </section>

      <section className="gm-mkt-section">
        <div className="gm-mkt-container">
          <div className="gm-mkt-section-head">
            <span className="gm-mkt-eyebrow">{isZh ? '延伸阅读' : 'Continue Reading'}</span>
            <h2 className="gm-mkt-h2">
              {isZh ? '更多 GEO 工程实操指南' : 'More GEO Engineering Playbooks'}
            </h2>
          </div>

          <div className="gm-mkt-related-grid">
            {relatedGuides.map((other) => {
              const otherContent = isZh ? other.zh : other.en;
              const otherHref = isZh ? `/zh/guides/${other.slug}` : `/guides/${other.slug}`;
              return (
                <article key={other.slug} className="gm-mkt-guide-card">
                  <div className="gm-mkt-guide-meta">
                    <span className="gm-mkt-badge gm-mkt-badge-cited">{otherContent.category}</span>
                    <span className="gm-mkt-muted gm-num">
                      {isZh ? `约 ${other.readingMinutes} 分钟` : `${other.readingMinutes} min`}
                    </span>
                  </div>
                  <h3 className="gm-mkt-card-title">
                    <Link href={otherHref} className="gm-mkt-guide-title-link">
                      {otherContent.title}
                    </Link>
                  </h3>
                  <p className="gm-mkt-card-desc">{otherContent.subtitle}</p>
                  <div className="gm-mkt-guide-footer">
                    <Link href={otherHref} className="gm-mkt-text-link">
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
                {isZh ? '从指南到可验证增长' : 'Turn Engineering Playbooks Into Citations'}
              </span>
              <h2 className="gm-mkt-cta-title">
                {isZh
                  ? '预约演示并申请 1,000 点试用 Demo，落地双市场 GEO 闭环'
                  : 'Request a 1,000-Point Trial Demo to Operationalize Your GEO Stack'}
              </h2>
            </div>
            <div className="gm-mkt-cta-actions">
              <Link href={demoPath} className="gm-mkt-btn gm-mkt-btn-primary">
                {isZh ? '申请 1,000 点 Demo' : 'Request Trial Demo'}
              </Link>
              <Link href={pricingPath} className="gm-mkt-btn gm-mkt-btn-secondary">
                {isZh ? '估算月度点数预算' : 'Estimate Monthly Points'}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
