'use client';

import { SITE_NAME } from '@geomix/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { readAccessToken } from '../lib/session';

export function NotFoundPanel() {
  const router = useRouter();
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    setHasSession(Boolean(readAccessToken(window.sessionStorage)));
    document.title = `404 · 页面不存在 · ${SITE_NAME}`;
  }, []);

  return (
    <main className="gm-boot gm-not-found">
      <section className="gm-not-found-card" aria-labelledby="gm-not-found-heading">
        <span className="gm-not-found-code">404</span>
        <h1 id="gm-not-found-heading" className="gm-not-found-title">
          页面不存在
        </h1>
        <p className="gm-not-found-desc">
          抱歉，您访问的地址不存在或已被移除，请核对链接后继续操作。
        </p>
        <div className="gm-not-found-actions">
          {hasSession ? (
            <>
              <Link href="/home" className="gm-not-found-btn gm-not-found-btn-primary">
                返回工作台
              </Link>
              <button
                type="button"
                className="gm-not-found-btn gm-not-found-btn-secondary"
                onClick={() => {
                  if (window.history.length > 1) {
                    router.back();
                    return;
                  }
                  router.push('/home');
                }}
              >
                返回上一页
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="gm-not-found-btn gm-not-found-btn-primary">
                前往登录
              </Link>
              <Link href="/" className="gm-not-found-btn gm-not-found-btn-secondary">
                返回首页
              </Link>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
