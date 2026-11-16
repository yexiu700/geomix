'use client';

import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { apiBase, clearSession, readAccessToken, saveSession } from '../lib/session';

type SessionUser = {
  id: string;
  username: string;
  nickname: string | null;
  role: string;
  tenantName: string;
  expiresAt: string;
  readOnly: boolean;
};

type AccountProfile = {
  username: string;
  tenant: { name: string; readOnly: boolean; expiresAt: string };
};

type Envelope<T> = { code: number; msg: string; data: T };

async function postJson<T>(path: string, body: unknown, token?: string): Promise<Envelope<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return (await response.json()) as Envelope<T>;
}

async function getJson<T>(path: string, token: string): Promise<Envelope<T>> {
  const response = await fetch(`${apiBase()}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await response.json()) as Envelope<T>;
}

export function LoginPanel() {
  const [captchaId, setCaptchaId] = useState('');
  const [captchaImage, setCaptchaImage] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [busy, setBusy] = useState(false);

  const loadCaptcha = useCallback(async () => {
    setError('');
    const result = await postJson<{ captchaId: string; image: string }>('/auth/captcha', {});
    if (result.code !== 0) {
      setError(result.msg || '验证码获取失败');
      return;
    }
    setCaptchaId(result.data.captchaId);
    setCaptchaImage(result.data.image);
  }, []);

  useEffect(() => {
    const token = readAccessToken(window.sessionStorage);
    if (!token) {
      void loadCaptcha();
      return;
    }
    void getJson<AccountProfile>('/account', token).then((result) => {
      if (result.code !== 0) {
        clearSession(window.sessionStorage);
        void loadCaptcha();
        return;
      }
      setProfile(result.data);
    });
  }, [loadCaptcha]);

  async function onLogin(values: { username: string; password: string; captchaCode: string }) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await postJson<{
        accessToken: string;
        refreshToken: string;
        user: SessionUser;
      }>('/auth/login', { ...values, captchaId });
      if (result.code !== 0) {
        await loadCaptcha();
        setError(result.msg);
        return;
      }
      saveSession(window.sessionStorage, result.data.accessToken, result.data.refreshToken);
      setUser(result.data.user);
      const account = await getJson<AccountProfile>('/account', result.data.accessToken);
      if (account.code === 0) setProfile(account.data);
    } catch {
      setError('无法连接接口');
    } finally {
      setBusy(false);
    }
  }

  async function onPassword(values: { currentPassword: string; newPassword: string }) {
    const token = readAccessToken(window.sessionStorage);
    if (!token) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await postJson<{ accessToken: string; refreshToken: string }>(
        '/auth/password',
        values,
        token,
      );
      if (result.code !== 0) {
        setError(result.msg);
        return;
      }
      saveSession(window.sessionStorage, result.data.accessToken, result.data.refreshToken);
      setNotice('密码已更新');
    } catch {
      setError('无法连接接口');
    } finally {
      setBusy(false);
    }
  }

  async function onLogout() {
    const refreshToken = window.sessionStorage.getItem('geomix.refreshToken');
    if (refreshToken) await postJson('/auth/logout', { refreshToken }).catch(() => undefined);
    clearSession(window.sessionStorage);
    setUser(null);
    setProfile(null);
    setNotice('');
    await loadCaptcha();
  }

  const signedIn = user !== null || profile !== null;

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <Card style={{ maxWidth: 480, width: '100%' }} title="GeoMix 登录">
        {error ? <Alert type="error" message={error} style={{ marginBottom: 16 }} /> : null}
        {notice ? <Alert type="success" message={notice} style={{ marginBottom: 16 }} /> : null}
        {signedIn ? (
          <>
            <Typography.Paragraph>
              {profile?.tenant.name ?? user?.tenantName} / {profile?.username ?? user?.username}
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary">
              {(profile?.tenant.readOnly ?? user?.readOnly)
                ? '账号已到期，当前只读'
                : '账号可正常使用'}
            </Typography.Paragraph>
            <Form layout="vertical" onFinish={onPassword}>
              <Form.Item
                label="当前密码"
                name="currentPassword"
                rules={[{ required: true, message: '请输入当前密码' }]}
              >
                <Input.Password autoComplete="current-password" />
              </Form.Item>
              <Form.Item
                label="新密码"
                name="newPassword"
                rules={[{ required: true, min: 8, message: '新密码至少 8 位' }]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={busy}>
                修改密码
              </Button>
              <Button style={{ marginLeft: 8 }} onClick={() => void onLogout()}>
                退出
              </Button>
            </Form>
          </>
        ) : (
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
