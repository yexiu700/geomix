import { Suspense } from 'react';
import { ConsoleBootSkeleton } from '../../components/shell/console-boot-skeleton';
import { ConsoleShell } from '../../components/shell/console-shell';

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<ConsoleBootSkeleton />}>
      <ConsoleShell>{children}</ConsoleShell>
    </Suspense>
  );
}
