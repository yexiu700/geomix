'use client';

import { Button, Form, Input } from 'antd';
import { useState } from 'react';

export function PasswordForm({
  onSubmit,
}: {
  onSubmit: (values: { currentPassword: string; newPassword: string }) => Promise<string | null>;
}) {
  const [form] = Form.useForm<{ currentPassword: string; newPassword: string }>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={(values) => {
        setBusy(true);
        setError('');
        setNotice('');
        void onSubmit(values)
          .then((message) => {
            if (message) {
              setError(message);
              return;
            }
            form.resetFields();
            setNotice('密码已更新');
          })
          .finally(() => setBusy(false));
      }}
    >
      {error ? <p className="gm-form-error">{error}</p> : null}
      {notice ? <p className="gm-form-ok">{notice}</p> : null}
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
    </Form>
  );
}
