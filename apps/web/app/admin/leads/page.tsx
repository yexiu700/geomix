import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { AdminPageClient } from '../../../components/admin/admin-page-client';

export const metadata: Metadata = {
  title: `试用线索 · ${SITE_NAME} 管理`,
};

export default function Page() {
  return <AdminPageClient section="leads" />;
}
