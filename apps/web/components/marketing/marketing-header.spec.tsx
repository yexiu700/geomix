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

  it('opens and closes the accessible mobile drawer via button and Escape key', () => {
    currentPathname = '/';
    render(<MarketingHeader />);

    const menuBtn = screen.getByRole('button', { name: 'Open navigation menu' });
    expect(menuBtn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(menuBtn);
    expect(menuBtn.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(menuBtn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
