import { Suspense } from 'react';
import { LoginPanel } from '../../components/login-panel';

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="gm-boot">正在打开登录</main>}>
      <LoginPanel />
    </Suspense>
  );
}
