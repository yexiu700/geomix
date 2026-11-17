'use client';

import { Alert, Button, Input, Select, Space, Switch, Table, Typography } from 'antd';
import { useEffect, useState } from 'react';
import {
  AdminApiError,
  type AdminClient,
  type AnnouncementRow,
  type PriceRow,
  type TemplateRow,
} from '../../lib/admin-client';
import { CrudModal } from '../crud/crud-modal';

export function PricingAdmin({
  client,
}: {
  client: Pick<AdminClient, 'listPrices' | 'updatePrice'>;
}) {
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    void client.listPrices().then(
      (items) => {
        if (!live) return;
        setRows(items);
        setDrafts(Object.fromEntries(items.map((item) => [item.action, String(item.unitPoints)])));
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
    <section aria-label="价格">
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        价格
      </Typography.Title>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <Table<PriceRow>
        rowKey="action"
        dataSource={rows}
        pagination={false}
        columns={[
          { title: '项目', dataIndex: 'action' },
          {
            title: '点数',
            render: (_value, row) => (
              <Input
                aria-label={`${row.action} 点数`}
                value={drafts[row.action] ?? ''}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [row.action]: event.target.value }))
                }
              />
            ),
          },
          {
            title: '启用',
            render: (_value, row) => (
              <Switch
                aria-label={`${row.action} 启用`}
                checked={row.enabled}
                onChange={(enabled) => {
                  const parsed = Number(drafts[row.action] ?? row.unitPoints);
                  const unitPoints =
                    Number.isInteger(parsed) && parsed >= 1 ? parsed : row.unitPoints;
                  setError(null);
                  void client.updatePrice({ action: row.action, unitPoints, enabled }).then(
                    (next) => {
                      setError(null);
                      setRows(next.items);
                    },
                    (reason: unknown) => setError(messageOf(reason)),
                  );
                }}
              />
            ),
          },
          {
            title: '操作',
            render: (_value, row) => (
              <Button
                onClick={() => {
                  const unitPoints = Number(drafts[row.action]);
                  if (!Number.isInteger(unitPoints) || unitPoints < 1) {
                    setError('价格不正确');
                    return;
                  }
                  setError(null);
                  void client
                    .updatePrice({ action: row.action, unitPoints, enabled: row.enabled })
                    .then(
                      (next) => {
                        setError(null);
                        setRows(next.items);
                      },
                      (reason: unknown) => setError(messageOf(reason)),
                    );
                }}
              >
                保存
              </Button>
            ),
          },
        ]}
      />
    </section>
  );
}

export function AnnouncementAdmin({
  client,
}: {
  client: Pick<AdminClient, 'listAnnouncements' | 'createAnnouncement' | 'updateAnnouncement'>;
}) {
  const [rows, setRows] = useState<AnnouncementRow[]>([]);
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section aria-label="公告">
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        公告
      </Typography.Title>
      <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
        <Input
          aria-label="公告内容"
          value={content}
          placeholder="写一条 GeoMix 公告"
          onChange={(event) => setContent(event.target.value)}
        />
        <Button
          type="primary"
          onClick={() => {
            setError(null);
            void client.createAnnouncement({ content, enabled: true, sort: rows.length }).then(
              (row) => {
                setError(null);
                setRows((current) => [...current, row]);
                setContent('');
              },
              (reason: unknown) => setError(messageOf(reason)),
            );
          }}
        >
          发布
        </Button>
      </Space.Compact>
      {error ? <Alert type="error" showIcon message={error} /> : null}
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
                  void client
                    .updateAnnouncement(row.id, { content: row.content, enabled, sort: row.sort })
                    .then(
                      (next) =>
                        setRows((current) =>
                          current.map((item) => (item.id === next.id ? next : item)),
                        ),
                      (reason: unknown) => setError(messageOf(reason)),
                    );
                }}
              />
            ),
          },
        ]}
      />
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
