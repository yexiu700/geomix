import type { Metadata } from 'next';
import Link from 'next/link';
import {
  buildDemoContactPageJsonLd,
  getDemoPageCopy,
  sanitizeDemoSearchParams,
  type DemoSearchParamsInput,
} from '../../../../components/marketing/demo-page-utils';
import { DemoRequestForm } from '../../../../components/marketing/demo-request-form';
import { JsonLdScript } from '../../../../components/marketing/json-ld-script';
import { buildMarketingAlternates } from '../../../../lib/marketing-i18n';

type ZhDemoPageProps = {
  searchParams: Promise<DemoSearchParamsInput>;
};

export function generateMetadata(): Metadata {
  return {
    title: '预约演示与 1,000 点试用申请 · GeoMix',
    description:
      '提交品牌信息与目标市场，审核后开通包含 1,000 点额度与 365 天有效期的 GeoMix 双市场 GEO 试用 Demo 账号。',
    alternates: buildMarketingAlternates('/zh/demo'),
  };
}

export default async function MarketingZhDemoPage({ searchParams }: ZhDemoPageProps) {
  const resolved = await searchParams;
  const initialPrefill = sanitizeDemoSearchParams(resolved);
  const prefillKey = `${initialPrefill.targetMarket}|${initialPrefill.estimatedPts ?? ''}|${initialPrefill.monthlyGoal ?? ''}`;
  const copy = getDemoPageCopy('zh-CN');
  const contactSchema = buildDemoContactPageJsonLd('zh-CN');

  return (
    <div lang="zh-CN">
      <div className="gm-mkt-page">
        <JsonLdScript id="gm-jsonld-contact-zh-CN" data={contactSchema} />

        <section className="gm-mkt-section gm-mkt-section-hero">
          <div className="gm-mkt-container">
            <div className="gm-mkt-section-head">
              <span className="gm-mkt-eyebrow">{copy.eyebrow}</span>
              <h1 className="gm-mkt-hero-title">{copy.title}</h1>
              <p className="gm-mkt-lead">{copy.lead}</p>
            </div>

            <div className="gm-mkt-demo-grid">
              <div className="gm-mkt-demo-card">
                <DemoRequestForm key={prefillKey} locale="zh-CN" initialPrefill={initialPrefill} />
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
    </div>
  );
}
