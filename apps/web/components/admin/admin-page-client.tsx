'use client';

import { useEffect, useState } from 'react';
import { httpAdmin, type AdminClient } from '../../lib/admin-client';
import { AnnouncementAdmin, PricingAdmin, TemplateAdmin } from './catalog-admin';
import { LlmCostAdmin } from './llm-cost-admin';
import { TenantAdmin } from './tenant-admin';

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
