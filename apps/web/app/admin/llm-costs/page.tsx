'use client';

import { useEffect, useState } from 'react';
import { LlmCostAdmin } from '../../../components/admin/llm-cost-admin';
import { httpAdmin, type AdminClient } from '../../../lib/admin-client';

export default function Page() {
  const [client, setClient] = useState<AdminClient | null>(null);
  useEffect(() => {
    setClient(httpAdmin(window.sessionStorage));
  }, []);
  if (!client) return null;
  return <LlmCostAdmin client={client} />;
}
