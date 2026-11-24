import { MARKETING_GUIDE_SLUGS, getMarketingGuideBySlug } from '@geomix/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GuideDetailView } from '../../../../components/marketing/guide-detail-view';
import { buildMarketingAlternates } from '../../../../lib/marketing-i18n';

type GuideDetailPageProps = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return MARKETING_GUIDE_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: GuideDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const guide = getMarketingGuideBySlug(slug);
  if (!guide) {
    return {
      title: 'Guide Not Found · GeoMix',
      robots: { index: false, follow: false },
    };
  }

  return {
    title: `${guide.en.title} · GeoMix`,
    description: guide.en.description,
    alternates: buildMarketingAlternates(`/guides/${guide.slug}`),
  };
}

export default async function MarketingGuideDetailPage({ params }: GuideDetailPageProps) {
  const { slug } = await params;
  const guide = getMarketingGuideBySlug(slug);
  if (!guide) {
    notFound();
  }

  return <GuideDetailView guide={guide} locale="en" />;
}
