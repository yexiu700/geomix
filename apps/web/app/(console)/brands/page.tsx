import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { BrandsWorkspace } from '../../../components/brands/brands-workspace';

export const metadata: Metadata = {
  title: `品牌资产 · ${SITE_NAME}`,
};

export default function BrandsWorkspacePage() {
  return <BrandsWorkspace />;
}
