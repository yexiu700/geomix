'use client';

import { Alert, Button, Form, Input, Space } from 'antd';
import { useState } from 'react';

type PasswordFormValues = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

export function PasswordForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (values: { currentPassword: string; newPassword: string }) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [form] = Form.useForm<PasswordFormValues>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Form
      form={form}
      layout="vertical"
      scrollToFirstError
      onFinishFailed={({ errorFields }) => {
        const firstMsg = errorFields[0]?.errors?.[0];
        setNotice('');
        setError(firstMsg || '请完整填写密码信息');
      }}
      onFinish={(values) => {
        setBusy(true);
        setError('');
        setNotice('');
        void onSubmit({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        })
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
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {notice ? (
        <Alert type="success" showIcon message={notice} style={{ marginBottom: 12 }} />
      ) : null}
      <Form.Item
        label="当前密码"
        name="currentPassword"
        rules={[{ required: true, message: '请输入当前密码' }]}
      >
        <Input.Password placeholder="请输入当前密码" autoComplete="current-password" />
      </Form.Item>
      <Form.Item
        label="新密码"
        name="newPassword"
        rules={[
          { required: true, message: '请输入新密码' },
          { min: 8, message: '新密码至少 8 位' },
          { max: 128, message: '新密码最多 128 位' },
        ]}
      >
        <Input.Password placeholder="请输入新密码（至少 8 位）" autoComplete="new-password" />
      </Form.Item>
      <Form.Item
        label="确认新密码"
        name="confirmPassword"
        dependencies={['newPassword']}
        rules={[
          { required: true, message: '请再次输入新密码' },
          ({ getFieldValue }) => ({
            validator(_, value: string | undefined) {
              if (!value || getFieldValue('newPassword') === value) {
                return Promise.resolve();
              }
              return Promise.reject(new Error('两次输入的新密码不一致'));
            },
          }),
        ]}
      >
        <Input.Password placeholder="请再次输入新密码" autoComplete="new-password" />
      </Form.Item>
      <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
        {onCancel ? (
          <Button
            onClick={() => {
              form.resetFields();
              setError('');
              setNotice('');
              onCancel();
            }}
            disabled={busy}
          >
            取消
          </Button>
        ) : null}
        <Button type="primary" htmlType="submit" loading={busy}>
          修改密码
        </Button>
      </Space>
    </Form>
  );
}
