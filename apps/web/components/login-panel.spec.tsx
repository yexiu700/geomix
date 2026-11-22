// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clearCachedAccount, readCachedAccount } from '../lib/account-cache';
import { CAPTCHA_LOAD_TIMEOUT_MS, LoginPanel } from './login-panel';

const replaceMock = vi.fn();
const prefetchMock = vi.fn();
const postJsonMock = vi.fn();
const loadAccountMock = vi.fn();

const routerMock = { replace: replaceMock, prefetch: prefetchMock };
let searchParamsMock = new URLSearchParams();

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => searchParamsMock,
}));

vi.mock('../lib/api', () => ({
  postJson: (...args: unknown[]) => postJsonMock(...args),
  loadAccount: (...args: unknown[]) => loadAccountMock(...args),
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  searchParamsMock = new URLSearchParams();
  window.sessionStorage.clear();
  window.localStorage.clear();
  clearCachedAccount();
  replaceMock.mockReset();
  prefetchMock.mockReset();
  postJsonMock.mockReset();
  loadAccountMock.mockReset();
});

describe('LoginPanel captcha readiness (#64)', () => {
  it('disables submit and shows loading status until captchaId resolves, then submits with captchaId', async () => {
    let resolveCaptcha!: (val: {
      code: number;
      msg: string;
      data: { captchaId: string; image: string };
    }) => void;
    postJsonMock.mockImplementation((path: string) => {
      if (path === '/auth/captcha') {
        return new Promise((resolve) => {
          resolveCaptcha = resolve;
        });
      }
      if (path === '/auth/login') {
        return Promise.resolve({
          code: 0,
          msg: 'ok',
          data: { accessToken: 'at_1', refreshToken: 'rt_1' },
        });
      }
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    render(<LoginPanel />);

    expect(screen.getByRole('status').textContent).toContain('正在加载验证码');
    const submitBtn = screen.getByRole('button', { name: /登\s*录/ });
    expect((submitBtn as HTMLButtonElement).disabled).toBe(true);

    // Clicking while disabled does not send an empty captchaId to /auth/login
    fireEvent.click(submitBtn);
    expect(postJsonMock).toHaveBeenCalledTimes(1);
    expect(postJsonMock.mock.calls[0]?.slice(0, 2)).toEqual(['/auth/captcha', {}]);

    // Resolve captcha
    resolveCaptcha({
      code: 0,
      msg: 'ok',
      data: {
        captchaId: 'cap_ready_123',
        image: TINY_PNG,
      },
    });

    await waitFor(
      () => {
        expect(screen.queryByRole('status')).toBeNull();
      },
      { timeout: 5000 },
    );
    expect((screen.getByRole('button', { name: /登\s*录/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByRole('img', { name: '验证码' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'demo' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'geomix-demo-dev' } });
    fireEvent.change(screen.getByLabelText('验证码', { selector: 'input' }), {
      target: { value: '0000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /登\s*录/ }));

    await waitFor(
      () => {
        expect(postJsonMock).toHaveBeenCalledWith('/auth/login', {
          username: 'demo',
          password: 'geomix-demo-dev',
          captchaCode: '0000',
          captchaId: 'cap_ready_123',
        });
      },
      { timeout: 5000 },
    );
    expect(replaceMock).toHaveBeenCalledWith('/home');
  });

  it('redirects back to /admin/tenants when ?next=%2Fadmin%2Ftenants is present (#194)', async () => {
    searchParamsMock = new URLSearchParams({ next: '/admin/tenants' });
    window.localStorage.setItem('geomix.accessToken', 'at_shared');
    window.localStorage.setItem('geomix.refreshToken', 'rt_shared');
    loadAccountMock.mockResolvedValue({
      status: 'ok',
      account: {
        id: 'u-admin',
        username: 'admin',
        nickname: '管理员',
        role: 'ADMIN',
        tenant: {
          id: 't-platform',
          name: 'GeoMix 平台',
          expiresAt: '2099-12-31T00:00:00.000Z',
          isActive: true,
          readOnly: false,
        },
      },
    });

    render(<LoginPanel />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/admin/tenants');
    });
  });
});

describe('LoginPanel captcha abort, timeout and retry recovery (#126)', () => {
  it('auto-retries once when initial captcha request is aborted during navigation and succeeds', async () => {
    let calls = 0;
    postJsonMock.mockImplementation((path: string) => {
      if (path === '/auth/captcha') {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
        }
        return Promise.resolve({
          code: 0,
          msg: 'ok',
          data: { captchaId: 'cap_retry_ok', image: TINY_PNG },
        });
      }
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    const { container } = render(<LoginPanel />);

    await waitFor(
      () => {
        expect(container.querySelector('[role="img"][aria-label="验证码"]')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    expect(calls).toBe(2);
    expect((screen.getByRole('button', { name: /登\s*录/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByRole('button', { name: '换一张' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('shows clickable retry prompt and unlocks 换一张 when captcha loading fails persistently', async () => {
    let calls = 0;
    postJsonMock.mockImplementation((path: string) => {
      if (path === '/auth/captcha') {
        calls += 1;
        if (calls <= 2) {
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }
        return Promise.resolve({
          code: 0,
          msg: 'ok',
          data: { captchaId: 'cap_manual_retry', image: TINY_PNG },
        });
      }
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    const { container } = render(<LoginPanel />);

    await waitFor(
      () => {
        expect(screen.queryByText('验证码加载失败，点击重试')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    const retryBtn = screen.getByRole('button', { name: '验证码加载失败，点击重试' });
    expect(screen.queryByText(/正在加载验证码/)).toBeNull();
    expect((screen.getByRole('button', { name: '换一张' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByRole('button', { name: /登\s*录/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(retryBtn);

    await waitFor(
      () => {
        expect(container.querySelector('[role="img"][aria-label="验证码"]')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    expect((screen.getByRole('button', { name: /登\s*录/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('falls back on timeout, unlocks 换一张, and recovers when 换一张 is clicked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let calls = 0;
      let capturedSignal: AbortSignal | undefined;

      postJsonMock.mockImplementation(
        (path: string, _body: unknown, _token?: string, options?: { signal?: AbortSignal }) => {
          if (path === '/auth/captcha') {
            calls += 1;
            if (calls === 1) {
              capturedSignal = options?.signal;
              return new Promise(() => {});
            }
            return Promise.resolve({
              code: 0,
              msg: 'ok',
              data: { captchaId: 'cap_after_timeout', image: TINY_PNG },
            });
          }
          return Promise.reject(new Error(`Unexpected path: ${path}`));
        },
      );

      render(<LoginPanel />);
      expect(screen.getByRole('status').textContent).toContain('正在加载验证码');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CAPTCHA_LOAD_TIMEOUT_MS + 50);
      });

      expect(capturedSignal?.aborted).toBe(true);
      expect(screen.getByRole('button', { name: '验证码加载失败，点击重试' })).toBeTruthy();
      const refreshBtn = screen.getByRole('button', { name: '换一张' }) as HTMLButtonElement;
      expect(refreshBtn.disabled).toBe(false);

      await act(async () => {
        fireEvent.click(refreshBtn);
        await Promise.resolve();
      });

      expect(screen.getByRole('img', { name: '验证码' })).toBeTruthy();
      expect((screen.getByRole('button', { name: /登\s*录/ }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles 换一张 failure without unhandled rejection and keeps 换一张 clickable', async () => {
    let calls = 0;
    postJsonMock.mockImplementation((path: string) => {
      if (path === '/auth/captcha') {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            code: 0,
            msg: 'ok',
            data: { captchaId: 'cap_1', image: TINY_PNG },
          });
        }
        if (calls === 2) {
          return Promise.reject(new Error('network down'));
        }
        return Promise.resolve({
          code: 0,
          msg: 'ok',
          data: { captchaId: 'cap_3', image: TINY_PNG },
        });
      }
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    const { container } = render(<LoginPanel />);
    await waitFor(
      () => {
        expect(container.querySelector('[role="img"][aria-label="验证码"]')).toBeTruthy();
      },
      { timeout: 5000 },
    );

    fireEvent.click(screen.getByRole('button', { name: '换一张' }));

    await waitFor(
      () => {
        expect(screen.queryByText('验证码加载失败，点击重试')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    const retryBtn = screen.getByRole('button', { name: '验证码加载失败，点击重试' });
    expect((screen.getByRole('button', { name: '换一张' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByRole('button', { name: /登\s*录/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(retryBtn);
    await waitFor(
      () => {
        expect(container.querySelector('[role="img"][aria-label="验证码"]')).toBeTruthy();
      },
      { timeout: 5000 },
    );
  });

  it('deduplicates initial captcha fetch in React StrictMode without aborting', async () => {
    let calls = 0;
    postJsonMock.mockImplementation((path: string) => {
      if (path === '/auth/captcha') {
        calls += 1;
        return Promise.resolve({
          code: 0,
          msg: 'ok',
          data: { captchaId: 'cap_strict', image: TINY_PNG },
        });
      }
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    const { container } = render(
      <StrictMode>
        <LoginPanel />
      </StrictMode>,
    );

    await waitFor(
      () => {
        expect(container.querySelector('[role="img"][aria-label="验证码"]')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    expect(calls).toBe(1);
    expect((screen.getByRole('button', { name: /登\s*录/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe('LoginPanel UX polish (#128 #129 #130)', () => {
  it('places 换一张 in the captcha row with a clear refresh hint and keeps 登录 isolated in actions (#128)', async () => {
    let calls = 0;
    postJsonMock.mockImplementation((path: string) => {
      if (path === '/auth/captcha') {
        calls += 1;
        return Promise.resolve({
          code: 0,
          msg: 'ok',
          data: { captchaId: `cap_${calls}`, image: TINY_PNG },
        });
      }
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    const { container } = render(<LoginPanel />);

    const captchaImg = await waitFor(() => screen.getByRole('img', { name: '验证码' }));
    expect(captchaImg.getAttribute('title')).toBe('点击图片更换验证码');
    expect(screen.getByText('点击图片更换验证码')).toBeTruthy();

    const captchaRow = container.querySelector('.gm-login-captcha-row');
    const actionsRow = container.querySelector('.gm-login-actions');
    expect(captchaRow).toBeTruthy();
    expect(actionsRow).toBeTruthy();

    const refreshBtn = screen.getByRole('button', { name: '换一张' });
    const submitBtn = screen.getByRole('button', { name: /登\s*录/ });
    expect(captchaRow?.contains(captchaImg)).toBe(true);
    expect(captchaRow?.contains(refreshBtn)).toBe(true);
    expect(actionsRow?.contains(submitBtn)).toBe(true);
    expect(actionsRow?.contains(refreshBtn)).toBe(false);

    fireEvent.click(captchaImg);
    await waitFor(() => {
      expect(calls).toBe(2);
    });
  });

  it('provides helpful placeholders on all required inputs and dark-mode captcha framing (#129)', async () => {
    postJsonMock.mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: { captchaId: 'cap_placeholder', image: TINY_PNG },
    });

    render(<LoginPanel />);

    const usernameInput = screen.getByLabelText('用户名') as HTMLInputElement;
    const passwordInput = screen.getByLabelText('密码') as HTMLInputElement;
    const captchaInput = screen.getByLabelText('验证码', { selector: 'input' }) as HTMLInputElement;

    expect(usernameInput.placeholder).toBe('请输入用户名');
    expect(passwordInput.placeholder).toBe('请输入密码');
    expect(captchaInput.placeholder).toBe('请输入图形验证码');

    const captchaImg = await waitFor(() => screen.getByRole('img', { name: '验证码' }));
    expect(captchaImg.classList.contains('gm-login-captcha-img')).toBe(true);
  });

  it('toggles password visibility without moving focus into the password input (#130)', async () => {
    postJsonMock.mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: { captchaId: 'cap_focus', image: TINY_PNG },
    });

    const { container } = render(<LoginPanel />);
    await waitFor(() => {
      expect(screen.getByRole('img', { name: '验证码' })).toBeTruthy();
    });

    const usernameInput = screen.getByLabelText('用户名') as HTMLInputElement;
    const passwordInput = screen.getByLabelText('密码') as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: 's3cret-pass' } });

    // Case 1: Nothing / body focused
    (document.activeElement as HTMLElement | null)?.blur?.();
    const eyeHiddenIcon = container.querySelector('.ant-input-password-icon') as HTMLElement;
    expect(eyeHiddenIcon).toBeTruthy();
    expect(passwordInput.type).toBe('password');

    fireEvent.click(eyeHiddenIcon);
    expect(passwordInput.type).toBe('text');
    expect(container.querySelector('[aria-label="eye"]')).toBeTruthy();
    expect(document.activeElement).not.toBe(passwordInput);

    // Case 2: Another input is focused; toggling back keeps focus where it was
    usernameInput.focus();
    expect(document.activeElement).toBe(usernameInput);

    const eyeVisibleIcon = container.querySelector('.ant-input-password-icon') as HTMLElement;
    fireEvent.click(eyeVisibleIcon);
    expect(passwordInput.type).toBe('password');
    expect(container.querySelector('[aria-label="eye-invisible"]')).toBeTruthy();
    expect(document.activeElement).toBe(usernameInput);
  });
});

describe('LoginPanel accessibility & contrast (#248)', () => {
  it('renders password visibility toggle as a keyboard-reachable semantic button with aria-pressed', async () => {
    postJsonMock.mockResolvedValue({
      code: 0,
      msg: 'ok',
      data: { captchaId: 'cap_a11y_pw', image: TINY_PNG },
    });

    render(<LoginPanel />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '点击图片更换验证码' })).toBeTruthy();
    });

    const passwordInput = screen.getByLabelText('密码') as HTMLInputElement;
    const toggleBtn = screen.getByRole('button', { name: '显示密码' }) as HTMLButtonElement;
    expect(toggleBtn.tagName).toBe('BUTTON');
    expect(toggleBtn.type).toBe('button');
    expect(toggleBtn.tabIndex).toBeGreaterThanOrEqual(0);
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggleBtn);
    expect(passwordInput.type).toBe('text');

    const hideBtn = screen.getByRole('button', { name: '隐藏密码' }) as HTMLButtonElement;
    expect(hideBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('renders captcha refresh container as a semantic button (not div[role=img]) and shows admin guidance', async () => {
    let calls = 0;
    postJsonMock.mockImplementation((path: string) => {
      if (path === '/auth/captcha') {
        calls += 1;
        return Promise.resolve({
          code: 0,
          msg: 'ok',
          data: { captchaId: `cap_${calls}`, image: TINY_PNG },
        });
      }
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    const { container } = render(<LoginPanel />);

    const captchaBtn = (await waitFor(() =>
      screen.getByRole('button', { name: '点击图片更换验证码' }),
    )) as HTMLButtonElement;
    expect(captchaBtn.tagName).toBe('BUTTON');
    expect(captchaBtn.type).toBe('button');
    expect(captchaBtn.classList.contains('gm-login-captcha-frame')).toBe(true);
    expect(container.querySelector('div[role="img"]')).toBeNull();

    fireEvent.click(captchaBtn);
    await waitFor(() => {
      expect(calls).toBe(2);
    });

    expect(container.querySelector('.gm-login-helper')?.textContent).toContain('账号由管理员开通');
    expect(container.querySelector('.gm-login-support-note')?.textContent).toContain('管理员');
    expect(container.querySelector('.gm-login-support-note')?.textContent).toContain('忘记密码');
  });
});

describe('LoginPanel redirect performance optimizations (P0)', () => {
  it('prefetches target route once login form is ready and seeds account cache on login', async () => {
    const accountPayload = {
      id: 'u-demo',
      username: 'demo',
      nickname: '演示账号',
      role: 'MERCHANT',
      uiPrefs: { menuCollapsed: false },
      features: { aiImage: true, visibility: true },
      tenant: {
        id: 't-demo',
        name: '演示租户',
        expiresAt: '2099-12-31T00:00:00.000Z',
        isActive: true,
        readOnly: false,
      },
    };
    postJsonMock.mockImplementation((path: string) => {
      if (path === '/auth/captcha') {
        return Promise.resolve({
          code: 0,
          msg: 'ok',
          data: { captchaId: 'cap_p0', image: TINY_PNG },
        });
      }
      if (path === '/auth/login') {
        return Promise.resolve({
          code: 0,
          msg: 'ok',
          data: {
            accessToken: 'at_p0',
            refreshToken: 'rt_p0',
            account: accountPayload,
          },
        });
      }
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    render(<LoginPanel />);

    await waitFor(() => {
      expect(prefetchMock).toHaveBeenCalledWith('/home');
      expect((screen.getByRole('button', { name: /登\s*录/ }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'demo' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'geomix-demo-dev' } });
    fireEvent.change(screen.getByLabelText('验证码', { selector: 'input' }), {
      target: { value: '0000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /登\s*录/ }));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/home');
    });
    expect(readCachedAccount(window.sessionStorage)).toEqual(accountPayload);
  });

  it('seeds account cache when already-authenticated session auto-redirects from /login', async () => {
    searchParamsMock = new URLSearchParams({ next: '/admin/tenants' });
    window.sessionStorage.setItem('geomix.accessToken', 'at_auto');
    window.sessionStorage.setItem('geomix.refreshToken', 'rt_auto');
    const adminAccount = {
      id: 'u-admin',
      username: 'admin',
      nickname: '管理员',
      role: 'ADMIN',
      tenant: {
        id: 't-platform',
        name: 'GeoMix 平台',
        expiresAt: '2099-12-31T00:00:00.000Z',
        isActive: true,
        readOnly: false,
      },
    };
    loadAccountMock.mockResolvedValue({ status: 'ok', account: adminAccount });

    render(<LoginPanel />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/admin/tenants');
    });
    expect(readCachedAccount(window.sessionStorage)).toEqual(adminAccount);
  });
});
