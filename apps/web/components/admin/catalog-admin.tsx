'use client';

import { formatAdminDateTime, getPricingActionMeta } from '@geomix/shared';
import { Alert, Button, Input, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import {
  AdminApiError,
  type AdminClient,
  type AnnouncementRow,
  type PriceRow,
  type TemplateRow,
} from '../../lib/admin-client';
import { CrudModal } from '../crud/crud-modal';

type PriceDraft = {
  unitPoints: string;
  enabled: boolean;
};

function toPriceDrafts(items: PriceRow[]): Record<string, PriceDraft> {
  return Object.fromEntries(
    items.map((item) => [
      item.action,
      { unitPoints: String(item.unitPoints), enabled: item.enabled },
    ]),
  );
}

export function PricingAdmin({
  client,
}: {
  client: Pick<AdminClient, 'listPrices' | 'updatePrice'> &
    Partial<Pick<AdminClient, 'updatePrices'>>;
}) {
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, PriceDraft>>({});
  const [savingBatch, setSavingBatch] = useState(false);
  const [savingAction, setSavingAction] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void client.listPrices().then(
      (items) => {
        if (!live) return;
        setRows(items);
        setDrafts(toPriceDrafts(items));
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

  const isRowDirty = (row: PriceRow): boolean => {
    const draft = drafts[row.action];
    if (!draft) return false;
    return draft.unitPoints !== String(row.unitPoints) || draft.enabled !== row.enabled;
  };

  const dirtyRows = rows.filter(isRowDirty);
  const hasUnsaved = dirtyRows.length > 0;

  const parseDraftPoints = (row: PriceRow): number | null => {
    const raw = drafts[row.action]?.unitPoints ?? '';
    const trimmed = raw.trim();
    if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
    const num = Number(trimmed);
    if (!Number.isSafeInteger(num) || num < 1 || num > 1_000_000) return null;
    return num;
  };

  const handleBatchSave = async () => {
    if (dirtyRows.length === 0) return;
    const updates: Array<{ action: string; unitPoints: number; enabled: boolean }> = [];
    for (const row of dirtyRows) {
      const meta = getPricingActionMeta(row.action);
      const label = row.label ?? meta.label;
      const unitPoints = parseDraftPoints(row);
      if (unitPoints === null) {
        setNotice(null);
        setError(`${label} 价格不正确（请填写 1 ~ 1000000 的整数）`);
        return;
      }
      updates.push({
        action: row.action,
        unitPoints,
        enabled: drafts[row.action]?.enabled ?? row.enabled,
      });
    }

    setError(null);
    setNotice(null);
    setSavingBatch(true);
    try {
      let nextItems: PriceRow[] = rows;
      if (client.updatePrices) {
        const res = await client.updatePrices({ items: updates });
        nextItems = res.items;
      } else {
        for (const item of updates) {
          const res = await client.updatePrice(item);
          nextItems = res.items;
        }
      }
      setRows(nextItems);
      setDrafts(toPriceDrafts(nextItems));
      setNotice(`已批量保存 ${updates.length} 项价格配置`);
    } catch (reason: unknown) {
      setError(messageOf(reason));
    } finally {
      setSavingBatch(false);
    }
  };

  const handleSingleSave = async (row: PriceRow) => {
    const meta = getPricingActionMeta(row.action);
    const label = row.label ?? meta.label;
    const unitPoints = parseDraftPoints(row);
    if (unitPoints === null) {
      setNotice(null);
      setError(`${label} 价格不正确（请填写 1 ~ 1000000 的整数）`);
      return;
    }
    const enabled = drafts[row.action]?.enabled ?? row.enabled;
    setError(null);
    setNotice(null);
    setSavingAction(row.action);
    try {
      const next = await client.updatePrice({ action: row.action, unitPoints, enabled });
      setRows(next.items);
      setDrafts(toPriceDrafts(next.items));
      setNotice(`已保存「${label}」价格配置`);
    } catch (reason: unknown) {
      setError(messageOf(reason));
    } finally {
      setSavingAction(null);
    }
  };

  return (
    <section aria-label="价格">
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
          价格管理
        </Typography.Title>
        <Space wrap>
          {hasUnsaved ? (
            <Tag color="warning">有 {dirtyRows.length} 项未保存修改</Tag>
          ) : (
            <Tag>全部已保存</Tag>
          )}
          <Button
            disabled={!hasUnsaved || savingBatch || savingAction !== null}
            onClick={() => {
              setError(null);
              setNotice(null);
              setDrafts(toPriceDrafts(rows));
            }}
          >
            重置修改
          </Button>
          <Button
            type="primary"
            loading={savingBatch}
            disabled={!hasUnsaved || savingAction !== null}
            onClick={() => void handleBatchSave()}
          >
            {hasUnsaved ? `批量保存 (${dirtyRows.length})` : '批量保存'}
          </Button>
        </Space>
      </div>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {notice ? (
        <Alert type="success" showIcon message={notice} style={{ marginBottom: 12 }} />
      ) : null}
      <Table<PriceRow>
        rowKey="action"
        dataSource={rows}
        pagination={false}
        columns={[
          {
            title: '项目',
            render: (_value, row) => {
              const meta = getPricingActionMeta(row.action);
              const label = row.label ?? meta.label;
              const unit = row.unit ?? meta.unit;
              return (
                <Space size={6} wrap>
                  <Typography.Text strong>{`${label}（${unit}）`}</Typography.Text>
                  {isRowDirty(row) ? <Tag color="warning">未保存</Tag> : null}
                </Space>
              );
            },
          },
          {
            title: '业务说明',
            render: (_value, row) => {
              const meta = getPricingActionMeta(row.action);
              return (
                <Typography.Text type="secondary">
                  {row.description ?? meta.description}
                </Typography.Text>
              );
            },
          },
          {
            title: '计费单位',
            render: (_value, row) => {
              const meta = getPricingActionMeta(row.action);
              return <Tag>{row.unit ?? meta.unit}</Tag>;
            },
          },
          {
            title: '点数',
            render: (_value, row) => {
              const meta = getPricingActionMeta(row.action);
              const label = row.label ?? meta.label;
              const unit = row.unit ?? meta.unit;
              return (
                <Input
                  aria-label={`${label} 点数`}
                  style={{ width: 150 }}
                  suffix={unit}
                  value={drafts[row.action]?.unitPoints ?? ''}
                  onChange={(event) => {
                    setError(null);
                    setNotice(null);
                    const value = event.target.value;
                    setDrafts((current) => ({
                      ...current,
                      [row.action]: {
                        unitPoints: value,
                        enabled: current[row.action]?.enabled ?? row.enabled,
                      },
                    }));
                  }}
                />
              );
            },
          },
          {
            title: '启用',
            render: (_value, row) => {
              const meta = getPricingActionMeta(row.action);
              const label = row.label ?? meta.label;
              const checked = drafts[row.action]?.enabled ?? row.enabled;
              return (
                <Switch
                  aria-label={`${label} 启用`}
                  checked={checked}
                  onChange={(enabled) => {
                    setError(null);
                    setNotice(null);
                    setDrafts((current) => ({
                      ...current,
                      [row.action]: {
                        unitPoints: current[row.action]?.unitPoints ?? String(row.unitPoints),
                        enabled,
                      },
                    }));
                  }}
                />
              );
            },
          },
          {
            title: '操作',
            render: (_value, row) => {
              const meta = getPricingActionMeta(row.action);
              const label = row.label ?? meta.label;
              return (
                <Button
                  aria-label={`保存 ${label}`}
                  loading={savingAction === row.action}
                  disabled={!isRowDirty(row) || savingBatch}
                  onClick={() => void handleSingleSave(row)}
                >
                  保存
                </Button>
              );
            },
          },
        ]}
      />
    </section>
  );
}

export function AnnouncementAdmin({
  client,
}: {
  client: Pick<
    AdminClient,
    'listAnnouncements' | 'createAnnouncement' | 'updateAnnouncement' | 'deleteAnnouncement'
  >;
}) {
  const [rows, setRows] = useState<AnnouncementRow[]>([]);
  const [content, setContent] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<AnnouncementRow | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editEnabled, setEditEnabled] = useState(true);
  const [editSort, setEditSort] = useState('0');
  const [editSaving, setEditSaving] = useState(false);
  const [editModalError, setEditModalError] = useState<string | null>(null);

  const [deletingTarget, setDeletingTarget] = useState<AnnouncementRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let live = true;
    void client.listAnnouncements().then(
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

  const handlePublish = async () => {
    const trimmed = content.trim();
    if (!trimmed) {
      setNotice(null);
      setError('请填写公告');
      return;
    }
    setError(null);
    setNotice(null);
    setPublishing(true);
    try {
      const row = await client.createAnnouncement({
        content: trimmed,
        enabled: true,
        sort: rows.length,
      });
      setRows((current) => [...current, row]);
      setContent('');
      setNotice('公告已发布');
    } catch (reason: unknown) {
      setError(messageOf(reason));
    } finally {
      setPublishing(false);
    }
  };

  const openEditModal = (row: AnnouncementRow) => {
    setEditModalError(null);
    setEditing(row);
    setEditContent(row.content);
    setEditEnabled(row.enabled);
    setEditSort(String(row.sort));
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    const trimmed = editContent.trim();
    if (!trimmed) {
      setEditModalError('请填写公告');
      return;
    }
    const sortNum = Number(editSort.trim());
    if (!/^[0-9]+$/.test(editSort.trim()) || !Number.isSafeInteger(sortNum) || sortNum > 9999) {
      setEditModalError('排序权重需为 0 ~ 9999 的整数');
      return;
    }
    setEditModalError(null);
    setError(null);
    setNotice(null);
    setEditSaving(true);
    try {
      const updated = await client.updateAnnouncement(editing.id, {
        content: trimmed,
        enabled: editEnabled,
        sort: sortNum,
      });
      setRows((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setEditing(null);
      setNotice('公告已更新');
    } catch (reason: unknown) {
      setEditModalError(messageOf(reason));
    } finally {
      setEditSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingTarget) return;
    setError(null);
    setNotice(null);
    setDeleting(true);
    try {
      await client.deleteAnnouncement(deletingTarget.id);
      const removedId = deletingTarget.id;
      setRows((current) => current.filter((item) => item.id !== removedId));
      setDeletingTarget(null);
      setNotice('公告已删除');
    } catch (reason: unknown) {
      setDeletingTarget(null);
      setError(messageOf(reason));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section aria-label="公告">
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        公告管理
      </Typography.Title>
      <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
        <Input
          aria-label="公告内容"
          value={content}
          maxLength={200}
          placeholder="写一条 GeoMix 公告"
          onChange={(event) => setContent(event.target.value)}
        />
        <Button type="primary" loading={publishing} onClick={() => void handlePublish()}>
          发布
        </Button>
      </Space.Compact>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {notice ? (
        <Alert type="success" showIcon message={notice} style={{ marginBottom: 12 }} />
      ) : null}
      <Table<AnnouncementRow>
        rowKey="id"
        dataSource={rows}
        pagination={false}
        columns={[
          { title: '内容', dataIndex: 'content' },
          {
            title: '启用',
            render: (_value, row) => (
              <Switch
                aria-label={`启用 ${row.content}`}
                checked={row.enabled}
                onChange={(enabled) => {
                  setError(null);
                  setNotice(null);
                  void client
                    .updateAnnouncement(row.id, { content: row.content, enabled, sort: row.sort })
                    .then(
                      (next) => {
                        setRows((current) =>
                          current.map((item) => (item.id === next.id ? next : item)),
                        );
                        setNotice(enabled ? '公告已启用' : '公告已停用');
                      },
                      (reason: unknown) => setError(messageOf(reason)),
                    );
                }}
              />
            ),
          },
          {
            title: '创建时间',
            render: (_value, row) => formatAdminDateTime(row.createdAt),
          },
          {
            title: '操作人',
            render: (_value, row) => row.operatorName?.trim() || '—',
          },
          {
            title: '操作',
            render: (_value, row) => (
              <Space>
                <Button aria-label={`编辑 ${row.content}`} onClick={() => openEditModal(row)}>
                  编辑
                </Button>
                <Button
                  danger
                  aria-label={`删除 ${row.content}`}
                  onClick={() => setDeletingTarget(row)}
                >
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={editing !== null}
        title="编辑公告"
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        okButtonProps={{ loading: editSaving }}
        onCancel={() => {
          if (!editSaving) {
            setEditing(null);
            setEditModalError(null);
          }
        }}
        onOk={() => void handleSaveEdit()}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {editModalError ? <Alert type="error" showIcon message={editModalError} /> : null}
          <Input.TextArea
            aria-label="编辑公告内容"
            rows={3}
            maxLength={200}
            value={editContent}
            onChange={(event) => setEditContent(event.target.value)}
          />
          <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
            <Space>
              <span>启用状态</span>
              <Switch aria-label="编辑公告启用" checked={editEnabled} onChange={setEditEnabled} />
            </Space>
            <Space>
              <Typography.Text>排序权重</Typography.Text>
              <Input
                aria-label="编辑公告排序"
                style={{ width: 100 }}
                value={editSort}
                onChange={(event) => setEditSort(event.target.value)}
              />
            </Space>
          </Space>
        </Space>
      </Modal>

      <Modal
        open={deletingTarget !== null}
        title="确认删除公告"
        okText="确认删除"
        cancelText="取消"
        destroyOnHidden
        okButtonProps={{ danger: true, loading: deleting }}
        onCancel={() => {
          if (!deleting) setDeletingTarget(null);
        }}
        onOk={() => void handleConfirmDelete()}
      >
        <p>确定要删除公告「{deletingTarget?.content}」吗？删除后将无法恢复，且不再在用户端展示。</p>
      </Modal>
    </section>
  );
}

const TEMPLATE_KINDS: Array<{ value: TemplateRow['kind']; label: string }> = [
  { value: 'ARTICLE', label: '文章模板 (ARTICLE)' },
  { value: 'TITLE', label: '标题模板 (TITLE)' },
  { value: 'REWRITE', label: '复刻模板 (REWRITE)' },
];

export function TemplateAdmin({
  client,
}: {
  client: Pick<AdminClient, 'listTemplates' | 'createTemplate' | 'updateTemplate'>;
}) {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [kind, setKind] = useState<TemplateRow['kind']>('ARTICLE');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [randomPool, setRandomPool] = useState(true);
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [editKind, setEditKind] = useState<TemplateRow['kind']>('ARTICLE');
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editRandomPool, setEditRandomPool] = useState(true);
  const [modalError, setModalError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void client.listTemplates().then(
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
    <section aria-label="系统模板">
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        系统模板
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        这里只管理系统模板。正文请自行编写，不要粘贴外部站点的模板原文。
      </Typography.Paragraph>
      <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }}>
        <Space wrap>
          <Select
            aria-label="模板类型"
            value={kind}
            style={{ width: 200 }}
            options={TEMPLATE_KINDS}
            onChange={(value: TemplateRow['kind']) => setKind(value)}
          />
          <Space>
            <span>随机池</span>
            <Switch aria-label="随机池" checked={randomPool} onChange={setRandomPool} />
          </Space>
        </Space>
        <Input
          aria-label="模板名称"
          placeholder="模板名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Input.TextArea
          aria-label="模板正文"
          rows={4}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
        <Button
          type="primary"
          onClick={() => {
            setError(null);
            void client
              .createTemplate({
                kind,
                name,
                content,
                randomPool,
                sort: rows.length + 1,
              })
              .then(
                (row) => {
                  setError(null);
                  setRows((current) => [...current, row]);
                  setName('');
                  setContent('');
                },
                (reason: unknown) => setError(messageOf(reason)),
              );
          }}
        >
          新增模板
        </Button>
      </Space>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <Table<TemplateRow>
        rowKey="id"
        dataSource={rows}
        pagination={false}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '类型', dataIndex: 'kind' },
          {
            title: '随机池',
            render: (_value, row) => (row.randomPool ? '是' : '否'),
          },
          {
            title: '操作',
            render: (_value, row) => (
              <Button
                aria-label={`编辑模板 ${row.name}`}
                onClick={() => {
                  setModalError(null);
                  setEditing(row);
                  setEditKind(row.kind);
                  setEditName(row.name);
                  setEditContent(row.content);
                  setEditRandomPool(row.randomPool);
                }}
              >
                编辑
              </Button>
            ),
          },
        ]}
      />
      <CrudModal
        open={editing !== null}
        title="编辑模板"
        minimized={false}
        maximized={false}
        error={modalError}
        onMinimize={() => undefined}
        onRestore={() => undefined}
        onMaximize={() => undefined}
        onClose={() => {
          setModalError(null);
          setEditing(null);
        }}
        onReset={() => {
          setModalError(null);
          if (!editing) return;
          setEditKind(editing.kind);
          setEditName(editing.name);
          setEditContent(editing.content);
          setEditRandomPool(editing.randomPool);
        }}
        ok={
          <Button
            type="primary"
            aria-label="保存模板"
            onClick={() => {
              if (!editing) return;
              setModalError(null);
              void client
                .updateTemplate(editing.id, {
                  kind: editKind,
                  name: editName,
                  content: editContent,
                  randomPool: editRandomPool,
                  sort: editing.sort,
                })
                .then(
                  (updated) => {
                    setRows((current) =>
                      current.map((item) => (item.id === updated.id ? updated : item)),
                    );
                    setEditing(null);
                  },
                  (reason: unknown) => setModalError(messageOf(reason)),
                );
            }}
          >
            保存模板
          </Button>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <Select
              aria-label="编辑模板类型"
              value={editKind}
              style={{ width: 200 }}
              options={TEMPLATE_KINDS}
              onChange={(value: TemplateRow['kind']) => setEditKind(value)}
            />
            <Space>
              <span>随机池</span>
              <Switch
                aria-label="编辑随机池"
                checked={editRandomPool}
                onChange={setEditRandomPool}
              />
            </Space>
          </Space>
          <Input
            aria-label="编辑模板名称"
            value={editName}
            onChange={(event) => setEditName(event.target.value)}
          />
          <Input.TextArea
            aria-label="编辑模板正文"
            rows={4}
            value={editContent}
            onChange={(event) => setEditContent(event.target.value)}
          />
        </Space>
      </CrudModal>
    </section>
  );
}

function messageOf(reason: unknown): string {
  if (reason instanceof AdminApiError) return reason.message;
  return '操作失败';
}
