import { Suspense } from 'react';
import { ConsoleShell } from '../../components/shell/console-shell';

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<main className="gm-boot">正在确认登录</main>}>
      <ConsoleShell>{children}</ConsoleShell>
    </Suspense>
  );
}
