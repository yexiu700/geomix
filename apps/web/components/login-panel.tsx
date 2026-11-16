'use client';

import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { loadAccount, postJson } from '../lib/api';
import { safeConsoleHref } from '../lib/route-map';
import { clearSession, readAccessToken, saveSession } from '../lib/session';

const NOTICES: Record<string, string> = {
  disabled: '账号已停用',
  session: '登录已失效',
};

export function LoginPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextHref = safeConsoleHref(searchParams.get('next'));
  const preset = NOTICES[searchParams.get('notice') ?? ''] ?? '';
  const [captchaId, setCaptchaId] = useState('');
  const [captchaImage, setCaptchaImage] = useState('');
  const [error, setError] = useState(preset);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);

  const loadCaptcha = useCallback(async () => {
    const result = await postJson<{ captchaId: string; image: string }>('/auth/captcha', {});
    if (result.code !== 0 || !result.data?.captchaId || !result.data.image) {
      setError(result.msg || '验证码获取失败');
      return;
    }
    setCaptchaId(result.data.captchaId);
    setCaptchaImage(result.data.image);
  }, []);

  useEffect(() => {
    const token = readAccessToken(window.sessionStorage);
    if (!token) {
      setChecking(false);
      void loadCaptcha().catch(() => setError('无法连接接口'));
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
      void loadCaptcha().catch(() => setError('无法连接接口'));
    });
    return () => {
      live = false;
    };
  }, [loadCaptcha, nextHref, router]);

  async function onLogin(values: { username: string; password: string; captchaCode: string }) {
    setBusy(true);
    setError('');
    try {
      const result = await postJson<{ accessToken: string; refreshToken: string }>('/auth/login', {
        ...values,
        captchaId,
      });
      if (result.code !== 0 || !result.data?.accessToken || !result.data.refreshToken) {
        await loadCaptcha();
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
            {captchaImage ? (
              <div
                role="img"
                aria-label="验证码"
                style={{
                  width: 132,
                  height: 48,
                  marginBottom: 12,
                  backgroundImage: `url("${captchaImage}")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: 'contain',
                }}
              />
            ) : null}
            <div>
              <Button type="primary" htmlType="submit" loading={busy}>
                登录
              </Button>
              <Button style={{ marginLeft: 8 }} onClick={() => void loadCaptcha()}>
                换一张
              </Button>
            </div>
          </Form>
        )}
      </Card>
    </main>
  );
}
