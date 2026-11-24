import type { Metadata } from 'next';
import { GuidesIndexView } from '../../../components/marketing/guides-index-view';
import { buildMarketingAlternates } from '../../../lib/marketing-i18n';

export function generateMetadata(): Metadata {
  return {
    title: 'GEO Engineering Guides & Playbooks · GeoMix',
    description:
      'Practical engineering playbooks on AI citation vs. mention taxonomy, llms.txt & JSON-LD architecture, zero-ban community distribution, and T+7/14/30 attribution.',
    alternates: buildMarketingAlternates('/guides'),
  };
}

export default function MarketingGuidesPage() {
  return <GuidesIndexView locale="en" />;
}
