'use client';

import { useEffect, useState } from 'react';
import { TenantAdmin } from '../../../components/admin/tenant-admin';
import { httpAdmin, type AdminClient } from '../../../lib/admin-client';

export default function Page() {
  const [client, setClient] = useState<AdminClient | null>(null);
  useEffect(() => {
    setClient(httpAdmin(window.sessionStorage));
  }, []);
  if (!client) return null;
  return <TenantAdmin client={client} />;
}
