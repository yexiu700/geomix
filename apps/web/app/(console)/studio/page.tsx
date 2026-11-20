import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { StudioWorkspace } from '../../../components/studio/studio-workspace';

export const metadata: Metadata = {
  title: `GEO 写作台 · ${SITE_NAME}`,
};

export default function StudioWorkspacePage() {
  return <StudioWorkspace />;
}
