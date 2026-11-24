import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { PublicRoiReportView } from '../../../../components/reports/public-roi-report-view';

export const metadata: Metadata = {
  title: `GEO ROI Report · ${SITE_NAME}`,
  description: 'External read-only GEO ROI executive report.',
  robots: {
    index: false,
    follow: false,
  },
};

export default async function PublicRoiReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <PublicRoiReportView token={token} />;
}
