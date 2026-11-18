// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundPanel } from './not-found-panel';

const pushMock = vi.fn();
const backMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    back: backMock,
  }),
}));

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  pushMock.mockReset();
  backMock.mockReset();
});

describe('NotFoundPanel (#247)', () => {
  it('renders dark-themed Chinese 404 copy and login/home links when logged out', () => {
    const { container } = render(<NotFoundPanel />);

    expect(container.querySelector('main.gm-boot.gm-not-found')).toBeTruthy();
    expect(container.querySelector('.gm-not-found-card')).toBeTruthy();
    expect(screen.getByText('404')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '页面不存在' })).toBeTruthy();
    expect(screen.getByText(/抱歉，您访问的地址不存在或已被移除/)).toBeTruthy();

    const loginLink = screen.getByRole('link', { name: '前往登录' }) as HTMLAnchorElement;
    const homeLink = screen.getByRole('link', { name: '返回首页' }) as HTMLAnchorElement;
    expect(loginLink.getAttribute('href')).toBe('/login');
    expect(homeLink.getAttribute('href')).toBe('/');
  });

  it('renders workspace navigation and back button when logged in', () => {
    window.sessionStorage.setItem('geomix.accessToken', 'at_logged_in');

    render(<NotFoundPanel />);

    const workspaceLink = screen.getByRole('link', { name: '返回工作台' }) as HTMLAnchorElement;
    expect(workspaceLink.getAttribute('href')).toBe('/dashboard');

    const backBtn = screen.getByRole('button', { name: '返回上一页' });
    fireEvent.click(backBtn);
    expect(backMock.mock.calls.length + pushMock.mock.calls.length).toBe(1);
  });

  it('recognizes mirrored localStorage session and falls back to /dashboard when history length <= 1', () => {
    window.localStorage.setItem('geomix.accessToken', 'at_mirrored');
    const originalLength = window.history.length;
    Object.defineProperty(window.history, 'length', {
      configurable: true,
      value: 1,
    });

    try {
      render(<NotFoundPanel />);

      expect(screen.getByRole('link', { name: '返回工作台' }).getAttribute('href')).toBe(
        '/dashboard',
      );
      fireEvent.click(screen.getByRole('button', { name: '返回上一页' }));
      expect(pushMock).toHaveBeenCalledWith('/dashboard');
      expect(backMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window.history, 'length', {
        configurable: true,
        value: originalLength,
      });
    }
  });
});
