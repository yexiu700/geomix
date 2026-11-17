// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LoginPanel } from './login-panel';

const replaceMock = vi.fn();
const postJsonMock = vi.fn();
const loadAccountMock = vi.fn();

const routerMock = { replace: replaceMock };
const searchParamsMock = new URLSearchParams();

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
  cleanup();
  window.sessionStorage.clear();
  replaceMock.mockReset();
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
    expect(postJsonMock).toHaveBeenCalledWith('/auth/captcha', {});

    // Resolve captcha
    resolveCaptcha({
      code: 0,
      msg: 'ok',
      data: {
        captchaId: 'cap_ready_123',
        image:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
    });

    await waitFor(() => {
      expect((screen.getByRole('button', { name: /登\s*录/ }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    expect(screen.getByRole('img', { name: '验证码' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'demo' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'geomix-demo-dev' } });
    fireEvent.change(screen.getByLabelText('验证码', { selector: 'input' }), {
      target: { value: '0000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /登\s*录/ }));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledWith('/auth/login', {
        username: 'demo',
        password: 'geomix-demo-dev',
        captchaCode: '0000',
        captchaId: 'cap_ready_123',
      });
    });
    expect(replaceMock).toHaveBeenCalledWith('/dashboard');
  });
});
