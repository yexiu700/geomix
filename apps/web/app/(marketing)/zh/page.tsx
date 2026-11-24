import type { Metadata } from 'next';
import { MarketingHomePage } from '../../../components/marketing/marketing-home-page';
import { buildMarketingAlternates } from '../../../lib/marketing-i18n';

export function generateMetadata(): Metadata {
  return {
    title: 'GeoMix — 双市场 GEO 内容创作与 AI 可见度平台',
    description:
      '让品牌成为 AI 回答的首选信源，而不只是被顺带提及。覆盖出海与国内双市场 AI 引擎的引用诊断、合规门禁、1→N 分发与 T+1/7/14/30 归因复测平台。',
    alternates: buildMarketingAlternates('/zh'),
  };
}

export default function MarketingZhHomePage() {
  return (
    <div lang="zh-CN">
      <MarketingHomePage locale="zh-CN" />
    </div>
  );
}
