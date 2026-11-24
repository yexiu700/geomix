import type { Metadata } from 'next';
import { PricingPageView } from '../../../components/marketing/pricing-page-view';
import { fetchPublicPricing } from '../../../lib/marketing-api';
import { buildMarketingAlternates } from '../../../lib/marketing-i18n';

export function generateMetadata(): Metadata {
  return {
    title: 'Pricing & Monthly Points Calculator · GeoMix',
    description:
      'Transparent points metering for Global + China AI visibility checks and GEO content workflows, 7 included 0-point utilities, and an interactive monthly points budget calculator.',
    alternates: buildMarketingAlternates('/pricing'),
  };
}

export default async function MarketingPricingPage() {
  const pricing = await fetchPublicPricing();
  return <PricingPageView locale="en" pricing={pricing} />;
}
