import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { NotFoundPanel } from '../components/not-found-panel';

export const metadata: Metadata = {
  title: `404 · 页面不存在 · ${SITE_NAME}`,
  description: '您访问的页面不存在',
};

export default function NotFoundPage() {
  return <NotFoundPanel />;
}
