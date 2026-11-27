import { SITE_NAME } from '@geomix/shared';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AccountScreen } from '../../../components/account/account-screen';
import { SignalSkeleton } from '../../../components/geo/primitives';

export const metadata: Metadata = {
  title: `账户 · ${SITE_NAME}`,
};

export default function AccountWorkspacePage() {
  return (
    <Suspense fallback={<SignalSkeleton variant="block" height={320} />}>
      <AccountScreen />
    </Suspense>
  );
}
