'use client';

import type { VerificationInput } from '@geomix/shared';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  AccountApiError,
  httpSubmitVerification,
  httpVerification,
  type VerificationView,
} from '../../lib/account-client';

const EMPTY: VerificationInput = {
  companyName: '',
  creditCode: '',
  contact: '',
  phone: '',
};

export function VerifyScreen({
  title,
  readOnly = false,
  load,
  submit,
}: {
  title: string;
  readOnly?: boolean;
  load?: () => Promise<VerificationView | null>;
  submit?: (input: VerificationInput) => Promise<VerificationView>;
}) {
  const fallbackLoad = useMemo(() => () => httpVerification(window.sessionStorage), []);
  const fallbackSubmit = useMemo(
    () => (input: VerificationInput) => httpSubmitVerification(window.sessionStorage, input),
    [],
  );
  const read = load ?? fallbackLoad;
  const save = submit ?? fallbackSubmit;
  const [form] = Form.useForm<VerificationInput>();
  const [current, setCurrent] = useState<VerificationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void read().then(
      (next) => {
        if (!live || !next) return;
        setCurrent(next);
        form.setFieldsValue({
          companyName: next.companyName,
          creditCode: next.creditCode,
          contact: next.contact,
          phone: next.phone,
        });
      },
      (reason: unknown) => {
        if (!live) return;
        setError(reason instanceof AccountApiError ? reason.message : '无法加载实名资料');
      },
    );
    return () => {
      live = false;
    };
  }, [read, form]);

  const handleFinish = (values: VerificationInput) => {
    const payload: VerificationInput = {
      companyName: values.companyName.trim(),
      creditCode: values.creditCode.trim().toUpperCase(),
      contact: (values.contact ?? '').trim(),
      phone: (values.phone ?? '').trim(),
    };
    setSaving(true);
    setError(null);
    setNotice(null);
    void save(payload).then(
      (next) => {
        setCurrent(next);
        setError(null);
        setNotice('实名资料已保存');
        setSaving(false);
      },
      (reason: unknown) => {
        setError(reason instanceof AccountApiError ? reason.message : '提交失败');
        setSaving(false);
      },
    );
  };

  return (
    <section aria-label="实名认证">
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="实名认证尚未开通核验。提交后只保存在 GeoMix，状态保持为已提交，不会变成已通过。"
      />
      {current ? (
        <p>当前状态：{current.status === 'SUBMITTED' ? '已提交' : current.status}</p>
      ) : null}
      <Form
        form={form}
        layout="vertical"
        scrollToFirstError
        initialValues={EMPTY}
        style={{ maxWidth: 480 }}
        onFinish={handleFinish}
      >
        <Form.Item
          label="主体名称"
          name="companyName"
          rules={[
            { required: true, whitespace: true, message: '请填写主体名称' },
            {
              validator: (_, value: string | undefined) => {
                const trimmed = value?.trim() ?? '';
                if (!trimmed || trimmed.length >= 2) return Promise.resolve();
                return Promise.reject(new Error('主体名称至少 2 个字'));
              },
            },
            { max: 80, message: '主体名称过长' },
          ]}
        >
          <Input
            aria-label="主体名称"
            placeholder="请输入企业或机构主体名称（至少 2 个字）"
            disabled={readOnly}
          />
        </Form.Item>
        <Form.Item
          label="统一社会信用代码"
          name="creditCode"
          rules={[
            { required: true, whitespace: true, message: '请填写统一社会信用代码' },
            {
              pattern: /^[0-9A-Za-z]{8,32}$/,
              message: '统一社会信用代码需为 8~32 位字母或数字',
            },
          ]}
        >
          <Input
            aria-label="统一社会信用代码"
            placeholder="请输入 8~32 位字母或数字"
            disabled={readOnly}
            onChange={(event) => {
              form.setFieldValue('creditCode', event.target.value.toUpperCase());
            }}
          />
        </Form.Item>
        <Form.Item label="联系人" name="contact" rules={[{ max: 40, message: '联系人过长' }]}>
          <Input aria-label="联系人" placeholder="选填，联系人姓名" disabled={readOnly} />
        </Form.Item>
        <Form.Item
          label="电话"
          name="phone"
          rules={[
            { max: 20, message: '电话过长' },
            {
              validator: (_, value: string | undefined) => {
                const trimmed = value?.trim() ?? '';
                if (!trimmed || /^[0-9+\- ]{6,20}$/.test(trimmed)) return Promise.resolve();
                return Promise.reject(new Error('电话格式不正确'));
              },
            },
          ]}
        >
          <Input aria-label="电话" placeholder="选填，联系电话" disabled={readOnly} />
        </Form.Item>
        {error ? (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
        ) : null}
        {notice ? (
          <Alert type="success" showIcon message={notice} style={{ marginBottom: 12 }} />
        ) : null}
        <Button type="primary" htmlType="submit" disabled={readOnly || saving} loading={saving}>
          提交资料
        </Button>
      </Form>
    </section>
  );
}
