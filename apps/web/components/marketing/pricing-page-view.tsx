import { SITE_NAME, type MarketingLocale, type PublicPricingPayload } from '@geomix/shared';
import Link from 'next/link';
import { extractCalculatorUnitPoints } from '../../lib/marketing-api';
import { buildMarketingCanonical, getMarketingSiteUrl } from '../../lib/marketing-i18n';
import { FaqAccordion, type FaqAccordionItem } from './faq-accordion';
import { JsonLdScript, type JsonLdData } from './json-ld-script';
import { PointsBudgetCalculator } from './points-budget-calculator';

export interface PricingPageViewProps {
  locale: MarketingLocale;
  pricing: PublicPricingPayload;
}

export function buildPricingFaqItems(
  locale: MarketingLocale,
  pricing: PublicPricingPayload,
): readonly FaqAccordionItem[] {
  const isZh = locale === 'zh-CN';
  const pointsFormatted = pricing.demoTrial.points.toLocaleString('en-US');
  const days = pricing.demoTrial.validDays;

  if (isZh) {
    return [
      {
        id: 'trial-quota',
        question: '试用 Demo 账号包含多少点数？有效期多久？',
        answer: `审核通过后，管理员将为您开通包含 ${pointsFormatted} 点初始额度的试用 Demo 租户，有效期 ${days} 天。您可以完整体验双市场 AI 可见度诊断、品牌事实卡、合规门禁写作与 1→N 分发链路。`,
      },
      {
        id: 'refund-policy',
        question: 'AI 监测超时或写作任务失败会扣除点数吗？',
        answer:
          '不会。GeoMix 采用预扣 + 审计流水账本机制：凡是上游模型超时、抓取失败或任务异常中断，系统会自动全额退还对应点数并在租户账本中留痕可查。',
      },
      {
        id: 'free-capabilities',
        question: '哪些核心能力固定 0 点不消耗额度？',
        answer:
          '所有 7 项高频基础能力（GEO 选题简报、品牌事实卡提取、GEO 0–100 实时体检、局部分段重写、发布前合规门禁校验、T+1 线上抓取与 Schema 体检、免登录 PR/KOL 供稿单）以及 JSON-LD 与 /llms.txt 结构化导出均固定 0 点免费标配，并受合理防刷限流保护。',
      },
      {
        id: 'variant-pricing',
        question: '渠道变体改写如何计费？',
        answer:
          '渠道变体改写按目标渠道派生计费，并支持后台灵活配置为 0 点限流模式。具体单价实时同步自公开计费目录，不含任何隐藏加价。',
      },
      {
        id: 'growth-enterprise',
        question: '增长品牌团队与企业版如何采购点数包与定制配额？',
        answer:
          '您可先通过本页预算计算器估算月度点数消耗，并一键带入 /zh/demo 表单。我们的方案顾问将根据目标市场、品牌数量与并发监测需求为您定制专属点数包与部署方案。',
      },
    ];
  }

  return [
    {
      id: 'trial-quota',
      question: 'How many points and days are included in the Trial Demo?',
      answer: `Once approved, our team provisions a Trial Demo workspace loaded with ${pointsFormatted} points valid for ${days} days. You can evaluate Global + China AI citation diagnosis, Brand Fact Cards, Preflight gating, and 1->N distribution end-to-end.`,
    },
    {
      id: 'refund-policy',
      question: 'Are points deducted if an AI check times out or a generation fails?',
      answer:
        'No. GeoMix uses an auditable reserve-and-settle points ledger. Any failed generation or upstream timeout is automatically refunded in full with a traceable ledger entry.',
    },
    {
      id: 'free-capabilities',
      question: 'Which core capabilities are permanently included at 0 points?',
      answer:
        'All 7 high-frequency workflow utilities (GEO Topic Brief, Brand Fact Card Extraction, Real-Time GEO 0–100 Audit, Targeted Section Rewrite, Pre-Publish Preflight Gate, T+1 Crawl & Schema Probe, and Login-Free PR/KOL Media Kits) plus JSON-LD and /llms.txt export are bundled at 0 points under fair rate limits.',
    },
    {
      id: 'variant-pricing',
      question: 'How is Channel Variant Adaptation metered?',
      answer:
        'Channel Variant Adaptation is metered per derived channel from the live public pricing catalog and can also be configured to 0-point rate-limited mode when enabled by platform policy.',
    },
    {
      id: 'growth-enterprise',
      question: 'How do Growth Brand Teams and Agencies purchase custom point packs?',
      answer:
        'Use the interactive monthly points calculator on this page to model your publishing and monitoring cadence, then hand off your estimate directly to /demo. Our team will tailor point packs, multi-brand quotas, and deployment options to your exact workload.',
    },
  ];
}

/**
 * Builds structured JSON-LD for `/pricing` and `/zh/pricing`.
 * Intentionally omits fiat currency fields (`price`, `priceCurrency`) to comply with zero-fiat-leakage policy.
 */
export function buildPricingJsonLdSchemas(
  locale: MarketingLocale,
  pricing: PublicPricingPayload,
  siteUrl: string = getMarketingSiteUrl(),
): {
  softwareApplication: JsonLdData;
  faqPage: JsonLdData;
} {
  const isZh = locale === 'zh-CN';
  const pricingPath = isZh ? '/zh/pricing' : '/pricing';
  const demoPath = isZh ? '/zh/demo' : '/demo';
  const pricingUrl = buildMarketingCanonical(pricingPath, siteUrl);
  const demoUrl = buildMarketingCanonical(demoPath, siteUrl);
  const faqItems = buildPricingFaqItems(locale, pricing);
  const pointsFormatted = pricing.demoTrial.points.toLocaleString('en-US');

  const softwareApplication: JsonLdData = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    url: pricingUrl,
    inLanguage: locale,
    description: isZh
      ? '透明点数计费的双市场 GEO 内容创作与 AI 可见度平台，提供 1,000 点 / 365 天试用 Demo 额度。'
      : 'Transparent points-based dual-market GEO content creation and AI visibility platform with a complimentary Trial Demo allowance.',
    offers: {
      '@type': 'Offer',
      name: isZh
        ? `GeoMix 试用 Demo（${pointsFormatted} 点 / ${pricing.demoTrial.validDays} 天）`
        : `GeoMix Trial Demo (${pointsFormatted} points / ${pricing.demoTrial.validDays} days)`,
      description: isZh
        ? `面向品牌与增长团队的免费体验额度：含 ${pointsFormatted} 点初始额度与 ${pricing.demoTrial.validDays} 天有效期，失败自动退还点数。`
        : `Complimentary Trial Demo workspace with ${pointsFormatted} points valid for ${pricing.demoTrial.validDays} days and automatic point refunds on task failure.`,
      availability: 'https://schema.org/InStock',
      url: demoUrl,
    },
  };

  const faqPage: JsonLdData = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    url: pricingUrl,
    inLanguage: locale,
    mainEntity: faqItems.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };

  return { softwareApplication, faqPage };
}

export function PricingPageView({ locale, pricing }: PricingPageViewProps) {
  const isZh = locale === 'zh-CN';
  const siteUrl = getMarketingSiteUrl();
  const demoPath = isZh ? '/zh/demo' : '/demo';
  const guidesPath = isZh ? '/zh/guides' : '/guides';
  const faqItems = buildPricingFaqItems(locale, pricing);
  const schemas = buildPricingJsonLdSchemas(locale, pricing, siteUrl);
  const unitPoints = extractCalculatorUnitPoints(pricing);
  const demoPointsText = pricing.demoTrial.points.toLocaleString('en-US');

  const growthHref = `${demoPath}?${new URLSearchParams({
    monthlyGoal: isZh
      ? '增长品牌团队点数包与双市场归因方案咨询'
      : 'Growth Brand Team custom points pack and dual-market attribution plan',
  }).toString()}`;

  const enterpriseHref = `${demoPath}?${new URLSearchParams({
    monthlyGoal: isZh
      ? '企业与代理版多品牌配额及专属部署方案咨询'
      : 'Agency & Enterprise multi-brand quota and dedicated deployment inquiry',
  }).toString()}`;

  const plans = isZh
    ? [
        {
          id: 'trial',
          featured: true,
          badge: '推荐起步',
          name: '试用 Demo',
          metric: `${demoPointsText} 点 · ${pricing.demoTrial.validDays} 天`,
          subtitle: '人工审核开通，零风险验证出海与国内双市场 GEO 闭环。',
          ctaLabel: '申请 1,000 点 Demo 试用',
          ctaHref: demoPath,
          ctaClass: 'gm-mkt-btn gm-mkt-btn-primary gm-mkt-btn-block',
          highlights: [
            `内置 ${demoPointsText} 点全功能体验额度，${pricing.demoTrial.validDays} 天有效`,
            '完整体验 Global + CN 双市场 AI 引用拓扑诊断',
            '标配 7 项 0 点核心能力 + JSON-LD 与 /llms.txt 导出',
            '任务失败或超时自动全额退还点数，流水全程可审计',
          ],
        },
        {
          id: 'growth',
          featured: false,
          badge: '单品牌持续增长',
          name: '增长品牌团队',
          metric: '按需点数包 · 预约获取方案',
          subtitle: '面向 DTC、SaaS 与出海品牌团队的常态化内容生产与定期复测。',
          ctaLabel: '预约增长团队方案',
          ctaHref: growthHref,
          ctaClass: 'gm-mkt-btn gm-mkt-btn-secondary gm-mkt-btn-block',
          highlights: [
            '按月度文章与监测体量灵活配置点数包与配额',
            '自动化 T+7 / T+14 / T+30 归因复测计划',
            'Shopify / WordPress L1 官方连接器与 PR/KOL 供稿单',
            '透明按动作扣点，无隐藏模型加价与隐性捆绑',
          ],
        },
        {
          id: 'enterprise',
          featured: false,
          badge: '多品牌矩阵与专属环境',
          name: '企业与代理版',
          metric: '多品牌定制 · 联系架构顾问',
          subtitle: '面向多品牌集团、代运营机构与合规要求严格的企业团队。',
          ctaLabel: '联系企业架构顾问',
          ctaHref: enterpriseHref,
          ctaClass: 'gm-mkt-btn gm-mkt-btn-secondary gm-mkt-btn-block',
          highlights: [
            '多品牌租户矩阵隔离与高并发 AI 监测配额',
            '支持专属环境部署、私有模型网关与安全审计接入',
            '专属交付顾问协助搭建品牌事实库与门禁规则',
            '统一账本对账与企业级服务保障支持',
          ],
        },
      ]
    : [
        {
          id: 'trial',
          featured: true,
          badge: 'Start Here',
          name: 'Trial Demo',
          metric: `${demoPointsText} pts · ${pricing.demoTrial.validDays} days`,
          subtitle: 'Manually provisioned workspace to validate the complete Global + CN GEO loop.',
          ctaLabel: 'Request 1,000-Pt Demo',
          ctaHref: demoPath,
          ctaClass: 'gm-mkt-btn gm-mkt-btn-primary gm-mkt-btn-block',
          highlights: [
            `${demoPointsText} complimentary points valid for ${pricing.demoTrial.validDays} days`,
            'Full Global + China AI citation topology diagnostics',
            'All 7 zero-point workflow tools + JSON-LD & /llms.txt export',
            'Automatic full point refunds on failure with auditable ledger',
          ],
        },
        {
          id: 'growth',
          featured: false,
          badge: 'Brand Growth Teams',
          name: 'Growth Brand Team',
          metric: 'Custom Points Pack · Contact Sales',
          subtitle:
            'Built for DTC, SaaS, and B2B brand teams running steady publishing and retests.',
          ctaLabel: 'Discuss Growth Pack',
          ctaHref: growthHref,
          ctaClass: 'gm-mkt-btn gm-mkt-btn-secondary gm-mkt-btn-block',
          highlights: [
            'Flexible point packs sized to your publishing and prompt cadence',
            'Scheduled T+7 / T+14 / T+30 post-publish attribution retests',
            'Shopify & WordPress L1 connectors plus login-free PR/KOL kits',
            'Clear action-level metering with zero hidden model surcharges',
          ],
        },
        {
          id: 'enterprise',
          featured: false,
          badge: 'Multi-Brand & Dedicated',
          name: 'Agency & Enterprise',
          metric: 'Multi-Brand Custom · Contact Sales',
          subtitle:
            'Tailored for agencies, multi-brand portfolios, and teams requiring dedicated isolation.',
          ctaLabel: 'Talk to Solutions Team',
          ctaHref: enterpriseHref,
          ctaClass: 'gm-mkt-btn gm-mkt-btn-secondary gm-mkt-btn-block',
          highlights: [
            'Multi-brand workspace isolation & high-concurrency monitoring quotas',
            'Dedicated deployment options, custom model routing, and SLA support',
            'Guided Brand Fact Card onboarding and compliance gate tuning',
            'Consolidated auditable point ledgers across client workspaces',
          ],
        },
      ];

  return (
    <div className="gm-mkt-page">
      <JsonLdScript id={`gm-jsonld-pricing-app-${locale}`} data={schemas.softwareApplication} />
      <JsonLdScript id={`gm-jsonld-pricing-faq-${locale}`} data={schemas.faqPage} />

      <section className="gm-mkt-section gm-mkt-section-hero">
        <div className="gm-mkt-container">
          <div className="gm-mkt-section-head">
            <span className="gm-mkt-eyebrow">
              {isZh ? '透明点数计费 · 无隐藏加价' : 'Transparent Points Metering'}
            </span>
            <h1 className="gm-mkt-hero-title">
              {isZh
                ? '按动作明码标点，核心工作流 0 点标配'
                : 'Transparent Points Pricing — Zero Hidden Markups'}
            </h1>
            <p className="gm-mkt-lead">
              {isZh
                ? `每一笔 AI 写入与引擎监测均按公开动作目录透明扣点，失败自动全额退还。新团队可直接申请 ${demoPointsText} 点 / ${pricing.demoTrial.validDays} 天试用 Demo 验证全链路效果。`
                : `Every metered AI run maps directly to our public action catalog with automatic refunds on failure. Start with a ${demoPointsText}-point / ${pricing.demoTrial.validDays}-day Trial Demo before sizing a custom points pack.`}
            </p>
          </div>

          <div className="gm-mkt-pricing-grid" data-testid="pricing-plans">
            {plans.map((plan) => (
              <article
                key={plan.id}
                className={`gm-mkt-plan-card${plan.featured ? ' is-featured' : ''}`}
              >
                <div className="gm-mkt-plan-top">
                  <span
                    className={
                      plan.featured
                        ? 'gm-mkt-badge gm-mkt-badge-phosphor'
                        : 'gm-mkt-badge gm-mkt-badge-info'
                    }
                  >
                    {plan.badge}
                  </span>
                  <h2 className="gm-mkt-plan-name">{plan.name}</h2>
                  <p className="gm-mkt-plan-metric gm-num">{plan.metric}</p>
                  <p className="gm-mkt-card-desc">{plan.subtitle}</p>
                </div>

                <ul className="gm-mkt-check-list">
                  {plan.highlights.map((item) => (
                    <li key={item}>
                      <span className="gm-mkt-check-mark" aria-hidden="true">
                        ✓
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>

                <div className="gm-mkt-plan-footer">
                  <Link href={plan.ctaHref} className={plan.ctaClass}>
                    {plan.ctaLabel}
                  </Link>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="gm-mkt-section" id="action-catalog">
        <div className="gm-mkt-container">
          <div className="gm-mkt-section-head">
            <span className="gm-mkt-eyebrow">
              {isZh ? '公开计费动作目录' : 'Public Action Metering Catalog'}
            </span>
            <h2 className="gm-mkt-h2">
              {isZh
                ? '4 项按次计费动作 + 7 项 0 点免费标配'
                : '4 Metered Actions + 7 Included 0-Point Utilities'}
            </h2>
            <p className="gm-mkt-lead">
              {isZh
                ? '以下单价实时读取自平台公开目录接口；计费流水逐笔记录于租户账本，无隐形附加费。'
                : 'Unit points synchronize directly with our live public catalog endpoint; every metered run is recorded in your auditable tenant ledger.'}
            </p>
          </div>

          <div className="gm-mkt-table-wrap" data-testid="pricing-actions-table">
            <table className="gm-mkt-table">
              <thead>
                <tr>
                  <th scope="col">{isZh ? '计费动作' : 'Metered Action'}</th>
                  <th scope="col">{isZh ? '动作代码' : 'Action Key'}</th>
                  <th scope="col">{isZh ? '能力说明' : 'Scope & Refund Policy'}</th>
                  <th scope="col" className="gm-mkt-table-num">
                    {isZh ? '单价' : 'Unit Points'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {pricing.items.map((item) => {
                  const zeroVariant = item.unitPoints === 0;
                  return (
                    <tr key={item.action}>
                      <td className="gm-mkt-table-strong">{isZh ? item.label : item.labelEn}</td>
                      <td>
                        <code className="gm-mkt-code-inline gm-mono">{item.action}</code>
                      </td>
                      <td className="gm-mkt-muted">
                        {isZh ? item.descriptionZh : item.descriptionEn}
                      </td>
                      <td className="gm-mkt-table-num gm-num">
                        {zeroVariant ? (
                          <span className="gm-mkt-badge gm-mkt-badge-cited">
                            {isZh ? '0 点（限流免费）' : '0 pts (rate-limited)'}
                          </span>
                        ) : (
                          <strong>
                            {item.unitPoints} {isZh ? item.unitZh : item.unitEn}
                          </strong>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="gm-mkt-free-section">
            <div className="gm-mkt-free-head">
              <h3 className="gm-mkt-subhead">
                {isZh
                  ? '7 项 0 点标配工作流能力（受合理防刷限流保护）'
                  : '7 Included 0-Point Workflow Utilities (Fair Rate Limits)'}
              </h3>
              <span className="gm-mkt-badge gm-mkt-badge-cited gm-num">
                {isZh ? '全部 0 点' : '0 pts included'}
              </span>
            </div>

            <div className="gm-mkt-free-grid" data-testid="pricing-free-actions">
              {pricing.freeActions.map((entry) => (
                <div key={entry.action} className="gm-mkt-free-card">
                  <div className="gm-mkt-free-card-head">
                    <span className="gm-mkt-free-title">
                      {isZh ? entry.labelZh : entry.labelEn}
                    </span>
                    <code className="gm-mkt-code-inline gm-mono">{entry.action}</code>
                  </div>
                  <p className="gm-mkt-card-desc">
                    {isZh ? entry.descriptionZh : entry.descriptionEn}
                  </p>
                </div>
              ))}

              <div className="gm-mkt-free-card is-bundled" data-testid="pricing-bundled-export">
                <div className="gm-mkt-free-card-head">
                  <span className="gm-mkt-free-title">
                    {isZh ? 'JSON-LD 与 /llms.txt 结构化导出' : 'JSON-LD & /llms.txt Export'}
                  </span>
                  <span className="gm-mkt-badge gm-mkt-badge-phosphor gm-num">
                    {isZh ? '0 点内置标配' : '0 pts bundled'}
                  </span>
                </div>
                <p className="gm-mkt-card-desc">
                  {isZh
                    ? '所有文章与站点资产均免费内置 Schema.org JSON-LD 与 /llms.txt 标准导出能力，不额外拆分计费项。'
                    : 'Every article and site deliverable includes Schema.org JSON-LD and /llms.txt export out of the box with zero add-on fees.'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="gm-mkt-section" id="calculator">
        <div className="gm-mkt-container">
          <div className="gm-mkt-section-head">
            <span className="gm-mkt-eyebrow">
              {isZh ? '交互式月度点数预算计算器' : 'Interactive Monthly Points Calculator'}
            </span>
            <h2 className="gm-mkt-h2">
              {isZh ? '按您的真实发布与监测节奏实时测算点数' : 'Model Your Monthly Points Cadence'}
            </h2>
            <p className="gm-mkt-lead">
              {isZh
                ? '拖动滑块调整月度发文量、渠道变体数、监测问句、AI 引擎、采样倍率与 T+7/14/30 自动复测，直接带入 Demo 申请。'
                : 'Adjust articles, variant channels, tracked prompts, monitored engines, sampling multiplier, and T+7/14/30 auto-retest to hand off a concrete workload to our team.'}
            </p>
          </div>

          <PointsBudgetCalculator
            locale={locale}
            unitPoints={unitPoints}
            demoTrial={pricing.demoTrial}
          />
        </div>
      </section>

      <section className="gm-mkt-section" id="pricing-faq">
        <div className="gm-mkt-container">
          <div className="gm-mkt-section-head">
            <span className="gm-mkt-eyebrow">{isZh ? '计费常见问题' : 'Billing & Quota FAQ'}</span>
            <h2 className="gm-mkt-h2">
              {isZh
                ? '关于点数额度、退费与试用流程的常见疑问'
                : 'Common Questions on Points, Refunds & Trials'}
            </h2>
          </div>

          <FaqAccordion items={faqItems} defaultOpenIndex={0} />
        </div>
      </section>

      <section className="gm-mkt-section">
        <div className="gm-mkt-container">
          <div className="gm-mkt-cta-banner">
            <div className="gm-mkt-cta-copy">
              <span className="gm-mkt-eyebrow">
                {isZh ? '零风险启动 GEO 验证' : 'Start Without Guesswork'}
              </span>
              <h2 className="gm-mkt-cta-title">
                {isZh
                  ? `申请 ${demoPointsText} 点试用 Demo，用真实品牌问句跑通首轮诊断`
                  : `Request Your ${demoPointsText}-Point Trial Demo and Benchmark Your Brand Today`}
              </h2>
            </div>
            <div className="gm-mkt-cta-actions">
              <Link href={demoPath} className="gm-mkt-btn gm-mkt-btn-primary">
                {isZh ? '预约演示并申请试用' : 'Request Trial Demo'}
              </Link>
              <Link href={guidesPath} className="gm-mkt-btn gm-mkt-btn-secondary">
                {isZh ? '阅读 GEO 实操指南' : 'Read GEO Playbooks'}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
