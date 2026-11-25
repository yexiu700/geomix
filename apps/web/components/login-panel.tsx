'use client';

import { Alert, Button, Card, Form, Input, Tooltip, Typography } from 'antd';
import { useRouter, useSearchParams } from 'next/navigation';
import { type ComponentProps, useCallback, useEffect, useRef, useState } from 'react';
import { writeCachedAccount } from '../lib/account-cache';
import { loadAccount, postJson, type AccountProfile } from '../lib/api';
import { safePostLoginHref } from '../lib/route-map';
import { clearSession, readAccessToken, saveSession } from '../lib/session';
import { GeoMixIcon } from './brand/geomix-logo';

export const CAPTCHA_LOAD_TIMEOUT_MS = 10_000;

const NOTICES: Record<string, string> = {
  disabled: '账号已停用',
  session: '登录已失效',
};

type CaptchaAttemptResult =
  | { kind: 'ok'; captchaId: string; image: string }
  | { kind: 'api-error'; message: string }
  | { kind: 'aborted' }
  | { kind: 'timeout' }
  | { kind: 'network-error' };

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError')
  );
}

async function fetchCaptchaAttempt(controller: AbortController): Promise<CaptchaAttemptResult> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;

  try {
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });

    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CAPTCHA_LOAD_TIMEOUT_MS);

    const result = await Promise.race([
      postJson<{ captchaId: string; image: string }>('/auth/captcha', {}, undefined, {
        signal: controller.signal,
      }),
      abortPromise,
    ]);

    if (result.code !== 0 || !result.data?.captchaId || !result.data.image) {
      return { kind: 'api-error', message: result.msg || '验证码获取失败' };
    }
    return { kind: 'ok', captchaId: result.data.captchaId, image: result.data.image };
  } catch (error) {
    if (timedOut) return { kind: 'timeout' };
    if (isAbortError(error) || controller.signal.aborted) return { kind: 'aborted' };
    return { kind: 'network-error' };
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  }
}

function PasswordEyeIcon({ visible }: { visible: boolean }) {
  return (
    <span
      aria-hidden="true"
      aria-label={visible ? 'eye' : 'eye-invisible'}
      className="gm-login-password-eye"
    >
      {visible ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M1.5 8C2.8 5.2 5.2 3.8 8 3.8C10.8 3.8 13.2 5.2 14.5 8C13.2 10.8 10.8 12.2 8 12.2C5.2 12.2 2.8 10.8 1.5 8Z"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.35" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M2.2 2.2L13.8 13.8"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
          />
          <path
            d="M6.4 4.1C6.9 3.9 7.4 3.8 8 3.8C10.8 3.8 13.2 5.2 14.5 8C13.9 9.2 13.1 10.2 12 10.9M9.9 11.9C9.3 12.1 8.7 12.2 8 12.2C5.2 12.2 2.8 10.8 1.5 8C2.2 6.5 3.3 5.4 4.6 4.7"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M6.6 6.6C6.2 7 6 7.5 6 8C6 9.1 6.9 10 8 10C8.5 10 9 9.8 9.4 9.4"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
          />
        </svg>
      )}
    </span>
  );
}

function LoginPasswordInput(props: ComponentProps<typeof Input.Password>) {
  const [visible, setVisible] = useState(false);

  return (
    <div
      onMouseDownCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('.ant-input-password-icon')) {
          event.preventDefault();
        }
      }}
      onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('.ant-input-password-icon')) {
          event.stopPropagation();
          if (!props.disabled) {
            setVisible((prev) => !prev);
          }
        }
      }}
    >
      <Input.Password
        {...props}
        visibilityToggle={{
          visible,
          onVisibleChange: setVisible,
        }}
        iconRender={(isVisible) => (
          <button
            type="button"
            aria-label={isVisible ? '隐藏密码' : '显示密码'}
            aria-pressed={isVisible}
            title={isVisible ? '隐藏密码' : '显示密码'}
            disabled={props.disabled}
          >
            <PasswordEyeIcon visible={isVisible} />
          </button>
        )}
      />
    </div>
  );
}

export function LoginPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextHref = safePostLoginHref(searchParams.get('next'));
  const preset = NOTICES[searchParams.get('notice') ?? ''] ?? '';
  const [captchaId, setCaptchaId] = useState('');
  const [captchaImage, setCaptchaImage] = useState('');
  const [captchaLoading, setCaptchaLoading] = useState(true);
  const [captchaFailed, setCaptchaFailed] = useState(false);
  const [error, setError] = useState(preset);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const mountedRef = useRef(true);
  const captchaSeqRef = useRef(0);
  const inFlightCaptchaRef = useRef<{
    seq: number;
    promise: Promise<void>;
    controller: AbortController;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadCaptcha = useCallback(async (options?: { force?: boolean }) => {
    if (!options?.force && inFlightCaptchaRef.current) {
      return inFlightCaptchaRef.current.promise;
    }
    if (options?.force && inFlightCaptchaRef.current) {
      inFlightCaptchaRef.current.controller.abort();
      inFlightCaptchaRef.current = null;
    }

    const seq = ++captchaSeqRef.current;
    const controller = new AbortController();

    if (mountedRef.current) {
      setCaptchaLoading(true);
      setCaptchaFailed(false);
      setCaptchaId('');
      setCaptchaImage('');
      if (options?.force) {
        setError('');
      }
    }

    const entry = {
      seq,
      controller,
      promise: Promise.resolve(),
    };

    const task = (async () => {
      try {
        let outcome = await fetchCaptchaAttempt(controller);
        if (outcome.kind === 'aborted' && seq === captchaSeqRef.current && mountedRef.current) {
          const retryController = new AbortController();
          entry.controller = retryController;
          outcome = await fetchCaptchaAttempt(retryController);
        }

        if (!mountedRef.current || seq !== captchaSeqRef.current) {
          return;
        }

        if (outcome.kind === 'ok') {
          setCaptchaId(outcome.captchaId);
          setCaptchaImage(outcome.image);
          setCaptchaFailed(false);
          return;
        }

        setCaptchaId('');
        setCaptchaImage('');
        setCaptchaFailed(true);
        if (outcome.kind === 'api-error') {
          setError(outcome.message);
        } else if (outcome.kind === 'timeout') {
          setError('验证码加载超时，请点击重试');
        } else {
          setError('无法连接接口');
        }
      } finally {
        if (inFlightCaptchaRef.current?.seq === seq) {
          inFlightCaptchaRef.current = null;
        }
        if (mountedRef.current && seq === captchaSeqRef.current) {
          setCaptchaLoading(false);
        }
      }
    })();

    entry.promise = task;
    inFlightCaptchaRef.current = entry;
    return task;
  }, []);

  const targetHref = nextHref ?? '/home';

  useEffect(() => {
    if (checking) return;
    router.prefetch?.(targetHref);
  }, [checking, router, targetHref]);

  useEffect(() => {
    const token = readAccessToken(window.sessionStorage);
    if (!token) {
      setChecking(false);
      void loadCaptcha();
      return;
    }
    let live = true;
    void loadAccount(window.sessionStorage).then((result) => {
      if (!live) return;
      if (result.status === 'ok') {
        writeCachedAccount(window.sessionStorage, result.account);
        router.replace(targetHref);
        return;
      }
      if (result.status === 'disabled' || result.status === 'anonymous') {
        clearSession(window.sessionStorage);
        if (result.status === 'disabled') setError('账号已停用');
      }
      if (result.status === 'offline') setError('无法连接接口');
      setChecking(false);
      void loadCaptcha();
    });
    return () => {
      live = false;
    };
  }, [loadCaptcha, router, targetHref]);

  const captchaReady = Boolean(captchaId) && !captchaLoading;

  async function onLogin(values: { username: string; password: string; captchaCode: string }) {
    if (!captchaId || captchaLoading) {
      setError('验证码加载中，请稍候再试');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await postJson<{
        accessToken: string;
        refreshToken: string;
        account?: AccountProfile;
        user?: {
          id: string;
          username: string;
          nickname: string | null;
          role: string;
          tenantId: string;
          tenantName: string;
          expiresAt: string;
          readOnly: boolean;
        };
      }>('/auth/login', {
        ...values,
        captchaId,
      });
      if (result.code !== 0 || !result.data?.accessToken || !result.data.refreshToken) {
        await loadCaptcha({ force: true });
        setError(result.msg || '登录失败');
        return;
      }
      saveSession(window.sessionStorage, result.data.accessToken, result.data.refreshToken);
      const seededAccount: AccountProfile | null =
        result.data.account ??
        (result.data.user
          ? {
              id: result.data.user.id,
              username: result.data.user.username,
              nickname: result.data.user.nickname,
              role: result.data.user.role,
              tenant: {
                id: result.data.user.tenantId,
                name: result.data.user.tenantName,
                expiresAt: result.data.user.expiresAt,
                isActive: true,
                readOnly: result.data.user.readOnly,
              },
            }
          : null);
      if (seededAccount) {
        writeCachedAccount(window.sessionStorage, seededAccount);
      }
      router.replace(targetHref);
    } catch {
      setError('无法连接接口');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="gm-boot">
      <Card
        className="gm-login-card"
        title={
          <span className="gm-login-title">
            <GeoMixIcon size={20} className="gm-brand-mark" />
            <span>GeoMix 登录</span>
          </span>
        }
      >
        <Typography.Paragraph className="gm-login-helper">账号由管理员开通。</Typography.Paragraph>
        {checking ? <Typography.Paragraph>正在确认登录</Typography.Paragraph> : null}
        {error ? <Alert type="error" message={error} style={{ marginBottom: 16 }} /> : null}
        {checking ? null : (
          <Form layout="vertical" onFinish={onLogin}>
            <Form.Item
              label="用户名"
              name="username"
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input autoComplete="username" placeholder="请输入用户名" />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <LoginPasswordInput autoComplete="current-password" placeholder="请输入密码" />
            </Form.Item>
            <Form.Item
              label="验证码"
              name="captchaCode"
              rules={[{ required: true, message: '请输入验证码' }]}
            >
              <Input autoComplete="off" placeholder="请输入图形验证码" />
            </Form.Item>
            <div className="gm-login-captcha-row">
              <div className="gm-login-captcha-media">
                {captchaLoading ? (
                  <Typography.Paragraph role="status" className="gm-login-captcha-status">
                    正在加载验证码...
                  </Typography.Paragraph>
                ) : captchaImage ? (
                  <>
                    <Tooltip title="点击图片更换验证码">
                      <button
                        type="button"
                        className={`gm-login-captcha-frame${busy || captchaLoading ? ' is-disabled' : ''}`}
                        aria-label="点击图片更换验证码"
                        title="点击图片更换验证码"
                        disabled={busy || captchaLoading}
                        onClick={() => {
                          if (!busy && !captchaLoading) {
                            void loadCaptcha({ force: true });
                          }
                        }}
                      >
                        <span
                          role="img"
                          aria-label="验证码"
                          title="点击图片更换验证码"
                          className={`gm-login-captcha-img${busy || captchaLoading ? ' is-disabled' : ''}`}
                          style={{
                            backgroundImage: `url("${captchaImage}")`,
                          }}
                        />
                      </button>
                    </Tooltip>
                    <Typography.Text className="gm-login-captcha-hint">
                      点击图片更换验证码
                    </Typography.Text>
                  </>
                ) : captchaFailed ? (
                  <Button
                    type="dashed"
                    danger
                    disabled={busy}
                    onClick={() => void loadCaptcha({ force: true })}
                  >
                    验证码加载失败，点击重试
                  </Button>
                ) : null}
              </div>
              <Button
                className="gm-login-captcha-refresh"
                disabled={busy || captchaLoading}
                onClick={() => void loadCaptcha({ force: true })}
              >
                换一张
              </Button>
            </div>
            <div className="gm-login-actions">
              <Button
                type="primary"
                htmlType="submit"
                block
                loading={busy}
                disabled={!captchaReady}
              >
                登录
              </Button>
            </div>
            <Typography.Paragraph className="gm-login-support-note">
              忘记密码或需开通、重置账号，请联系团队或平台管理员协助处理。
            </Typography.Paragraph>
          </Form>
        )}
      </Card>
    </main>
  );
}
