import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { HomeWorkspace } from '../../../components/home/home-workspace';

export const metadata: Metadata = {
  title: `首页 · ${SITE_NAME}`,
};

export default function HomeWorkspacePage() {
  return <HomeWorkspace />;
}
