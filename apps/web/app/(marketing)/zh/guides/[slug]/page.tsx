import { MARKETING_GUIDE_SLUGS, getMarketingGuideBySlug } from '@geomix/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GuideDetailView } from '../../../../../components/marketing/guide-detail-view';
import { buildMarketingAlternates } from '../../../../../lib/marketing-i18n';

type ZhGuideDetailPageProps = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return MARKETING_GUIDE_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: ZhGuideDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const guide = getMarketingGuideBySlug(slug);
  if (!guide) {
    return {
      title: '未找到该指南 · GeoMix',
      robots: { index: false, follow: false },
    };
  }

  return {
    title: `${guide.zh.title} · GeoMix`,
    description: guide.zh.description,
    alternates: buildMarketingAlternates(`/zh/guides/${guide.slug}`),
  };
}

export default async function MarketingZhGuideDetailPage({ params }: ZhGuideDetailPageProps) {
  const { slug } = await params;
  const guide = getMarketingGuideBySlug(slug);
  if (!guide) {
    notFound();
  }

  return (
    <div lang="zh-CN">
      <GuideDetailView guide={guide} locale="zh-CN" />
    </div>
  );
}
