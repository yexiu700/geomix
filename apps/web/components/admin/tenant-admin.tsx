'use client';

import type { CreateTenantInput, QuotaKeyName } from '@geomix/shared';
import { Alert, Button, Input, Select, Space, Switch, Table, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { AdminApiError, type AdminClient, type TenantRow } from '../../lib/admin-client';
import { formatShanghaiDate } from '../../lib/ux-foundation';
import { CrudModal } from '../crud/crud-modal';

const QUOTA_FIELDS: ReadonlyArray<readonly [QuotaKeyName, string]> = [
  ['MAIN_KEYWORD', '主关键词'],
  ['QUESTION', '写作问题'],
  ['AI_WRITE', 'AI写作数量'],
  ['STORAGE_BYTES', '图片存储空间(字节)'],
  ['PUBLISH', '文章发布'],
  ['SOCIAL_AUTH', '自媒体授权'],
];

export function TenantAdmin({
  client,
}: {
  client: Pick<
    AdminClient,
    'listTenants' | 'createTenant' | 'updateTenant' | 'updateQuotas' | 'adjust' | 'setMode'
  > &
    Partial<Pick<AdminClient, 'getTenant'>>;
}) {
  const [rows, setRows] = useState<TenantRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [target, setTarget] = useState<TenantRow | null>(null);
  const [edit, setEdit] = useState<TenantRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editExpiresAt, setEditExpiresAt] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [quotaFor, setQuotaFor] = useState<TenantRow | null>(null);
  const [quotaKey, setQuotaKey] = useState<QuotaKeyName>('MAIN_KEYWORD');
  const [quotaMap, setQuotaMap] = useState<Record<string, string>>({});
  const [quotaLimit, setQuotaLimit] = useState('100');
  const [delta, setDelta] = useState('500');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<CreateTenantInput>({
    name: '',
    username: '',
    password: '',
    expiresAt: '2027-11-16T00:00:00.000Z',
    billingMode: null,
    initialPoints: 1000,
  });

  async function reload(): Promise<void> {
    const items = await client.listTenants();
    setRows(items);
  }

  useEffect(() => {
    let live = true;
    void client.listTenants().then(
      (items) => {
        if (!live) return;
        setRows(items);
      },
      (reason: unknown) => {
        if (!live) return;
        setError(messageOf(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  return (
    <section aria-label="租户管理">
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        租户
      </Typography.Title>
      <Space style={{ marginBottom: 12 }}>
        <Button
          type="primary"
          onClick={() => {
            setModalError(null);
            setOpen(true);
          }}
        >
          开户
        </Button>
      </Space>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {notice ? (
        <Alert type="success" showIcon message={notice} style={{ marginBottom: 12 }} />
      ) : null}
      <Table<TenantRow>
        rowKey="id"
        dataSource={rows}
        pagination={{
          pageSize: 10,
          showSizeChanger: true,
          pageSizeOptions: ['10', '25', '50'],
          showTotal: (total) => `共 ${total} 条记录`,
        }}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '用户名', dataIndex: 'username' },
          { title: '点数', dataIndex: 'points' },
          {
            title: '计费模式',
            render: (_value, row) => row.billingMode ?? `继承（${row.resolvedBillingMode}）`,
          },
          {
            title: '有效期',
            render: (_value, row) => formatShanghaiDate(row.expiresAt),
          },
          {
            title: '状态',
            render: (_value, row) => (row.isActive ? '正常' : '已停用'),
          },
          {
            title: '操作',
            render: (_value, row) => (
              <Space>
                <Button
                  aria-label={`编辑 ${row.name}`}
                  onClick={() => {
                    setModalError(null);
                    setEdit(row);
                    setEditName(row.name);
                    setEditExpiresAt(row.expiresAt);
                    setEditActive(row.isActive);
                  }}
                >
                  编辑
                </Button>
                <Button
                  aria-label={`加点 ${row.name}`}
                  onClick={() => {
                    setModalError(null);
                    setTarget(row);
                    setDelta('500');
                  }}
                >
                  加点
                </Button>
                <Button
                  aria-label={`配额 ${row.name}`}
                  onClick={() => {
                    setModalError(null);
                    setQuotaFor(row);
                    setQuotaKey('MAIN_KEYWORD');
                    const initial = Object.fromEntries(
                      (row.quotas ?? []).map((q) => [q.key, q.limit]),
                    );
                    setQuotaMap(initial);
                    setQuotaLimit(initial.MAIN_KEYWORD ?? '100');
                    if (client.getTenant) {
                      void client.getTenant(row.id).then(
                        (detail) => {
                          const nextMap = Object.fromEntries(
                            (detail.quotas ?? []).map((q) => [q.key, q.limit]),
                          );
                          setQuotaMap(nextMap);
                          setQuotaLimit(nextMap.MAIN_KEYWORD ?? '100');
                        },
                        () => undefined,
                      );
                    }
                  }}
                >
                  配额
                </Button>
                <Select
                  aria-label={`计费模式 ${row.name}`}
                  value={row.billingMode ?? 'inherit'}
                  style={{ width: 140 }}
                  options={[
                    { value: 'inherit', label: '继承全局' },
                    { value: 'SHADOW', label: 'SHADOW' },
                    { value: 'STRICT', label: 'STRICT' },
                  ]}
                  onChange={(value: string) => {
                    const mode = value === 'SHADOW' || value === 'STRICT' ? value : null;
                    setError(null);
                    void client.setMode(row.id, mode).then(
                      () => {
                        setNotice(
                          mode === 'SHADOW'
                            ? `${row.name} 已切到 SHADOW，已提交的任务仍按冻结单结算`
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
          setDraft({
            name: '',
            username: '',
            password: '',
            expiresAt: '2027-11-16T00:00:00.000Z',
            billingMode: null,
            initialPoints: 1000,
          });
        }}
        ok={
          <Button
            type="primary"
            aria-label="确定"
            loading={saving}
            onClick={() => {
              setSaving(true);
              setModalError(null);
              void client.createTenant(draft).then(
                () => {
                  setOpen(false);
                  setSaving(false);
                  setNotice('租户已创建');
                  return reload();
                },
                (reason: unknown) => {
                  setModalError(messageOf(reason));
                  setSaving(false);
                },
              );
            }}
          >
            确定
          </Button>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input
            aria-label="租户名称"
            placeholder="租户名称"
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
          <Input
            aria-label="登录用户名"
            placeholder="登录用户名"
            value={draft.username}
            onChange={(event) =>
              setDraft((current) => ({ ...current, username: event.target.value }))
            }
          />
          <Input.Password
            aria-label="初始密码"
            placeholder="初始密码"
            value={draft.password}
            onChange={(event) =>
              setDraft((current) => ({ ...current, password: event.target.value }))
            }
          />
          <Input
            aria-label="有效期"
            value={draft.expiresAt}
            onChange={(event) =>
              setDraft((current) => ({ ...current, expiresAt: event.target.value }))
            }
          />
          <Input
            aria-label="初始点数"
            type="number"
            min={0}
            placeholder="初始点数（默认 1000）"
            value={String(draft.initialPoints ?? 1000)}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              setDraft((current) => ({
                ...current,
                initialPoints: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
              }));
            }}
          />
        </Space>
      </CrudModal>
      <CrudModal
        open={edit !== null}
        title="编辑租户"
        minimized={false}
        maximized={false}
        error={modalError}
        onMinimize={() => undefined}
        onRestore={() => undefined}
        onMaximize={() => undefined}
        onClose={() => {
          setModalError(null);
          setEdit(null);
        }}
        onReset={() => {
          setModalError(null);
          setEditName(edit?.name ?? '');
          setEditExpiresAt(edit?.expiresAt ?? '');
          setEditActive(edit?.isActive ?? true);
        }}
        ok={
          <Button
            type="primary"
            aria-label="保存租户"
            onClick={() => {
              if (!edit) return;
              if (!editName.trim()) {
                setModalError('租户名称不能为空');
                return;
              }
              setModalError(null);
              void client
                .updateTenant(edit.id, {
                  name: editName.trim(),
                  expiresAt: editExpiresAt.trim() || undefined,
                  isActive: editActive,
                })
                .then(
                  () => {
                    setNotice('租户已更新');
                    setEdit(null);
                    return reload();
                  },
                  (reason: unknown) => setModalError(messageOf(reason)),
                );
            }}
          >
            保存租户
          </Button>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input
            aria-label="租户名称"
            value={editName}
            onChange={(event) => setEditName(event.target.value)}
          />
          <Input
            aria-label="租户有效期"
            placeholder="ISO 时间，如 2027-11-16T00:00:00.000Z"
            value={editExpiresAt}
            onChange={(event) => setEditExpiresAt(event.target.value)}
          />
          <Space>
            <span>启用状态</span>
            <Switch aria-label="启用状态" checked={editActive} onChange={setEditActive} />
          </Space>
        </Space>
      </CrudModal>
      <CrudModal
        open={target !== null}
        title="加点"
        minimized={false}
        maximized={false}
        error={modalError}
        onMinimize={() => undefined}
        onRestore={() => undefined}
        onMaximize={() => undefined}
        onClose={() => {
          setModalError(null);
          setTarget(null);
        }}
        onReset={() => {
          setModalError(null);
          setDelta('500');
        }}
        ok={
          <Button
            type="primary"
            aria-label="确认加点"
            onClick={() => {
              if (!target) return;
              if (!/^-?\d+$/.test(delta) || Number(delta) === 0) {
                setModalError('调整点数不正确');
                return;
              }
              setModalError(null);
              void client.adjust(target.id, Number(delta)).then(
                () => {
                  const amount = Number(delta);
                  setNotice(amount > 0 ? `+${amount} 管理员充值` : `${amount} 管理员扣点`);
                  setTarget(null);
                  return reload();
                },
                (reason: unknown) => setModalError(messageOf(reason)),
              );
            }}
          >
            确认加点
          </Button>
        }
      >
        <Input
          aria-label="调整点数"
          value={delta}
          onChange={(event) => setDelta(event.target.value)}
        />
      </CrudModal>
      <CrudModal
        open={quotaFor !== null}
        title="配额上限"
        minimized={false}
        maximized={false}
        error={modalError}
        onMinimize={() => undefined}
        onRestore={() => undefined}
        onMaximize={() => undefined}
        onClose={() => {
          setModalError(null);
          setQuotaFor(null);
        }}
        onReset={() => {
          setModalError(null);
          setQuotaLimit(quotaMap[quotaKey] ?? '100');
        }}
        ok={
          <Button
            type="primary"
            aria-label="保存配额"
            onClick={() => {
              if (!quotaFor) return;
              if (!/^[0-9]{1,15}$/.test(quotaLimit)) {
                setModalError('配额上限不正确');
                return;
              }
              setModalError(null);
              void client
                .updateQuotas(quotaFor.id, {
                  items: [{ key: quotaKey, limit: quotaLimit }],
                })
                .then(
                  () => {
                    setNotice('配额已更新');
                    setQuotaFor(null);
                    return reload();
                  },
                  (reason: unknown) => setModalError(messageOf(reason)),
                );
            }}
          >
            保存配额
          </Button>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select
            aria-label="配额项"
            value={quotaKey}
            style={{ width: '100%' }}
            options={QUOTA_FIELDS.map(([value, label]) => ({ value, label }))}
            onChange={(nextKey: QuotaKeyName) => {
              setQuotaKey(nextKey);
              setQuotaLimit(quotaMap[nextKey] ?? '100');
            }}
          />
          <Input
            aria-label="配额上限"
            value={quotaLimit}
            onChange={(event) => setQuotaLimit(event.target.value)}
          />
        </Space>
      </CrudModal>
      <p className="gm-admin-note">
        配额项包括{QUOTA_FIELDS.map((item) => item[1]).join('、')}
        。修改配额上限不能低于当前已用量。
      </p>
    </section>
  );
}

function messageOf(reason: unknown): string {
  if (reason instanceof AdminApiError) return reason.message;
  return '操作失败';
}
