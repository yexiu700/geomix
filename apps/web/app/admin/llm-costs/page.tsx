import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { AdminPageClient } from '../../../components/admin/admin-page-client';

export const metadata: Metadata = {
  title: `LLM成本日报 · ${SITE_NAME} 管理`,
};

export default function Page() {
  return <AdminPageClient section="llm-costs" />;
}
