'use client';

import { useEffect, useState } from 'react';
import { AnnouncementAdmin } from '../../../components/admin/catalog-admin';
import { httpAdmin, type AdminClient } from '../../../lib/admin-client';

export default function Page() {
  const [client, setClient] = useState<AdminClient | null>(null);
  useEffect(() => {
    setClient(httpAdmin(window.sessionStorage));
  }, []);
  if (!client) return null;
  return <AnnouncementAdmin client={client} />;
}
