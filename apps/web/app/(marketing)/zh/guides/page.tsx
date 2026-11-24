import type { Metadata } from 'next';
import { GuidesIndexView } from '../../../../components/marketing/guides-index-view';
import { buildMarketingAlternates } from '../../../../lib/marketing-i18n';

export function generateMetadata(): Metadata {
  return {
    title: 'GEO 实操指南与技术架构专栏 · GeoMix',
    description:
      '双市场 GEO 工程实操专栏：深入拆解 AI 引用与提及分层、llms.txt 与 JSON-LD 落地规范、零封号合规社区分发与 T+7/14/30 归因复测体系。',
    alternates: buildMarketingAlternates('/zh/guides'),
  };
}

export default function MarketingZhGuidesPage() {
  return (
    <div lang="zh-CN">
      <GuidesIndexView locale="zh-CN" />
    </div>
  );
}
