'use client';

import type { CreateTenantInput } from '@geomix/shared';
import { Alert, Button, Input, Select, Space, Table, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { AdminApiError, type AdminClient, type TenantRow } from '../../lib/admin-client';
import { CrudModal } from '../crud/crud-modal';

const QUOTA_FIELDS = [
  ['MAIN_KEYWORD', '主关键词'],
  ['QUESTION', '写作问题'],
  ['AI_WRITE', 'AI写作数量'],
  ['STORAGE_BYTES', '图片存储空间'],
  ['PUBLISH', '文章发布'],
  ['SOCIAL_AUTH', '自媒体授权'],
] as const;

export function TenantAdmin({
  client,
}: {
  client: Pick<
    AdminClient,
    'listTenants' | 'createTenant' | 'updateTenant' | 'updateQuotas' | 'adjust' | 'setMode'
  >;
}) {
  const [rows, setRows] = useState<TenantRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [target, setTarget] = useState<TenantRow | null>(null);
  const [edit, setEdit] = useState<TenantRow | null>(null);
  const [editName, setEditName] = useState('');
  const [quotaFor, setQuotaFor] = useState<TenantRow | null>(null);
  const [quotaLimit, setQuotaLimit] = useState('100');
  const [delta, setDelta] = useState('500');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<CreateTenantInput>({
    name: '',
    username: '',
    password: '',
    expiresAt: '2027-11-16T00:00:00.000Z',
    billingMode: null,
    initialPoints: 0,
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
        <Button type="primary" onClick={() => setOpen(true)}>
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
        pagination={false}
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
            render: (_value, row) => row.expiresAt.slice(0, 10),
          },
          {
            title: '操作',
            render: (_value, row) => (
              <Space>
                <Button
                  aria-label={`编辑 ${row.name}`}
                  onClick={() => {
                    setEdit(row);
                    setEditName(row.name);
                  }}
                >
                  编辑
                </Button>
                <Button
                  aria-label={`加点 ${row.name}`}
                  onClick={() => {
                    setTarget(row);
                    setDelta('500');
                  }}
                >
                  加点
                </Button>
                <Button
                  aria-label={`配额 ${row.name}`}
                  onClick={() => {
                    setQuotaFor(row);
                    setQuotaLimit('100');
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
        error={error}
        onMinimize={() => setMinimized(true)}
        onRestore={() => setMinimized(false)}
        onMaximize={() => setMaximized((value) => !value)}
        onClose={() => setOpen(false)}
        onReset={() =>
          setDraft({
            name: '',
            username: '',
            password: '',
            expiresAt: '2027-11-16T00:00:00.000Z',
            billingMode: null,
            initialPoints: 0,
          })
        }
        ok={
          <Button
            type="primary"
            aria-label="确定"
            loading={saving}
            onClick={() => {
              setSaving(true);
              void client.createTenant(draft).then(
                () => {
                  setOpen(false);
                  setSaving(false);
                  setNotice('租户已创建');
                  return reload();
                },
                (reason: unknown) => {
                  setError(messageOf(reason));
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
        </Space>
      </CrudModal>
      <CrudModal
        open={edit !== null}
        title="编辑租户"
        minimized={false}
        maximized={false}
        onMinimize={() => undefined}
        onRestore={() => undefined}
        onMaximize={() => undefined}
        onClose={() => setEdit(null)}
        onReset={() => setEditName(edit?.name ?? '')}
        ok={
          <Button
            type="primary"
            aria-label="保存租户"
            onClick={() => {
              if (!edit) return;
              void client.updateTenant(edit.id, { name: editName.trim() }).then(
                () => {
                  setNotice('租户已更新');
                  setEdit(null);
                  return reload();
                },
                (reason: unknown) => setError(messageOf(reason)),
              );
            }}
          >
            保存租户
          </Button>
        }
      >
        <Input
          aria-label="租户名称"
          value={editName}
          onChange={(event) => setEditName(event.target.value)}
        />
      </CrudModal>
      <CrudModal
        open={target !== null}
        title="加点"
        minimized={false}
        maximized={false}
        onMinimize={() => undefined}
        onRestore={() => undefined}
        onMaximize={() => undefined}
        onClose={() => setTarget(null)}
        onReset={() => setDelta('500')}
        ok={
          <Button
            type="primary"
            aria-label="确认加点"
            onClick={() => {
              if (!target) return;
              if (!/^-?\d+$/.test(delta) || Number(delta) === 0) {
                setError('调整点数不正确');
                return;
              }
              void client.adjust(target.id, Number(delta)).then(
                () => {
                  const amount = Number(delta);
                  setNotice(amount > 0 ? `+${amount} 管理员充值` : `${amount} 管理员扣点`);
                  setTarget(null);
                  return reload();
                },
                (reason: unknown) => setError(messageOf(reason)),
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
        onMinimize={() => undefined}
        onRestore={() => undefined}
        onMaximize={() => undefined}
        onClose={() => setQuotaFor(null)}
        onReset={() => setQuotaLimit('100')}
        ok={
          <Button
            type="primary"
            aria-label="保存配额"
            onClick={() => {
              if (!quotaFor) return;
              if (!/^[0-9]{1,15}$/.test(quotaLimit)) {
                setError('配额上限不正确');
                return;
              }
              void client
                .updateQuotas(quotaFor.id, {
                  items: [{ key: 'MAIN_KEYWORD', limit: quotaLimit }],
                })
                .then(
                  () => {
                    setNotice('配额已更新');
                    setQuotaFor(null);
                    return reload();
                  },
                  (reason: unknown) => setError(messageOf(reason)),
                );
            }}
          >
            保存配额
          </Button>
        }
      >
        <Input
          aria-label="主关键词上限"
          value={quotaLimit}
          onChange={(event) => setQuotaLimit(event.target.value)}
        />
      </CrudModal>
      <p className="gm-admin-note">
        配额项包括{QUOTA_FIELDS.map((item) => item[1]).join('、')}
        。这里修改主关键词上限，不能低于已用量。
      </p>
    </section>
  );
}

function messageOf(reason: unknown): string {
  if (reason instanceof AdminApiError) return reason.message;
  return '操作失败';
}
