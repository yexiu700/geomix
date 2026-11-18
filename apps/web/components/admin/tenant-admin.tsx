'use client';

import { formatBytes, QUOTA_DEFAULTS, type QuotaKeyName } from '@geomix/shared';
import { Alert, Button, Form, Input, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { AdminApiError, type AdminClient, type TenantRow } from '../../lib/admin-client';
import { formatShanghaiDate, UX_TERMS } from '../../lib/ux-foundation';
import { CrudModal } from '../crud/crud-modal';

const QUOTA_FIELDS: ReadonlyArray<{
  key: QuotaKeyName;
  label: string;
  unit: string;
  defaultLimit: string;
}> = [
  { key: 'MAIN_KEYWORD', label: '主关键词', unit: '个', defaultLimit: '100' },
  { key: 'QUESTION', label: '写作问题', unit: '个', defaultLimit: '10000' },
  { key: 'AI_WRITE', label: 'AI写作数量', unit: '篇', defaultLimit: '10000' },
  {
    key: 'STORAGE_BYTES',
    label: '图片存储空间',
    unit: '字节',
    defaultLimit: String(QUOTA_DEFAULTS.find((q) => q.key === 'STORAGE_BYTES')?.limit ?? 104857600),
  },
  { key: 'PUBLISH', label: '文章发布', unit: '篇', defaultLimit: '10000' },
  { key: 'SOCIAL_AUTH', label: '自媒体授权', unit: '个', defaultLimit: '100' },
];

type CreateTenantFormValues = {
  name: string;
  username: string;
  password: string;
  expiresDate: string;
  initialPoints: string;
};

type EditTenantFormValues = {
  name: string;
  expiresDate: string;
  isActive: boolean;
};

type AdjustFormValues = {
  delta: string;
};

function billingModeLabel(mode: 'SHADOW' | 'STRICT'): string {
  return mode === 'SHADOW' ? UX_TERMS.billingShadow : UX_TERMS.billingStrict;
}

function defaultExpiryDate(): string {
  return formatShanghaiDate(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), '2027-11-16');
}

function defaultCreateFormValues(): CreateTenantFormValues {
  return {
    name: '',
    username: '',
    password: '',
    expiresDate: defaultExpiryDate(),
    initialPoints: '1000',
  };
}

function dateInputToIso(dateStr: string): string {
  const trimmed = dateStr.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return new Date(`${trimmed}T23:59:59+08:00`).toISOString();
}

function formatQuotaUsageDisplay(key: QuotaKeyName, raw: string): string {
  if (key === 'STORAGE_BYTES') {
    try {
      return formatBytes(BigInt(raw));
    } catch {
      return raw;
    }
  }
  return raw;
}

function buildQuotaMaps(row: TenantRow): {
  limits: Record<QuotaKeyName, string>;
  used: Record<QuotaKeyName, string>;
} {
  const byKey = new Map((row.quotas ?? []).map((q) => [q.key, q]));
  const limits = {} as Record<QuotaKeyName, string>;
  const used = {} as Record<QuotaKeyName, string>;
  for (const field of QUOTA_FIELDS) {
    const found = byKey.get(field.key);
    limits[field.key] = found?.limit ?? field.defaultLimit;
    used[field.key] = found?.used ?? '0';
  }
  return { limits, used };
}

export function TenantAdmin({
  client,
}: {
  client: Pick<
    AdminClient,
    'listTenants' | 'createTenant' | 'updateTenant' | 'updateQuotas' | 'adjust' | 'setMode'
  > &
    Partial<Pick<AdminClient, 'getTenant'>>;
}) {
  const [createForm] = Form.useForm<CreateTenantFormValues>();
  const [editForm] = Form.useForm<EditTenantFormValues>();
  const [adjustForm] = Form.useForm<AdjustFormValues>();

  const [rows, setRows] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [searchKeyword, setSearchKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all');
  const [billingFilter, setBillingFilter] = useState<'all' | 'SHADOW' | 'STRICT' | 'inherit'>(
    'all',
  );

  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [saving, setSaving] = useState(false);

  const [edit, setEdit] = useState<TenantRow | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const [target, setTarget] = useState<TenantRow | null>(null);
  const [adjustSaving, setAdjustSaving] = useState(false);

  const [quotaFor, setQuotaFor] = useState<TenantRow | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [quotaLimits, setQuotaLimits] = useState<Record<QuotaKeyName, string>>(
    () =>
      Object.fromEntries(QUOTA_FIELDS.map((f) => [f.key, f.defaultLimit])) as Record<
        QuotaKeyName,
        string
      >,
  );
  const [quotaOriginalLimits, setQuotaOriginalLimits] = useState<Record<QuotaKeyName, string>>(
    () =>
      Object.fromEntries(QUOTA_FIELDS.map((f) => [f.key, f.defaultLimit])) as Record<
        QuotaKeyName,
        string
      >,
  );
  const [quotaUsed, setQuotaUsed] = useState<Record<QuotaKeyName, string>>(
    () => Object.fromEntries(QUOTA_FIELDS.map((f) => [f.key, '0'])) as Record<QuotaKeyName, string>,
  );

  async function reload(): Promise<void> {
    const items = await client.listTenants();
    setRows([...items]);
  }

  useEffect(() => {
    let live = true;
    setLoading(true);
    void client.listTenants().then(
      (items) => {
        if (!live) return;
        setRows(items);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!live) return;
        setError(messageOf(reason));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  const filteredRows = useMemo(() => {
    const q = searchKeyword.trim().toLowerCase();
    return rows.filter((row) => {
      if (q && !row.name.toLowerCase().includes(q) && !row.username.toLowerCase().includes(q)) {
        return false;
      }
      if (statusFilter === 'active' && !row.isActive) return false;
      if (statusFilter === 'disabled' && row.isActive) return false;
      if (billingFilter === 'inherit' && row.billingMode !== null) return false;
      if (
        (billingFilter === 'SHADOW' || billingFilter === 'STRICT') &&
        row.resolvedBillingMode !== billingFilter
      ) {
        return false;
      }
      return true;
    });
  }, [rows, searchKeyword, statusFilter, billingFilter]);

  const hasActiveFilters =
    searchKeyword.trim() !== '' || statusFilter !== 'all' || billingFilter !== 'all';

  const handleCreateSubmit = async () => {
    let values: CreateTenantFormValues;
    try {
      values = await createForm.validateFields();
    } catch {
      return;
    }
    const parsedPoints =
      values.initialPoints.trim() === '' ? 1000 : Number.parseInt(values.initialPoints.trim(), 10);
    setSaving(true);
    setModalError(null);
    try {
      await client.createTenant({
        name: values.name.trim(),
        username: values.username.trim(),
        password: values.password,
        expiresAt: dateInputToIso(values.expiresDate),
        billingMode: null,
        initialPoints: Number.isFinite(parsedPoints) && parsedPoints >= 0 ? parsedPoints : 1000,
      });
      setOpen(false);
      setMinimized(false);
      setMaximized(false);
      setNotice('租户已创建');
      createForm.setFieldsValue(defaultCreateFormValues());
      await reload();
    } catch (reason: unknown) {
      setModalError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  };

  const handleEditSubmit = async () => {
    if (!edit) return;
    let values: EditTenantFormValues;
    try {
      values = await editForm.validateFields();
    } catch {
      return;
    }
    const originalDate = formatShanghaiDate(edit.expiresAt, '');
    const nextExpiresAt =
      values.expiresDate.trim() === originalDate
        ? edit.expiresAt
        : dateInputToIso(values.expiresDate);
    setEditSaving(true);
    setModalError(null);
    try {
      await client.updateTenant(edit.id, {
        name: values.name.trim(),
        expiresAt: nextExpiresAt || undefined,
        isActive: values.isActive,
      });
      setNotice('租户已更新');
      setEdit(null);
      await reload();
    } catch (reason: unknown) {
      setModalError(messageOf(reason));
    } finally {
      setEditSaving(false);
    }
  };

  const handleAdjustSubmit = async () => {
    if (!target) return;
    let values: AdjustFormValues;
    try {
      values = await adjustForm.validateFields();
    } catch {
      return;
    }
    const amount = Number(values.delta.trim());
    setAdjustSaving(true);
    setModalError(null);
    try {
      await client.adjust(target.id, amount);
      setNotice(amount > 0 ? `+${amount} 管理员充值` : `${amount} 管理员扣点`);
      setTarget(null);
      await reload();
    } catch (reason: unknown) {
      setModalError(messageOf(reason));
    } finally {
      setAdjustSaving(false);
    }
  };

  const handleSaveQuotas = async () => {
    if (!quotaFor) return;
    for (const field of QUOTA_FIELDS) {
      const limitStr = (quotaLimits[field.key] ?? '').trim();
      if (!/^[0-9]{1,15}$/.test(limitStr)) {
        setModalError(`${field.label}配额上限需为非负整数`);
        return;
      }
      const usedStr = quotaUsed[field.key] ?? '0';
      if (/^[0-9]+$/.test(usedStr) && BigInt(limitStr) < BigInt(usedStr)) {
        setModalError(
          `${field.label}上限不能低于当前已用量（${formatQuotaUsageDisplay(field.key, usedStr)}）`,
        );
        return;
      }
    }

    const changedItems = QUOTA_FIELDS.filter(
      (field) => (quotaLimits[field.key] ?? '').trim() !== quotaOriginalLimits[field.key],
    ).map((field) => ({
      key: field.key,
      limit: (quotaLimits[field.key] ?? '').trim(),
    }));

    if (changedItems.length === 0) {
      setQuotaFor(null);
      setModalError(null);
      return;
    }

    setQuotaSaving(true);
    setModalError(null);
    try {
      await client.updateQuotas(quotaFor.id, { items: changedItems });
      setNotice('配额已更新');
      setQuotaFor(null);
      await reload();
    } catch (reason: unknown) {
      setModalError(messageOf(reason));
    } finally {
      setQuotaSaving(false);
    }
  };

  return (
    <section aria-label="租户管理">
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          租户
        </Typography.Title>
        <Button
          type="primary"
          onClick={() => {
            setModalError(null);
            createForm.setFieldsValue(defaultCreateFormValues());
            setMinimized(false);
            setMaximized(false);
            setOpen(true);
          }}
        >
          开户
        </Button>
      </div>

      <Space wrap style={{ marginBottom: 12, width: '100%' }}>
        <Input
          aria-label="搜索租户"
          placeholder="搜索租户名称或用户名"
          allowClear
          style={{ width: 240 }}
          value={searchKeyword}
          onChange={(event) => setSearchKeyword(event.target.value)}
        />
        <Select
          aria-label="状态筛选"
          value={statusFilter}
          style={{ width: 130 }}
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'active', label: '正常' },
            { value: 'disabled', label: '已停用' },
          ]}
          onChange={(value) => setStatusFilter(value)}
        />
        <Select
          aria-label="计费模式筛选"
          value={billingFilter}
          style={{ width: 160 }}
          options={[
            { value: 'all', label: '全部计费模式' },
            { value: 'SHADOW', label: UX_TERMS.billingShadow },
            { value: 'STRICT', label: UX_TERMS.billingStrict },
            { value: 'inherit', label: '跟随系统默认' },
          ]}
          onChange={(value) => setBillingFilter(value)}
        />
        {hasActiveFilters ? (
          <Button
            aria-label="重置筛选"
            onClick={() => {
              setSearchKeyword('');
              setStatusFilter('all');
              setBillingFilter('all');
            }}
          >
            重置
          </Button>
        ) : null}
      </Space>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {notice ? (
        <Alert type="success" showIcon message={notice} style={{ marginBottom: 12 }} />
      ) : null}

      <Table<TenantRow>
        rowKey="id"
        loading={loading}
        dataSource={filteredRows}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: hasActiveFilters ? '没有匹配的租户' : '暂无租户' }}
        pagination={{
          pageSize: 10,
          showSizeChanger: true,
          pageSizeOptions: ['10', '25', '50'],
          showTotal: (total) => `共 ${total} 条`,
        }}
        columns={[
          { title: '名称', dataIndex: 'name', width: 150 },
          { title: '用户名', dataIndex: 'username', width: 140 },
          {
            title: '点数',
            dataIndex: 'points',
            width: 90,
            render: (value: number) => <span className="gm-num">{value}</span>,
          },
          {
            title: '计费模式',
            width: 190,
            render: (_value, row) =>
              row.billingMode
                ? billingModeLabel(row.billingMode)
                : `跟随系统默认（${billingModeLabel(row.resolvedBillingMode)}）`,
          },
          {
            title: '有效期',
            width: 120,
            render: (_value, row) => (
              <span className="gm-num" style={{ whiteSpace: 'nowrap' }}>
                {formatShanghaiDate(row.expiresAt)}
              </span>
            ),
          },
          {
            title: '状态',
            width: 90,
            render: (_value, row) => (
              <Tag
                color={row.isActive ? 'success' : 'default'}
                style={{ marginInlineEnd: 0, whiteSpace: 'nowrap' }}
              >
                {row.isActive ? '正常' : '已停用'}
              </Tag>
            ),
          },
          {
            title: '操作',
            width: 340,
            render: (_value, row) => (
              <Space wrap={false}>
                <Button
                  aria-label={`编辑 ${row.name}`}
                  onClick={() => {
                    setModalError(null);
                    setEdit(row);
                    editForm.setFieldsValue({
                      name: row.name,
                      expiresDate: formatShanghaiDate(row.expiresAt, defaultExpiryDate()),
                      isActive: row.isActive,
                    });
                  }}
                >
                  编辑
                </Button>
                <Button
                  aria-label={`加点 ${row.name}`}
                  onClick={() => {
                    setModalError(null);
                    setTarget(row);
                    adjustForm.setFieldsValue({ delta: '500' });
                  }}
                >
                  加点
                </Button>
                <Button
                  aria-label={`配额 ${row.name}`}
                  onClick={() => {
                    setModalError(null);
                    setQuotaFor(row);
                    const initial = buildQuotaMaps(row);
                    setQuotaLimits(initial.limits);
                    setQuotaOriginalLimits(initial.limits);
                    setQuotaUsed(initial.used);
                    if (client.getTenant) {
                      setQuotaLoading(true);
                      void client.getTenant(row.id).then(
                        (detail) => {
                          const next = buildQuotaMaps(detail);
                          setQuotaOriginalLimits(next.limits);
                          setQuotaUsed(next.used);
                          setQuotaLimits((current) => {
                            const merged = { ...next.limits };
                            for (const field of QUOTA_FIELDS) {
                              if (current[field.key] !== initial.limits[field.key]) {
                                merged[field.key] = current[field.key];
                              }
                            }
                            return merged;
                          });
                          setQuotaLoading(false);
                        },
                        () => {
                          setQuotaLoading(false);
                        },
                      );
                    }
                  }}
                >
                  配额
                </Button>
                <Select
                  aria-label={`计费模式 ${row.name}`}
                  value={row.billingMode ?? 'inherit'}
                  style={{ width: 136 }}
                  options={[
                    { value: 'inherit', label: '跟随系统默认' },
                    { value: 'SHADOW', label: UX_TERMS.billingShadow },
                    { value: 'STRICT', label: UX_TERMS.billingStrict },
                  ]}
                  onChange={(value: string) => {
                    const mode = value === 'SHADOW' || value === 'STRICT' ? value : null;
                    setError(null);
                    void client.setMode(row.id, mode).then(
                      () => {
                        setNotice(
                          mode === 'SHADOW'
                            ? `${row.name} 已切到${UX_TERMS.billingShadow}，已提交的任务仍按冻结单结算`
                            : `${row.name} 的计费模式已更新`,
                        );
                        return reload();
                      },
                      (reason: unknown) => setError(messageOf(reason)),
                    );
                  }}
                />
              </Space>
            ),
          },
        ]}
      />

      <CrudModal
        open={open}
        title="开户"
        minimized={minimized}
        maximized={maximized}
        confirmLoading={saving}
        error={modalError}
        onMinimize={() => setMinimized(true)}
        onRestore={() => setMinimized(false)}
        onMaximize={() => setMaximized((value) => !value)}
        onClose={() => {
          setModalError(null);
          setOpen(false);
        }}
        onReset={() => {
          setModalError(null);
          createForm.setFieldsValue(defaultCreateFormValues());
        }}
        ok={
          <Button
            type="primary"
            aria-label="确定"
            loading={saving}
            onClick={() => void handleCreateSubmit()}
          >
            确定
          </Button>
        }
      >
        <Form
          form={createForm}
          layout="vertical"
          scrollToFirstError
          initialValues={defaultCreateFormValues()}
        >
          <Form.Item
            label="租户名称"
            name="name"
            rules={[
              { required: true, whitespace: true, message: '请填写租户名称' },
              { max: 40, message: '名称最多 40 字' },
            ]}
          >
            <Input aria-label="租户名称" placeholder="请输入租户名称（最多 40 字）" />
          </Form.Item>
          <Form.Item
            label="登录用户名"
            name="username"
            rules={[
              { required: true, whitespace: true, message: '请填写登录用户名' },
              {
                pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/,
                message: '用户名需为 2~32 位字母、数字、下划线或连字符，且以字母或数字开头',
              },
            ]}
          >
            <Input aria-label="登录用户名" placeholder="请输入登录用户名（2~32 位字母/数字/_/-）" />
          </Form.Item>
          <Form.Item
            label="初始密码"
            name="password"
            rules={[
              { required: true, message: '请输入初始密码' },
              { min: 8, message: '密码至少 8 位' },
              { max: 128, message: '密码最多 128 位' },
            ]}
          >
            <Input.Password
              aria-label="初始密码"
              placeholder="请输入初始密码（至少 8 位）"
              autoComplete="new-password"
            />
          </Form.Item>
          <Form.Item
            label="有效期"
            name="expiresDate"
            rules={[
              { required: true, message: '请选择有效期' },
              { pattern: /^\d{4}-\d{2}-\d{2}$/, message: '请选择有效日期' },
            ]}
          >
            <Input type="date" aria-label="有效期" />
          </Form.Item>
          <Form.Item
            label="初始点数"
            name="initialPoints"
            rules={[
              {
                validator: (_, value: string | undefined) => {
                  const trimmed = (value ?? '').trim();
                  if (trimmed === '') return Promise.resolve();
                  if (/^[0-9]{1,9}$/.test(trimmed)) return Promise.resolve();
                  return Promise.reject(new Error('初始点数需为非负整数'));
                },
              },
            ]}
          >
            <Input
              aria-label="初始点数"
              type="number"
              min={0}
              placeholder="初始点数（默认 1000）"
            />
          </Form.Item>
        </Form>
      </CrudModal>

      <CrudModal
        open={edit !== null}
        title="编辑租户"
        minimized={false}
        maximized={false}
        confirmLoading={editSaving}
        error={modalError}
        onClose={() => {
          setModalError(null);
          setEdit(null);
        }}
        onReset={() => {
          setModalError(null);
          if (!edit) return;
          editForm.setFieldsValue({
            name: edit.name,
            expiresDate: formatShanghaiDate(edit.expiresAt, defaultExpiryDate()),
            isActive: edit.isActive,
          });
        }}
        ok={
          <Button
            type="primary"
            aria-label="保存租户"
            loading={editSaving}
            onClick={() => void handleEditSubmit()}
          >
            保存租户
          </Button>
        }
      >
        <Form form={editForm} layout="vertical" scrollToFirstError>
          <Form.Item
            label="租户名称"
            name="name"
            rules={[
              { required: true, whitespace: true, message: '请填写租户名称' },
              { max: 40, message: '名称最多 40 字' },
            ]}
          >
            <Input aria-label="租户名称" placeholder="请输入租户名称（最多 40 字）" />
          </Form.Item>
          <Form.Item
            label="租户有效期"
            name="expiresDate"
            rules={[
              { required: true, message: '请选择租户有效期' },
              { pattern: /^\d{4}-\d{2}-\d{2}$/, message: '请选择有效日期' },
            ]}
          >
            <Input type="date" aria-label="租户有效期" />
          </Form.Item>
          <Form.Item label="启用状态" name="isActive" valuePropName="checked">
            <Switch aria-label="启用状态" />
          </Form.Item>
        </Form>
      </CrudModal>

      <CrudModal
        open={target !== null}
        title="加点"
        minimized={false}
        maximized={false}
        confirmLoading={adjustSaving}
        error={modalError}
        onClose={() => {
          setModalError(null);
          setTarget(null);
        }}
        onReset={() => {
          setModalError(null);
          adjustForm.setFieldsValue({ delta: '500' });
        }}
        ok={
          <Button
            type="primary"
            aria-label="确认加点"
            loading={adjustSaving}
            onClick={() => void handleAdjustSubmit()}
          >
            确认加点
          </Button>
        }
      >
        <Form
          form={adjustForm}
          layout="vertical"
          scrollToFirstError
          initialValues={{ delta: '500' }}
        >
          <Form.Item
            label="调整点数"
            name="delta"
            rules={[
              { required: true, message: '请输入调整点数' },
              {
                validator: (_, value: string | undefined) => {
                  const trimmed = (value ?? '').trim();
                  if (!trimmed) return Promise.resolve();
                  if (!/^-?\d+$/.test(trimmed) || Number(trimmed) === 0) {
                    return Promise.reject(new Error('调整点数需为非零整数'));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input aria-label="调整点数" placeholder="请输入非零整数，正数充值、负数扣点" />
          </Form.Item>
        </Form>
      </CrudModal>

      <CrudModal
        open={quotaFor !== null}
        title={quotaFor ? `配额上限 · ${quotaFor.name}` : '配额上限'}
        width={640}
        minimized={false}
        maximized={false}
        confirmLoading={quotaSaving}
        error={modalError}
        onClose={() => {
          setModalError(null);
          setQuotaFor(null);
        }}
        onReset={() => {
          setModalError(null);
          setQuotaLimits(quotaOriginalLimits);
        }}
        ok={
          <Button
            type="primary"
            aria-label="保存配额"
            loading={quotaSaving}
            onClick={() => void handleSaveQuotas()}
          >
            保存配额
          </Button>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {quotaLoading ? (
            <Typography.Text type="secondary">正在同步最新已用量...</Typography.Text>
          ) : null}
          {QUOTA_FIELDS.map((field) => {
            const usedRaw = quotaUsed[field.key] ?? '0';
            const usedDisplay = formatQuotaUsageDisplay(field.key, usedRaw);
            const currentVal = quotaLimits[field.key] ?? field.defaultLimit;
            const storageReadable =
              field.key === 'STORAGE_BYTES' && /^[0-9]{1,15}$/.test(currentVal.trim())
                ? formatBytes(BigInt(currentVal.trim()))
                : null;
            return (
              <div
                key={field.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 220px',
                  gap: 12,
                  alignItems: 'center',
                  paddingBottom: 10,
                  borderBottom: '1px solid var(--gm-line-1)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 500, color: 'var(--gm-fg-1)' }}>{field.label}</div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    当前已用：{usedDisplay}
                    {field.key !== 'STORAGE_BYTES' ? ` ${field.unit}` : ''}
                    {storageReadable ? ` · 当前上限约 ${storageReadable}` : ''}
                  </Typography.Text>
                </div>
                <Input
                  aria-label={`${field.label} 上限`}
                  placeholder="请输入非负整数上限"
                  suffix={field.unit}
                  value={currentVal}
                  onChange={(event) => {
                    const next = event.target.value;
                    setQuotaLimits((current) => ({ ...current, [field.key]: next }));
                  }}
                />
              </div>
            );
          })}
        </Space>
      </CrudModal>

      <p className="gm-admin-note">
        配额项包括{QUOTA_FIELDS.map((item) => item.label).join('、')}
        。修改配额上限不能低于当前已用量。
      </p>
    </section>
  );
}

function messageOf(reason: unknown): string {
  if (reason instanceof AdminApiError) return reason.message;
  return '操作失败';
}
