'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { httpAdmin, type AdminClient } from '../../lib/admin-client';
import { SignalSkeleton } from '../geo/primitives';

function AdminLoading() {
  return (
    <div style={{ padding: '16px 0' }} role="status" aria-label="正在加载管理模块">
      <SignalSkeleton variant="block" height={240} />
    </div>
  );
}

const TenantAdmin = dynamic(() => import('./tenant-admin').then((m) => m.TenantAdmin), {
  loading: AdminLoading,
});
const PricingAdmin = dynamic(() => import('./catalog-admin').then((m) => m.PricingAdmin), {
  loading: AdminLoading,
});
const AnnouncementAdmin = dynamic(
  () => import('./catalog-admin').then((m) => m.AnnouncementAdmin),
  { loading: AdminLoading },
);
const TemplateAdmin = dynamic(() => import('./catalog-admin').then((m) => m.TemplateAdmin), {
  loading: AdminLoading,
});
const LlmCostAdmin = dynamic(() => import('./llm-cost-admin').then((m) => m.LlmCostAdmin), {
  loading: AdminLoading,
});

export type AdminSection = 'tenants' | 'pricing' | 'announcements' | 'templates' | 'llm-costs';

export function AdminPageClient({ section }: { section: AdminSection }) {
  const [client, setClient] = useState<AdminClient | null>(null);

  useEffect(() => {
    setClient(httpAdmin(window.sessionStorage));
  }, []);

  if (!client) return null;
  if (section === 'tenants') return <TenantAdmin client={client} />;
  if (section === 'pricing') return <PricingAdmin client={client} />;
  if (section === 'announcements') return <AnnouncementAdmin client={client} />;
  if (section === 'templates') return <TemplateAdmin client={client} />;
  return <LlmCostAdmin client={client} />;
}
