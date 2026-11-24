// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '../../lib/session';
import { MarketingHeader } from './marketing-header';

let currentPathname = '/';

vi.mock('next/navigation', () => ({
  usePathname: () => currentPathname,
}));

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  currentPathname = '/';
  document.documentElement.lang = 'en';
});

describe('MarketingHeader', () => {
  it('renders anonymous EN navigation, syncs document lang, and preserves exact subpath across EN/ZH', () => {
    currentPathname = '/guides/geo-citation-vs-mention';
    render(<MarketingHeader />);

    expect(document.documentElement.lang).toBe('en');

    const enLink = screen.getByRole('link', { name: 'EN' });
    const zhLink = screen.getByRole('link', { name: '中文' });
    expect(enLink.getAttribute('href')).toBe('/guides/geo-citation-vs-mention');
    expect(enLink.getAttribute('aria-current')).toBe('page');
    expect(zhLink.getAttribute('href')).toBe('/zh/guides/geo-citation-vs-mention');
    expect(zhLink.getAttribute('aria-current')).toBeNull();

    const authCta = screen.getByTestId('marketing-auth-cta');
    expect(authCta.textContent).toBe('Sign In');
    expect(authCta.getAttribute('href')).toBe('/login');

    const demoCta = screen.getByTestId('marketing-header-demo-cta');
    expect(demoCta.textContent).toBe('Request Demo');
    expect(demoCta.getAttribute('href')).toBe('/demo');
  });

  it('switches to Enter Console / 进入控制台 when a session token exists in sessionStorage or localStorage', async () => {
    window.localStorage.setItem(ACCESS_TOKEN_KEY, 'mock.jwt.token');
    currentPathname = '/zh/pricing';

    render(<MarketingHeader />);

    expect(document.documentElement.lang).toBe('zh-CN');

    const enLink = screen.getByRole('link', { name: 'EN' });
    const zhLink = screen.getByRole('link', { name: '中文' });
    expect(enLink.getAttribute('href')).toBe('/pricing');
    expect(zhLink.getAttribute('href')).toBe('/zh/pricing');
    expect(zhLink.getAttribute('aria-current')).toBe('page');

    await waitFor(() => {
      const authCta = screen.getByTestId('marketing-auth-cta');
      expect(authCta.textContent).toBe('进入控制台');
      expect(authCta.getAttribute('href')).toBe('/home');
    });
  });

  it('reacts to storage events when refresh token is added or cleared', async () => {
    currentPathname = '/';
    render(<MarketingHeader />);

    expect(screen.getByTestId('marketing-auth-cta').textContent).toBe('Sign In');

    window.sessionStorage.setItem(REFRESH_TOKEN_KEY, 'refresh.token.value');
    fireEvent(window, new Event('storage'));

    await waitFor(() => {
      expect(screen.getByTestId('marketing-auth-cta').textContent).toBe('Enter Console');
      expect(screen.getByTestId('marketing-auth-cta').getAttribute('href')).toBe('/home');
    });

    window.sessionStorage.clear();
    window.localStorage.clear();
    fireEvent(window, new Event('storage'));

    await waitFor(() => {
      expect(screen.getByTestId('marketing-auth-cta').textContent).toBe('Sign In');
      expect(screen.getByTestId('marketing-auth-cta').getAttribute('href')).toBe('/login');
    });
  });

  it('opens and closes the accessible mobile drawer via button and Escape key with valid aria-controls', () => {
    currentPathname = '/';
    const { container } = render(<MarketingHeader />);

    const assertAllAriaControlsExist = () => {
      for (const el of Array.from(container.querySelectorAll('[aria-controls]'))) {
        const targetId = el.getAttribute('aria-controls');
        expect(targetId).toBeTruthy();
        expect(document.getElementById(targetId!)).not.toBeNull();
      }
    };

    const menuBtn = screen.getByRole('button', { name: 'Open navigation menu' });
    expect(menuBtn.getAttribute('aria-expanded')).toBe('false');
    expect(menuBtn.getAttribute('aria-controls')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    assertAllAriaControlsExist();

    fireEvent.click(menuBtn);
    expect(menuBtn.getAttribute('aria-expanded')).toBe('true');
    expect(menuBtn.getAttribute('aria-controls')).toBe('gm-mkt-mobile-drawer');
    expect(screen.getByRole('dialog').id).toBe('gm-mkt-mobile-drawer');
    assertAllAriaControlsExist();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(menuBtn.getAttribute('aria-expanded')).toBe('false');
    expect(menuBtn.getAttribute('aria-controls')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    assertAllAriaControlsExist();
  });

  it('ignores whitespace-only and expired JWT tokens, and accepts valid future-exp JWTs', async () => {
    const makeJwt = (expOffsetSec: number) => {
      const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSec }));
      return `${header}.${payload}.sig`;
    };

    // 1. Whitespace-only token -> stays Sign In
    window.sessionStorage.setItem(ACCESS_TOKEN_KEY, '   \t\n  ');
    const view1 = render(<MarketingHeader />);
    expect(screen.getByTestId('marketing-auth-cta').textContent).toBe('Sign In');
    expect(screen.getByTestId('marketing-auth-cta').getAttribute('href')).toBe('/login');
    view1.unmount();

    // 2. Expired access JWT (no refresh) -> stays Sign In
    window.sessionStorage.clear();
    window.sessionStorage.setItem(ACCESS_TOKEN_KEY, makeJwt(-3600));
    const view2 = render(<MarketingHeader />);
    expect(screen.getByTestId('marketing-auth-cta').textContent).toBe('Sign In');
    expect(screen.getByTestId('marketing-auth-cta').getAttribute('href')).toBe('/login');
    view2.unmount();

    // 3. Both access and refresh JWTs expired -> stays Sign In
    window.localStorage.setItem(ACCESS_TOKEN_KEY, makeJwt(-3600));
    window.localStorage.setItem(REFRESH_TOKEN_KEY, makeJwt(-1800));
    window.sessionStorage.setItem(REFRESH_TOKEN_KEY, makeJwt(-1800));
    const view3 = render(<MarketingHeader />);
    expect(screen.getByTestId('marketing-auth-cta').textContent).toBe('Sign In');
    expect(screen.getByTestId('marketing-auth-cta').getAttribute('href')).toBe('/login');
    view3.unmount();

    // 4. Valid future-exp JWT in localStorage -> switches to Enter Console without mutating sessionStorage
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.localStorage.setItem(ACCESS_TOKEN_KEY, makeJwt(3600));
    render(<MarketingHeader />);

    await waitFor(() => {
      expect(screen.getByTestId('marketing-auth-cta').textContent).toBe('Enter Console');
      expect(screen.getByTestId('marketing-auth-cta').getAttribute('href')).toBe('/home');
    });
    expect(window.sessionStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
  });

  it('reverts to Sign In on real cross-tab logout StorageEvent even when sessionStorage was previously populated', async () => {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
    const validJwt = `${header}.${payload}.sig`;

    // Simulate Tab A having previously visited /home (both localStorage & sessionStorage populated)
    window.localStorage.setItem(ACCESS_TOKEN_KEY, validJwt);
    window.localStorage.setItem(REFRESH_TOKEN_KEY, validJwt);
    window.sessionStorage.setItem(ACCESS_TOKEN_KEY, validJwt);
    window.sessionStorage.setItem(REFRESH_TOKEN_KEY, validJwt);

    render(<MarketingHeader />);
    await waitFor(() => {
      expect(screen.getByTestId('marketing-auth-cta').textContent).toBe('Enter Console');
    });

    // Simulate Tab B calling clearSession() (only localStorage is shared across tabs)
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: ACCESS_TOKEN_KEY,
        oldValue: validJwt,
        newValue: null,
      }),
    );
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: REFRESH_TOKEN_KEY,
        oldValue: validJwt,
        newValue: null,
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('marketing-auth-cta').textContent).toBe('Sign In');
      expect(screen.getByTestId('marketing-auth-cta').getAttribute('href')).toBe('/login');
    });
    expect(window.sessionStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
  });
});
