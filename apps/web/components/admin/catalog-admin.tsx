'use client';

import { Alert, Button, Input, Space, Switch, Table, Typography } from 'antd';
import { useEffect, useState } from 'react';
import {
  AdminApiError,
  type AdminClient,
  type AnnouncementRow,
  type PriceRow,
  type TemplateRow,
} from '../../lib/admin-client';

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
                  const unitPoints = Number(drafts[row.action] ?? row.unitPoints);
                  void client.updatePrice({ action: row.action, unitPoints, enabled }).then(
                    (next) => setRows(next.items),
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
                  void client
                    .updatePrice({ action: row.action, unitPoints, enabled: row.enabled })
                    .then(
                      (next) => setRows(next.items),
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
            void client.createAnnouncement({ content, enabled: true, sort: rows.length }).then(
              (row) => {
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

export function TemplateAdmin({
  client,
}: {
  client: Pick<AdminClient, 'listTemplates' | 'createTemplate' | 'updateTemplate'>;
}) {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
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
            void client
              .createTemplate({
                kind: 'ARTICLE',
                name,
                content,
                randomPool: true,
                sort: rows.length + 1,
              })
              .then(
                (row) => {
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
        ]}
      />
    </section>
  );
}

function messageOf(reason: unknown): string {
  if (reason instanceof AdminApiError) return reason.message;
  return '操作失败';
}
