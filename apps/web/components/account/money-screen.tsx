'use client';

import {
  formatCountNumber,
  formatYuanAmount,
  MONEY_LEDGER_COLUMNS,
  sanitizeLedgerRemark,
  sanitizeLedgerTitle,
  type MoneyListQuery,
} from '@geomix/shared';
import { Alert, Button, Input, Table, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccountApiError,
  httpDownloadMoney,
  httpMoney,
  httpRights,
  type LedgerPage,
  type MoneyItem,
  type RightsView,
} from '../../lib/account-client';
import {
  dedupeRechargeNotice,
  formatShanghaiDateTime,
  triggerBlobDownload,
} from '../../lib/ux-foundation';
import { ExportAction } from '../crud/export-action';
import { TableClampText } from '../crud/table-clamp-text';
import { useUxFeedback } from '../crud/ux-feedback';

const EMPTY: MoneyListQuery = {
  page: 1,
  pageSize: 10,
  sort: 'createdAt',
  order: 'desc',
  title: '',
  amount: undefined,
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

export function MoneyScreen({
  title,
  active = true,
  load,
  loadSummary,
  exportFile,
}: {
  title: string;
  active?: boolean;
  load?: (query: MoneyListQuery) => Promise<LedgerPage<MoneyItem>>;
  loadSummary?: () => Promise<RightsView>;
  exportFile?: (
    query: MoneyListQuery,
    format: 'csv' | 'xlsx',
  ) => Promise<{ filename: string; mime: string; body: Uint8Array }>;
}) {
  const fallback = useMemo(
    () => (query: MoneyListQuery) => httpMoney(window.sessionStorage, query),
    [],
  );
  const fallbackSummary = useMemo(() => () => httpRights(window.sessionStorage), []);
  const fallbackExport = useMemo(
    () => (query: MoneyListQuery, format: 'csv' | 'xlsx') =>
      httpDownloadMoney(window.sessionStorage, query, format),
    [],
  );
  const read = load ?? fallback;
  const readSummary = loadSummary ?? (load ? null : fallbackSummary);
  const download = exportFile ?? fallbackExport;
  const feedback = useUxFeedback();

  const [query, setQuery] = useState<MoneyListQuery>(EMPTY);
  const [draft, setDraft] = useState({ title: '', amount: '', from: '', to: '' });
  const [page, setPage] = useState<LedgerPage<MoneyItem> | null>(null);
  const [summary, setSummary] = useState<RightsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emptyNotice, setEmptyNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
        setError(reason instanceof AccountApiError ? reason.message : '无法加载余额明细');
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [read, query, refreshNonce]);

  const fetchSummary = useCallback(() => {
    if (!readSummary) return () => undefined;
    let live = true;
    void readSummary().then(
      (next) => {
        if (live) setSummary(next);
      },
      () => {
        // 顶部资产概览加载失败不阻塞流水主表格
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
    const amount = draft.amount.trim();
    if (amount !== '' && !/^-?\d+(\.\d{1,2})?$/.test(amount)) {
      setError('金额格式不正确');
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
      amount: amount || undefined,
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
  const isEmpty = !loading && (page?.total ?? 0) === 0 && (page?.items.length ?? 0) === 0;

  return (
    <section aria-label="余额明细">
      <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 12 }}>
        {title}
      </Typography.Title>
      <div className="gm-ledger-summary-grid" aria-label="余额概览">
        <div className="gm-kpi gm-kpi-compact">
          <div className="gm-kpi-label">当前可用余额</div>
          <div className="gm-kpi-value gm-kpi-value-sm gm-num">
            {summary ? formatYuanAmount(summary.money) : '—'}
          </div>
          <div className="gm-kpi-caption">{dedupeRechargeNotice(undefined)}</div>
        </div>
        <div className="gm-kpi gm-kpi-compact">
          <div className="gm-kpi-label">当前可用点数</div>
          <div className="gm-kpi-value gm-kpi-value-sm gm-num">
            {availablePoints !== null ? `${formatCountNumber(availablePoints)} 点` : '—'}
          </div>
          <div className="gm-kpi-caption">
            {summary ? `账户总点数 ${formatCountNumber(summary.points)} 点` : '关联账户点数余额'}
          </div>
        </div>
        <div className="gm-kpi gm-kpi-compact">
          <div className="gm-kpi-label">筛选记录数</div>
          <div className="gm-kpi-value gm-kpi-value-sm gm-num">
            {formatCountNumber(page?.total ?? 0)} 条
          </div>
          <div className="gm-kpi-caption">支持按项目、金额与时间区间查询导出</div>
        </div>
      </div>

      <div className="gm-ledger-filter">
        <Input
          aria-label="项目名称"
          placeholder="项目"
          style={{ width: 170 }}
          value={draft.title}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          onPressEnter={applyFilter}
        />
        <Input
          aria-label="金额"
          placeholder="金额"
          style={{ width: 112 }}
          value={draft.amount}
          onChange={(event) => setDraft((current) => ({ ...current, amount: event.target.value }))}
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
              setDraft({ title: '', amount: '', from: '', to: '' });
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
      <Table<MoneyItem>
        rowKey="id"
        loading={loading}
        dataSource={page?.items ?? []}
        scroll={{ x: 'max-content' }}
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
            title: MONEY_LEDGER_COLUMNS[0],
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
            title: MONEY_LEDGER_COLUMNS[1],
            dataIndex: 'amount',
            key: 'amount',
            width: 130,
            render: (value: string) => <span className="gm-num">{value}</span>,
          },
          {
            title: MONEY_LEDGER_COLUMNS[2],
            dataIndex: 'remark',
            key: 'remark',
            ellipsis: { showTitle: false },
            render: (value: string) => (
              <TableClampText
                text={sanitizeLedgerRemark(value)}
                lines={1}
                maxWidth={320}
                tooltipThreshold={24}
              />
            ),
          },
          {
            title: MONEY_LEDGER_COLUMNS[3],
            key: 'createdAt',
            width: 180,
            render: (_value, row) => (
              <span className="gm-num">
                {formatShanghaiDateTime(row.createdAt, { seconds: true })}
              </span>
            ),
          },
        ]}
      />
    </section>
  );
}
