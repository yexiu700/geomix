import { FREE_RATE_LIMITED_ACTIONS } from '@geomix/shared';
import type { Metadata } from 'next';
import { PricingPageView } from '../../../../components/marketing/pricing-page-view';
import { fetchPublicPricing } from '../../../../lib/marketing-api';
import { buildMarketingAlternates } from '../../../../lib/marketing-i18n';

export function generateMetadata(): Metadata {
  return {
    title: '点数定价与月度预算计算器 · GeoMix',
    description: `公开透明的 GEO 写作与 AI 可见度点数计费目录、${FREE_RATE_LIMITED_ACTIONS.length} 项 0 点核心标配能力与交互式月度点数预算测算工具，支持申请 1,000 点 / 365 天试用 Demo。`,
    alternates: buildMarketingAlternates('/zh/pricing'),
  };
}

export default async function MarketingZhPricingPage() {
  const pricing = await fetchPublicPricing();
  return (
    <div lang="zh-CN">
      <PricingPageView locale="zh-CN" pricing={pricing} />
    </div>
  );
}
