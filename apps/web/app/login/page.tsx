import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginPanel } from '../../components/login-panel';

export const metadata: Metadata = {
  title: `登录 · ${SITE_NAME}`,
};

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="gm-boot">正在打开登录</main>}>
      <LoginPanel />
    </Suspense>
  );
}
