import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { PrSharePacketView } from '../../../../components/distribution/pr-share-packet-view';

export const metadata: Metadata = {
  title: `PR / KOL Media Brief · ${SITE_NAME}`,
  description: 'External read-only brand fact sheet, topic brief, and published URL submission.',
  robots: {
    index: false,
    follow: false,
  },
};

export default async function PublicPrSharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <PrSharePacketView token={token} />;
}
