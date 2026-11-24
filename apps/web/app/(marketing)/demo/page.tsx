import type { Metadata } from 'next';
import Link from 'next/link';
import {
  buildDemoContactPageJsonLd,
  getDemoPageCopy,
  sanitizeDemoSearchParams,
  type DemoSearchParamsInput,
} from '../../../components/marketing/demo-page-utils';
import { DemoRequestForm } from '../../../components/marketing/demo-request-form';
import { JsonLdScript } from '../../../components/marketing/json-ld-script';
import { buildMarketingAlternates } from '../../../lib/marketing-i18n';

type DemoPageProps = {
  searchParams: Promise<DemoSearchParamsInput>;
};

export function generateMetadata(): Metadata {
  return {
    title: 'Request Demo & 1,000-Point Trial · GeoMix',
    description:
      'Request a manually provisioned GeoMix Trial Demo with 1,000 points valid for 365 days across Global and China AI engines.',
    alternates: buildMarketingAlternates('/demo'),
  };
}

export default async function MarketingDemoPage({ searchParams }: DemoPageProps) {
  const resolved = await searchParams;
  const initialPrefill = sanitizeDemoSearchParams(resolved);
  const copy = getDemoPageCopy('en');
  const contactSchema = buildDemoContactPageJsonLd('en');

  return (
    <div className="gm-mkt-page">
      <JsonLdScript id="gm-jsonld-contact-en" data={contactSchema} />

      <section className="gm-mkt-section gm-mkt-section-hero">
        <div className="gm-mkt-container">
          <div className="gm-mkt-section-head">
            <span className="gm-mkt-eyebrow">{copy.eyebrow}</span>
            <h1 className="gm-mkt-hero-title">{copy.title}</h1>
            <p className="gm-mkt-lead">{copy.lead}</p>
          </div>

          <div className="gm-mkt-demo-grid">
            <div className="gm-mkt-demo-card">
              <DemoRequestForm locale="en" initialPrefill={initialPrefill} />
            </div>

            <aside className="gm-mkt-demo-aside">
              <div className="gm-mkt-demo-aside-card">
                <h2 className="gm-mkt-card-title">{copy.provisioningTitle}</h2>
                <p className="gm-mkt-card-desc">{copy.provisioningSubtitle}</p>
                <ol className="gm-mkt-demo-steps">
                  {copy.provisioningSteps.map((step, idx) => (
                    <li key={step}>
                      <span className="gm-mkt-step-num gm-mono">0{idx + 1}</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="gm-mkt-demo-aside-card">
                <h2 className="gm-mkt-card-title">{copy.privacyTitle}</h2>
                <ul className="gm-mkt-check-list">
                  {copy.privacyItems.map((item) => (
                    <li key={item}>
                      <span className="gm-mkt-check-mark" aria-hidden="true">
                        ✓
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <Link href={copy.pricingHref} className="gm-mkt-text-link">
                {copy.pricingLinkLabel}
              </Link>
            </aside>
          </div>
        </div>
      </section>
    </div>
  );
}
