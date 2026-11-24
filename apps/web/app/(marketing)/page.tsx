import type { Metadata } from 'next';
import { MarketingHomePage } from '../../components/marketing/marketing-home-page';
import { buildMarketingAlternates } from '../../lib/marketing-i18n';

export const metadata: Metadata = {
  title: 'GeoMix — Dual-Market GEO Platform (Global + CN)',
  description:
    'Make your brand the source AI cites — not just mentions. Multi-engine citation diagnosis, dual-track preflight compliance gating, 1→N distribution, and T+1/7/14/30 attribution.',
  alternates: buildMarketingAlternates('/'),
};

export default function MarketingRootPage() {
  return <MarketingHomePage locale="en" />;
}
