import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { VisibilityWorkspace } from '../../../components/visibility/visibility-workspace';

export const metadata: Metadata = {
  title: `诊断 · ${SITE_NAME}`,
};

export default function VisibilityWorkspacePage() {
  return <VisibilityWorkspace />;
}
