'use client';

import { SITE_NAME } from '@geomix/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  getMarketingLocaleFromPath,
  switchMarketingPathLocale,
  type MarketingLocale,
} from '../../lib/marketing-i18n';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, decodeJwtClaims } from '../../lib/session';
import { MarketingBrandMark } from './marketing-brand-mark';

function isActiveSessionToken(token: string | null): boolean {
  if (!token) return false;
  const trimmed = token.trim();
  if (!trimmed) return false;
  const claims = decodeJwtClaims(trimmed);
  if (claims?.exp !== undefined && claims.exp * 1000 <= Date.now()) {
    return false;
  }
  return true;
}

function readStorageItemSafe(kind: 'sessionStorage' | 'localStorage', key: string): string | null {
  try {
    const storage = window[kind];
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

function removeSessionStorageKeySafe(key: string): void {
  try {
    window.sessionStorage?.removeItem(key);
  } catch {
    // Ignore storage SecurityError / restricted private browsing
  }
}

function hasActiveSession(): boolean {
  return (
    isActiveSessionToken(readStorageItemSafe('sessionStorage', ACCESS_TOKEN_KEY)) ||
    isActiveSessionToken(readStorageItemSafe('sessionStorage', REFRESH_TOKEN_KEY)) ||
    isActiveSessionToken(readStorageItemSafe('localStorage', ACCESS_TOKEN_KEY)) ||
    isActiveSessionToken(readStorageItemSafe('localStorage', REFRESH_TOKEN_KEY))
  );
}

interface NavLinkItem {
  label: string;
  href: string;
  matchPrefix?: string;
}

function getHeaderCopy(locale: MarketingLocale) {
  const isZh = locale === 'zh-CN';
  const navLinks: NavLinkItem[] = isZh
    ? [
        { label: '产品闭环', href: '/zh#workflow' },
        { label: '定价与点数', href: '/zh/pricing', matchPrefix: '/zh/pricing' },
        { label: 'GEO 指南', href: '/zh/guides', matchPrefix: '/zh/guides' },
      ]
    : [
        { label: 'Product', href: '/#workflow' },
        { label: 'Pricing', href: '/pricing', matchPrefix: '/pricing' },
        { label: 'Guides', href: '/guides', matchPrefix: '/guides' },
      ];

  return {
    homeHref: isZh ? '/zh' : '/',
    homeAriaLabel: isZh ? `${SITE_NAME} 品牌首页` : `${SITE_NAME} Homepage`,
    navAriaLabel: isZh ? '主导航' : 'Primary navigation',
    langAriaLabel: isZh ? '切换语言' : 'Language switcher',
    navLinks,
    signInLabel: isZh ? '登录' : 'Sign In',
    enterConsoleLabel: isZh ? '进入控制台' : 'Enter Console',
    demoLabel: isZh ? '申请试用' : 'Request Demo',
    demoHref: isZh ? '/zh/demo' : '/demo',
    menuOpenLabel: isZh ? '打开导航菜单' : 'Open navigation menu',
    menuCloseLabel: isZh ? '关闭导航菜单' : 'Close navigation menu',
  };
}

export function MarketingHeader() {
  const pathname = usePathname() || '/';
  const locale = getMarketingLocaleFromPath(pathname);
  const copy = getHeaderCopy(locale);

  const [hasSession, setHasSession] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const syncAuth = () => {
      setHasSession(hasActiveSession());
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key === null) {
        removeSessionStorageKeySafe(ACCESS_TOKEN_KEY);
        removeSessionStorageKeySafe(REFRESH_TOKEN_KEY);
      } else if (
        (event.key === ACCESS_TOKEN_KEY || event.key === REFRESH_TOKEN_KEY) &&
        event.newValue === null
      ) {
        removeSessionStorageKeySafe(event.key);
      }
      syncAuth();
    };

    syncAuth();
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  const enHref = switchMarketingPathLocale(pathname, 'en');
  const zhHref = switchMarketingPathLocale(pathname, 'zh-CN');
  const authHref = hasSession ? '/home' : '/login';
  const authLabel = hasSession ? copy.enterConsoleLabel : copy.signInLabel;

  return (
    <>
      <header className="gm-mkt-header">
        <div className="gm-mkt-container gm-mkt-header-inner">
          <Link
            href={copy.homeHref}
            className="gm-mkt-brand"
            aria-label={copy.homeAriaLabel}
            onClick={() => setMobileOpen(false)}
          >
            <MarketingBrandMark size={20} />
            <span>{SITE_NAME}</span>
          </Link>

          <nav className="gm-mkt-nav" aria-label={copy.navAriaLabel}>
            {copy.navLinks.map((item) => {
              const isActive = item.matchPrefix ? pathname.startsWith(item.matchPrefix) : false;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`gm-mkt-nav-link${isActive ? ' is-active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="gm-mkt-header-actions">
            <div className="gm-mkt-lang-switch" role="group" aria-label={copy.langAriaLabel}>
              <Link
                href={enHref}
                className={`gm-mkt-lang-item${locale === 'en' ? ' is-active' : ''}`}
                aria-current={locale === 'en' ? 'page' : undefined}
                hrefLang="en"
              >
                EN
              </Link>
              <Link
                href={zhHref}
                className={`gm-mkt-lang-item${locale === 'zh-CN' ? ' is-active' : ''}`}
                aria-current={locale === 'zh-CN' ? 'page' : undefined}
                hrefLang="zh-CN"
              >
                中文
              </Link>
            </div>

            <Link
              href={authHref}
              className="gm-mkt-btn gm-mkt-btn-ghost gm-mkt-btn-sm gm-mkt-desktop-only"
              data-testid="marketing-auth-cta"
            >
              {authLabel}
            </Link>

            <Link
              href={copy.demoHref}
              className="gm-mkt-btn gm-mkt-btn-primary gm-mkt-btn-sm gm-mkt-desktop-only"
              data-testid="marketing-header-demo-cta"
            >
              {copy.demoLabel}
            </Link>

            <button
              type="button"
              className="gm-mkt-menu-btn"
              aria-expanded={mobileOpen}
              aria-controls={mobileOpen ? 'gm-mkt-mobile-drawer' : undefined}
              aria-label={mobileOpen ? copy.menuCloseLabel : copy.menuOpenLabel}
              onClick={() => setMobileOpen((prev) => !prev)}
            >
              {mobileOpen ? (
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                  <path
                    d="M4 4L14 14M14 4L4 14"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                  <path
                    d="M2.5 4.5H15.5M2.5 9H15.5M2.5 13.5H15.5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>

      {mobileOpen ? (
        <>
          <div
            className="gm-mkt-mobile-backdrop"
            aria-hidden="true"
            onClick={() => setMobileOpen(false)}
          />
          <div
            id="gm-mkt-mobile-drawer"
            className="gm-mkt-mobile-drawer"
            role="dialog"
            aria-label={copy.navAriaLabel}
          >
            <nav className="gm-mkt-mobile-nav" aria-label={copy.navAriaLabel}>
              {copy.navLinks.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="gm-mkt-mobile-link"
                  onClick={() => setMobileOpen(false)}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="gm-mkt-mobile-actions">
              <Link
                href={authHref}
                className="gm-mkt-btn gm-mkt-btn-secondary"
                onClick={() => setMobileOpen(false)}
              >
                {authLabel}
              </Link>
              <Link
                href={copy.demoHref}
                className="gm-mkt-btn gm-mkt-btn-primary"
                onClick={() => setMobileOpen(false)}
              >
                {copy.demoLabel}
              </Link>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
