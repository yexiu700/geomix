'use client';

import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadAccount, postJson } from '../lib/api';
import { safePostLoginHref } from '../lib/route-map';
import { clearSession, readAccessToken, saveSession } from '../lib/session';

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
        router.replace(nextHref ?? '/dashboard');
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
  }, [loadCaptcha, nextHref, router]);

  const captchaReady = Boolean(captchaId) && !captchaLoading;

  async function onLogin(values: { username: string; password: string; captchaCode: string }) {
    if (!captchaId || captchaLoading) {
      setError('验证码加载中，请稍候再试');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await postJson<{ accessToken: string; refreshToken: string }>('/auth/login', {
        ...values,
        captchaId,
      });
      if (result.code !== 0 || !result.data?.accessToken || !result.data.refreshToken) {
        await loadCaptcha({ force: true });
        setError(result.msg || '登录失败');
        return;
      }
      saveSession(window.sessionStorage, result.data.accessToken, result.data.refreshToken);
      router.replace(nextHref ?? '/dashboard');
    } catch {
      setError('无法连接接口');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="gm-boot">
      <Card style={{ maxWidth: 420, width: '100%' }} title="GeoMix 登录">
        <Typography.Paragraph type="secondary">账号由管理员开通。</Typography.Paragraph>
        {checking ? <Typography.Paragraph>正在确认登录</Typography.Paragraph> : null}
        {error ? <Alert type="error" message={error} style={{ marginBottom: 16 }} /> : null}
        {checking ? null : (
          <Form layout="vertical" onFinish={onLogin}>
            <Form.Item
              label="用户名"
              name="username"
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input autoComplete="username" />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Form.Item
              label="验证码"
              name="captchaCode"
              rules={[{ required: true, message: '请输入验证码' }]}
            >
              <Input autoComplete="off" />
            </Form.Item>
            {captchaLoading ? (
              <Typography.Paragraph type="secondary" role="status" style={{ marginBottom: 12 }}>
                正在加载验证码...
              </Typography.Paragraph>
            ) : captchaImage ? (
              <div
                role="img"
                aria-label="验证码"
                title="点击刷新验证码"
                onClick={() => {
                  if (!busy && !captchaLoading) {
                    void loadCaptcha({ force: true });
                  }
                }}
                style={{
                  width: 132,
                  height: 48,
                  marginBottom: 12,
                  cursor: busy || captchaLoading ? 'not-allowed' : 'pointer',
                  backgroundImage: `url("${captchaImage}")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: 'contain',
                }}
              />
            ) : captchaFailed ? (
              <div style={{ marginBottom: 12 }}>
                <Button
                  type="dashed"
                  danger
                  disabled={busy}
                  onClick={() => void loadCaptcha({ force: true })}
                >
                  验证码加载失败，点击重试
                </Button>
              </div>
            ) : null}
            <div>
              <Button type="primary" htmlType="submit" loading={busy} disabled={!captchaReady}>
                登录
              </Button>
              <Button
                style={{ marginLeft: 8 }}
                disabled={busy || captchaLoading}
                onClick={() => void loadCaptcha({ force: true })}
              >
                换一张
              </Button>
            </div>
          </Form>
        )}
      </Card>
    </main>
  );
}
