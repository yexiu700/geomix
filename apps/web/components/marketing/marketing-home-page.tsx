import Link from 'next/link';
import type { MarketingLocale } from '../../lib/marketing-i18n';
import { FaqAccordion } from './faq-accordion';
import { HeroEngineStrip, InteractiveProductSandbox } from './interactive-product-sandbox';
import { JsonLdScript } from './json-ld-script';
import { HOME_FAQ_ITEMS, HOME_PAGE_COPY, buildHomeJsonLdSchemas } from './marketing-home-data';

export function MarketingHomePage({ locale }: { locale: MarketingLocale }) {
  const copy = HOME_PAGE_COPY[locale];
  const faqItems = HOME_FAQ_ITEMS[locale];
  const schemas = buildHomeJsonLdSchemas(locale);

  return (
    <div className="gm-mkt-home" data-locale={locale}>
      <JsonLdScript id={`gm-jsonld-org-${locale}`} data={schemas.organization} />
      <JsonLdScript id={`gm-jsonld-app-${locale}`} data={schemas.softwareApplication} />
      <JsonLdScript id={`gm-jsonld-faq-${locale}`} data={schemas.faqPage} />

      {/* 1. Hero + Interactive Dual-Market Engine Strip */}
      <section className="gm-mkt-section gm-mkt-section-hero">
        <div className="gm-mkt-container">
          <div className="gm-mkt-hero-inner">
            <span className="gm-mkt-eyebrow">{copy.eyebrow}</span>
            <h1 className="gm-mkt-hero-title">{copy.heroTitle}</h1>
            <p className="gm-mkt-hero-sub">{copy.heroSubtitle}</p>
            <div className="gm-mkt-hero-ctas">
              <Link
                href={copy.primaryCta.href}
                className="gm-mkt-btn gm-mkt-btn-primary"
                data-testid="hero-primary-cta"
              >
                {copy.primaryCta.label}
              </Link>
              <a
                href={copy.secondaryCta.href}
                className="gm-mkt-btn gm-mkt-btn-secondary"
                data-testid="hero-secondary-cta"
              >
                {copy.secondaryCta.label}
              </a>
            </div>
          </div>

          <HeroEngineStrip locale={locale} />
        </div>
      </section>

      {/* 2. 3-Tab Interactive Product Sandbox */}
      <section id="sandbox" className="gm-mkt-section">
        <div className="gm-mkt-container">
          <div className="gm-mkt-section-head">
            <span className="gm-mkt-eyebrow">{copy.sandboxEyebrow}</span>
            <h2 className="gm-mkt-h2">{copy.sandboxTitle}</h2>
            <p className="gm-mkt-lead">{copy.sandboxSubtitle}</p>
          </div>

          <InteractiveProductSandbox locale={locale} />
        </div>
      </section>

      {/* 3. 4-Step Closed-Loop Workflow + Connector Ecosystem + Explicit Upcoming v2.2 Roadmap */}
      <section id="workflow" className="gm-mkt-section">
        <div className="gm-mkt-container">
          <div className="gm-mkt-section-head">
            <span className="gm-mkt-eyebrow">{copy.workflowEyebrow}</span>
            <h2 className="gm-mkt-h2">{copy.workflowTitle}</h2>
            <p className="gm-mkt-lead">{copy.workflowSubtitle}</p>
          </div>

          <div className="gm-mkt-workflow-grid">
            {copy.workflowSteps.map((step) => (
              <article key={step.step} className="gm-mkt-step-card">
                <span className="gm-mkt-step-num gm-num">{step.step}</span>
                <h3 className="gm-mkt-card-title">{step.title}</h3>
                <p className="gm-mkt-card-desc">{step.description}</p>
                <ul className="gm-mkt-step-tags">
                  {step.highlights.map((item) => (
                    <li key={item} className="gm-mkt-step-tag gm-mono">
                      {item}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          <div className="gm-mkt-connector-block">
            <h3 className="gm-mkt-subhead">{copy.connectorsTitle}</h3>
            <div className="gm-mkt-connector-grid">
              {copy.connectors.map((group) => (
                <article key={group.title} className="gm-mkt-connector-card">
                  <span className="gm-mkt-badge gm-mkt-badge-cited">{group.tier}</span>
                  <h4 className="gm-mkt-card-title">{group.title}</h4>
                  <p className="gm-mkt-card-desc">{group.description}</p>
                  <ul className="gm-mkt-chip-list">
                    {group.items.map((item) => (
                      <li key={item} className="gm-mkt-chip-item">
                        {item}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>

          <aside className="gm-mkt-roadmap-banner" data-testid="v22-roadmap-banner">
            <div className="gm-mkt-roadmap-copy">
              <div className="gm-mkt-roadmap-head">
                <span className="gm-mkt-badge gm-mkt-badge-info">{copy.roadmapBadge}</span>
                <h3 className="gm-mkt-roadmap-title">{copy.roadmapTitle}</h3>
              </div>
              <p className="gm-mkt-card-desc">{copy.roadmapDescription}</p>
            </div>
            <ul className="gm-mkt-chip-list">
              {copy.roadmapItems.map((item) => (
                <li key={item} className="gm-mkt-chip-item gm-mkt-chip-roadmap">
                  {item}
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </section>

      {/* 4. 4 Security & Engineering Trust Commitments */}
      <section className="gm-mkt-section">
        <div className="gm-mkt-container">
          <div className="gm-mkt-section-head">
            <span className="gm-mkt-eyebrow">{copy.trustEyebrow}</span>
            <h2 className="gm-mkt-h2">{copy.trustTitle}</h2>
            <p className="gm-mkt-lead">{copy.trustSubtitle}</p>
          </div>

          <div className="gm-mkt-trust-grid">
            {copy.trustCommitments.map((item) => (
              <article key={item.code} className="gm-mkt-trust-card">
                <span className="gm-mkt-trust-code gm-mono">{item.code}</span>
                <h3 className="gm-mkt-card-title">{item.title}</h3>
                <p className="gm-mkt-card-desc">{item.description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* 5. FAQ Accordion + Bottom Conversion Banner */}
      <section id="faq" className="gm-mkt-section">
        <div className="gm-mkt-container">
          <div className="gm-mkt-section-head">
            <span className="gm-mkt-eyebrow">{copy.faqEyebrow}</span>
            <h2 className="gm-mkt-h2">{copy.faqTitle}</h2>
            <p className="gm-mkt-lead">{copy.faqSubtitle}</p>
          </div>

          <FaqAccordion items={faqItems} defaultOpenIndex={0} />

          <div className="gm-mkt-cta-banner">
            <div className="gm-mkt-cta-copy">
              <h2 className="gm-mkt-cta-title">{copy.bottomCtaTitle}</h2>
              <p className="gm-mkt-lead">{copy.bottomCtaSubtitle}</p>
            </div>
            <div className="gm-mkt-cta-actions">
              <Link href={copy.bottomPrimaryCta.href} className="gm-mkt-btn gm-mkt-btn-primary">
                {copy.bottomPrimaryCta.label}
              </Link>
              <Link href={copy.bottomSecondaryCta.href} className="gm-mkt-btn gm-mkt-btn-secondary">
                {copy.bottomSecondaryCta.label}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
