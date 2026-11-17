'use client';

import { formatLedgerTime, type PointListQuery } from '@geomix/shared';
import { Alert, Button, Input, Table, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  AccountApiError,
  httpDownloadPoints,
  httpPoints,
  type LedgerPage,
  type PointItem,
} from '../../lib/account-client';

const EMPTY: PointListQuery = {
  page: 1,
  pageSize: 10,
  sort: 'createdAt',
  order: 'desc',
  title: '',
  delta: undefined,
  from: undefined,
  to: undefined,
  export: undefined,
};

function triggerDownload(file: { filename: string; mime: string; body: Uint8Array }): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const copy = new Uint8Array(file.body.byteLength);
  copy.set(file.body);
  const blob = new Blob([copy], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function PointsScreen({
  title,
  load,
  exportFile,
}: {
  title: string;
  load?: (query: PointListQuery) => Promise<LedgerPage<PointItem>>;
  exportFile?: (
    query: PointListQuery,
    format: 'csv' | 'xlsx',
  ) => Promise<{ filename: string; mime: string; body: Uint8Array }>;
}) {
  const fallback = useMemo(
    () => (query: PointListQuery) => httpPoints(window.sessionStorage, query),
    [],
  );
  const fallbackExport = useMemo(
    () => (query: PointListQuery, format: 'csv' | 'xlsx') =>
      httpDownloadPoints(window.sessionStorage, query, format),
    [],
  );
  const read = load ?? fallback;
  const download = exportFile ?? fallbackExport;
  const [query, setQuery] = useState<PointListQuery>(EMPTY);
  const [draft, setDraft] = useState({ title: '', delta: '', from: '', to: '' });
  const [page, setPage] = useState<LedgerPage<PointItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void read(query).then(
      (next) => {
        if (!live) return;
        setPage(next);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!live) return;
        setError(reason instanceof AccountApiError ? reason.message : '无法加载点数明细');
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [read, query]);

  async function handleExport(format: 'csv' | 'xlsx'): Promise<void> {
    setExporting(true);
    setError(null);
    try {
      const file = await download(query, format);
      triggerDownload(file);
    } catch (reason) {
      setError(reason instanceof AccountApiError ? reason.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }

  return (
    <section aria-label="点数明细">
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      <div className="gm-ledger-filter">
        <Input
          aria-label="项目名称"
          placeholder="项目名称"
          value={draft.title}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
        />
        <Input
          aria-label="点数变动"
          placeholder="点数变动"
          value={draft.delta}
          onChange={(event) => setDraft((current) => ({ ...current, delta: event.target.value }))}
        />
        <Input
          aria-label="开始时间"
          type="datetime-local"
          value={draft.from}
          onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
        />
        <Input
          aria-label="结束时间"
          type="datetime-local"
          value={draft.to}
          onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
        />
        <Button
          type="primary"
          aria-label="查询"
          onClick={() => {
            const delta = draft.delta.trim();
            if (delta !== '' && !/^-?\d+$/.test(delta)) {
              setError('点数变动不正确');
              return;
            }
            const fromIso = draft.from ? new Date(draft.from).toISOString() : undefined;
            const toIso = draft.to ? new Date(draft.to).toISOString() : undefined;
            if (fromIso && toIso && fromIso > toIso) {
              setError('开始时间不能晚于结束时间');
              return;
            }
            setError(null);
            setQuery({
              ...EMPTY,
              title: draft.title.trim(),
              delta: delta === '' ? undefined : Number(delta),
              from: fromIso,
              to: toIso,
            });
          }}
        >
          查询
        </Button>
        <Button
          aria-label="重置"
          onClick={() => {
            setError(null);
            setDraft({ title: '', delta: '', from: '', to: '' });
            setQuery(EMPTY);
          }}
        >
          重置
        </Button>
        <Button aria-label="导出 CSV" loading={exporting} onClick={() => void handleExport('csv')}>
          导出 CSV
        </Button>
        <Button
          aria-label="导出 XLSX"
          loading={exporting}
          onClick={() => void handleExport('xlsx')}
        >
          导出 XLSX
        </Button>
      </div>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      <Table<PointItem>
        rowKey="id"
        loading={loading}
        dataSource={page?.items ?? []}
        locale={{ emptyText: '没有找到匹配的记录' }}
        pagination={{
          current: page?.page ?? 1,
          pageSize: page?.pageSize ?? 10,
          total: page?.total ?? 0,
          showSizeChanger: false,
          onChange: (next) => setQuery((current) => ({ ...current, page: next })),
        }}
        columns={[
          { title: '项目', dataIndex: 'title', key: 'title' },
          {
            title: '点数',
            key: 'points',
            render: (_value, row) => (
              <div>
                <div>{row.pointsText}</div>
                <div>{row.phrase}</div>
              </div>
            ),
          },
          {
            title: '消耗时间',
            key: 'createdAt',
            render: (_value, row) => formatLedgerTime(row.createdAt),
          },
        ]}
      />
    </section>
  );
}
