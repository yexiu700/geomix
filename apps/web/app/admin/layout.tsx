import type { ReactNode } from 'react';
import { AdminGate } from '../../components/admin/admin-frame';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminGate>{children}</AdminGate>;
}
