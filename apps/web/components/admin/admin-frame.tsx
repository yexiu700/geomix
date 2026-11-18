'use client';

import { SITE_NAME } from '@geomix/shared';
import { Button } from 'antd';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { loadAccount, logoutSession, type AccountProfile } from '../../lib/api';
import { clearSession } from '../../lib/session';

const LINKS = [
  { href: '/admin/tenants', title: '租户' },
  { href: '/admin/pricing', title: '价格' },
  { href: '/admin/announcements', title: '公告' },
  { href: '/admin/templates', title: '系统模板' },
  { href: '/admin/llm-costs', title: 'LLM成本日报' },
];

export function AdminGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [account, setAccount] = useState<AccountProfile | null>(null);
  const [phase, setPhase] = useState<'boot' | 'ok' | 'deny' | 'offline'>('boot');

  useEffect(() => {
    let live = true;
    void loadAccount(window.sessionStorage).then((result) => {
      if (!live) return;
      if (result.status === 'offline') {
        setPhase('offline');
        return;
      }
      if (result.status !== 'ok' || result.account.role !== 'ADMIN') {
        if (result.status !== 'ok') clearSession(window.sessionStorage);
        setPhase('deny');
        return;
      }
      setAccount(result.account);
      setPhase('ok');
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const matched = LINKS.find((link) => link.href === pathname);
    document.title = matched ? `${matched.title} · ${SITE_NAME} 管理` : `${SITE_NAME} 管理`;
  }, [pathname]);

  if (phase === 'boot') {
    return (
      <main className="gm-boot" style={{ color: 'var(--gm-fg-2)' }}>
        正在确认登录
      </main>
    );
  }
  if (phase === 'offline') {
    return (
      <main className="gm-boot" style={{ color: 'var(--gm-danger)' }}>
        无法连接接口
      </main>
    );
  }
  if (phase === 'deny' || !account) {
    return (
      <main className="gm-boot" style={{ color: 'var(--gm-fg-2)' }}>
        <p style={{ color: 'var(--gm-fg-1)' }}>没有这个页面</p>
        <Button type="primary" onClick={() => router.push('/dashboard')}>
          回首页
        </Button>
      </main>
    );
  }

  return (
    <div className="gm-admin" style={{ color: 'var(--gm-fg-1)' }}>
      <header className="gm-admin-bar">
        <strong style={{ color: 'var(--gm-fg-1)' }}>{SITE_NAME} 管理</strong>
        <nav aria-label="管理菜单">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={pathname === link.href ? 'page' : undefined}
              style={{
                color: pathname === link.href ? 'var(--gm-phosphor)' : 'var(--gm-fg-2)',
              }}
            >
              {link.title}
            </Link>
          ))}
        </nav>
        <Link href="/dashboard" style={{ color: 'var(--gm-info)' }}>
          返回后台
        </Link>
        <Button
          onClick={() => {
            void logoutSession(window.sessionStorage).then(() => router.replace('/login'));
          }}
        >
          退出
        </Button>
      </header>
      <main className="gm-admin-main">{children}</main>
    </div>
  );
}
