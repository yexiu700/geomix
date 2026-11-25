import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { AppProviders } from '../components/providers';
import { getMarketingSiteUrl } from '../lib/marketing-i18n';
import 'antd/dist/reset.css';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(getMarketingSiteUrl()),
  title: SITE_NAME,
  description:
    'GeoMix — Dual-Market GEO Platform (Global + CN) for AI citation diagnosis, compliant content studio, and T+1/7/14/30 attribution.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link
          rel="preload"
          href="/fonts/inter-latin-wght-normal.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
