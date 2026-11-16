import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { AppProviders } from '../components/providers';
import 'antd/dist/reset.css';
import './globals.css';

export const metadata: Metadata = {
  title: SITE_NAME,
  description: 'GeoMix 登录与后台',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
