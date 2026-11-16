'use client';

import type { VerificationInput } from '@geomix/shared';
import { Alert, Button, Input, Typography } from 'antd';
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
  const [form, setForm] = useState<VerificationInput>(EMPTY);
  const [current, setCurrent] = useState<VerificationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void read().then(
      (next) => {
        if (!live || !next) return;
        setCurrent(next);
        setForm({
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
  }, [read]);

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
      <div className="gm-verify-form">
        <label>
          主体名称
          <Input
            aria-label="主体名称"
            value={form.companyName}
            disabled={readOnly}
            onChange={(event) =>
              setForm((value) => ({ ...value, companyName: event.target.value }))
            }
          />
        </label>
        <label>
          统一社会信用代码
          <Input
            aria-label="统一社会信用代码"
            value={form.creditCode}
            disabled={readOnly}
            onChange={(event) =>
              setForm((value) => ({ ...value, creditCode: event.target.value.toUpperCase() }))
            }
          />
        </label>
        <label>
          联系人
          <Input
            aria-label="联系人"
            value={form.contact}
            disabled={readOnly}
            onChange={(event) => setForm((value) => ({ ...value, contact: event.target.value }))}
          />
        </label>
        <label>
          电话
          <Input
            aria-label="电话"
            value={form.phone}
            disabled={readOnly}
            onChange={(event) => setForm((value) => ({ ...value, phone: event.target.value }))}
          />
        </label>
      </div>
      {error ? <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} /> : null}
      <Button
        type="primary"
        style={{ marginTop: 16 }}
        disabled={readOnly || saving}
        onClick={() => {
          setSaving(true);
          void save(form).then(
            (next) => {
              setCurrent(next);
              setError(null);
              setSaving(false);
            },
            (reason: unknown) => {
              setError(reason instanceof AccountApiError ? reason.message : '提交失败');
              setSaving(false);
            },
          );
        }}
      >
        提交资料
      </Button>
    </section>
  );
}
