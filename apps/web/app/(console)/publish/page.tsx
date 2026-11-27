import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { PublishWorkspace } from '../../../components/publish/publish-workspace';

export const metadata: Metadata = {
  title: `发布 · ${SITE_NAME}`,
};

export default function PublishWorkspacePage() {
  return <PublishWorkspace />;
}
