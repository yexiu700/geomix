'use client';

import { formatCountNumber, sanitizeLedgerTitle, type PointListQuery } from '@geomix/shared';
import { Alert, Button, Input, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccountApiError,
  httpDownloadPoints,
  httpPoints,
  httpRights,
  type LedgerPage,
  type PointItem,
  type RightsView,
} from '../../lib/account-client';
import { formatShanghaiDateTime, triggerBlobDownload, UX_TERMS } from '../../lib/ux-foundation';
import { ExportAction } from '../crud/export-action';
import { TableClampText } from '../crud/table-clamp-text';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalSkeleton } from '../geo/primitives';

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

function parseDatetimeInput(value: string): { iso?: string; valid: boolean } {
  const trimmed = value.trim();
  if (!trimmed) return { valid: true };
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return { valid: false };
  return { iso: date.toISOString(), valid: true };
}

export function PointsScreen({
  title,
  active = true,
  load,
  loadSummary,
  exportFile,
}: {
  title: string;
  active?: boolean;
  load?: (query: PointListQuery) => Promise<LedgerPage<PointItem>>;
  loadSummary?: () => Promise<RightsView>;
  exportFile?: (
    query: PointListQuery,
    format: 'csv' | 'xlsx',
  ) => Promise<{ filename: string; mime: string; body: Uint8Array }>;
}) {
  const fallback = useMemo(
    () => (query: PointListQuery) => httpPoints(window.sessionStorage, query),
    [],
  );
  const fallbackSummary = useMemo(() => () => httpRights(window.sessionStorage), []);
  const fallbackExport = useMemo(
    () => (query: PointListQuery, format: 'csv' | 'xlsx') =>
      httpDownloadPoints(window.sessionStorage, query, format),
    [],
  );
  const read = load ?? fallback;
  const readSummary = loadSummary ?? (load ? null : fallbackSummary);
  const download = exportFile ?? fallbackExport;
  const feedback = useUxFeedback();

  const [query, setQuery] = useState<PointListQuery>(EMPTY);
  const [draft, setDraft] = useState({ title: '', delta: '', from: '', to: '' });
  const [page, setPage] = useState<LedgerPage<PointItem> | null>(null);
  const [summary, setSummary] = useState<RightsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emptyNotice, setEmptyNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState<boolean>(() => Boolean(readSummary));
  const [refreshNonce, setRefreshNonce] = useState(0);
  const wasActiveRef = useRef(active);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void read(query).then(
      (next) => {
        if (!live) return;
        setPage(next);
        setError(null);
        if ((next.total ?? next.items.length) > 0) {
          setEmptyNotice(null);
        }
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
  }, [read, query, refreshNonce]);

  const fetchSummary = useCallback(() => {
    if (!readSummary) {
      setSummaryLoading(false);
      return () => undefined;
    }
    let live = true;
    setSummaryLoading(true);
    void readSummary().then(
      (next) => {
        if (!live) return;
        setSummary(next);
        setSummaryLoading(false);
      },
      () => {
        if (!live) return;
        setSummaryLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [readSummary]);

  useEffect(() => fetchSummary(), [fetchSummary, refreshNonce]);

  useEffect(() => {
    const becameActive = !wasActiveRef.current && active;
    wasActiveRef.current = active;
    if (becameActive) {
      setRefreshNonce((n) => n + 1);
    }
  }, [active]);

  function applyFilter(): void {
    const delta = draft.delta.trim();
    if (delta !== '' && !/^[+-]?\d+$/.test(delta)) {
      setError('点数变动需为整数（支持 + / - 前缀，如 +100 或 -5）');
      return;
    }
    const parsedFrom = parseDatetimeInput(draft.from);
    const parsedTo = parseDatetimeInput(draft.to);
    if (!parsedFrom.valid || !parsedTo.valid) {
      setError('时间格式不正确');
      return;
    }
    if (parsedFrom.iso && parsedTo.iso && parsedFrom.iso > parsedTo.iso) {
      setError('开始时间不能晚于结束时间');
      return;
    }
    setError(null);
    setEmptyNotice(null);
    setQuery({
      ...EMPTY,
      title: draft.title.trim(),
      delta: delta === '' ? undefined : Number(delta),
      from: parsedFrom.iso,
      to: parsedTo.iso,
    });
  }

  async function handleExport(format: 'csv' | 'xlsx'): Promise<void> {
    setError(null);
    setEmptyNotice(null);
    try {
      const file = await download(query, format);
      triggerBlobDownload(file);
    } catch (reason) {
      const msg = reason instanceof AccountApiError ? reason.message : '导出失败';
      setError(msg);
      throw reason;
    }
  }

  const availablePoints = summary
    ? (summary.available ?? Math.max(0, summary.points - (summary.pointsReserved ?? 0)))
    : null;
  const reservedPoints = summary?.pointsReserved ?? 0;
  const isShadow = summary?.billingMode === 'SHADOW';
  const isEmpty = !loading && (page?.total ?? 0) === 0 && (page?.items.length ?? 0) === 0;

  return (
    <section aria-label="点数明细">
      <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 12 }}>
        {title}
      </Typography.Title>
      <div className="gm-ledger-summary-grid" aria-label="点数概览">
        {summaryLoading && summary === null ? (
          <div data-testid="points-kpi-skeleton">
            <SignalSkeleton variant="kpi" />
          </div>
        ) : (
          <div className="gm-kpi gm-kpi-compact">
            <div className="gm-kpi-label">当前可用点数</div>
            <div className="gm-kpi-value gm-kpi-value-sm gm-num">
              {availablePoints !== null ? `${formatCountNumber(availablePoints)} 点` : '—'}
            </div>
            <div className="gm-kpi-caption gm-num">
              {summary
                ? reservedPoints > 0
                  ? `总计 ${formatCountNumber(summary.points)} 点 · 任务占用中 ${formatCountNumber(reservedPoints)} 点`
                  : `总计 ${formatCountNumber(summary.points)} 点`
                : '实时点数余额'}
            </div>
          </div>
        )}
        {summaryLoading && summary === null ? (
          <div data-testid="points-kpi-skeleton">
            <SignalSkeleton variant="kpi" />
          </div>
        ) : (
          <div className="gm-kpi gm-kpi-compact">
            <div className="gm-kpi-label">当前计费模式</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {summary ? (
                <Tag color={isShadow ? 'gold' : 'blue'}>
                  {isShadow ? UX_TERMS.billingShadow : UX_TERMS.billingStrict}
                </Tag>
              ) : (
                <span className="gm-kpi-value gm-kpi-value-sm">—</span>
              )}
            </div>
            <div className="gm-kpi-caption">
              {summary
                ? isShadow
                  ? '免费体验期内仅记录原价流水，不扣减可用点数'
                  : '按实际成功产出结算扣减可用点数'
                : '实时计费状态'}
            </div>
          </div>
        )}
        {loading && page === null ? (
          <div data-testid="points-kpi-skeleton">
            <SignalSkeleton variant="kpi" />
          </div>
        ) : (
          <div className="gm-kpi gm-kpi-compact">
            <div className="gm-kpi-label">筛选记录数</div>
            <div className="gm-kpi-value gm-kpi-value-sm gm-num">
              {formatCountNumber(page?.total ?? 0)} 条
            </div>
            <div className="gm-kpi-caption">支持按项目、变动点数与时间区间查询导出</div>
          </div>
        )}
      </div>

      <div className="gm-ledger-filter">
        <Input
          aria-label="项目名称"
          placeholder="项目名称"
          style={{ width: 170 }}
          value={draft.title}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          onPressEnter={applyFilter}
        />
        <Input
          aria-label="点数变动"
          placeholder="点数变动"
          style={{ width: 112 }}
          value={draft.delta}
          onChange={(event) => setDraft((current) => ({ ...current, delta: event.target.value }))}
          onPressEnter={applyFilter}
        />
        <Input
          aria-label="开始时间"
          type="datetime-local"
          style={{ width: 186 }}
          value={draft.from}
          onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
        />
        <Input
          aria-label="结束时间"
          type="datetime-local"
          style={{ width: 186 }}
          value={draft.to}
          onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
        />
        <div className="gm-ledger-filter-actions">
          <Button type="primary" aria-label="查询" onClick={applyFilter}>
            查询
          </Button>
          <Button
            aria-label="重置"
            onClick={() => {
              setError(null);
              setEmptyNotice(null);
              setDraft({ title: '', delta: '', from: '', to: '' });
              setQuery(EMPTY);
            }}
          >
            重置
          </Button>
          <ExportAction
            label="导出 CSV"
            singleFormat="csv"
            empty={isEmpty}
            onEmpty={(msg) => {
              setEmptyNotice(msg);
              feedback.notifyWarning(msg);
            }}
            onExport={() => handleExport('csv')}
          />
          <ExportAction
            label="导出 XLSX"
            singleFormat="xlsx"
            empty={isEmpty}
            onEmpty={(msg) => {
              setEmptyNotice(msg);
              feedback.notifyWarning(msg);
            }}
            onExport={() => handleExport('xlsx')}
          />
        </div>
      </div>

      {emptyNotice ? (
        <Alert
          type="warning"
          showIcon
          closable
          message={emptyNotice}
          onClose={() => setEmptyNotice(null)}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {loading && page === null ? (
        <div data-testid="points-table-skeleton">
          <SignalSkeleton variant="row" rows={5} />
        </div>
      ) : (
        <Table<PointItem>
          rowKey="id"
          tableLayout="fixed"
          loading={loading}
          dataSource={page?.items ?? []}
          locale={{ emptyText: '没有找到匹配的记录' }}
          pagination={{
            current: page?.page ?? 1,
            pageSize: page?.pageSize ?? 10,
            total: page?.total ?? 0,
            showSizeChanger: false,
            showTotal: (total) => `共 ${total} 条记录`,
            onChange: (next) => setQuery((current) => ({ ...current, page: next })),
          }}
          columns={[
            {
              title: '序号',
              key: 'seq',
              width: 58,
              render: (_value, _row, index) => (
                <span className="gm-num">
                  {((page?.page ?? 1) - 1) * (page?.pageSize ?? 10) + index + 1}
                </span>
              ),
            },
            {
              title: '项目',
              dataIndex: 'title',
              key: 'title',
              ellipsis: { showTitle: false },
              render: (value: string) => (
                <TableClampText
                  text={sanitizeLedgerTitle(value)}
                  lines={1}
                  maxWidth={280}
                  tooltipThreshold={24}
                />
              ),
            },
            {
              title: '点数',
              key: 'points',
              width: 124,
              render: (_value, row) => <span className="gm-num">{row.pointsText}</span>,
            },
            {
              title: '消耗时间',
              key: 'createdAt',
              width: 156,
              render: (_value, row) => (
                <span className="gm-num">
                  {formatShanghaiDateTime(row.createdAt, { seconds: true })}
                </span>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}
