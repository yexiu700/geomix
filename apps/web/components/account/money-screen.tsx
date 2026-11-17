'use client';

import { formatLedgerTime, MONEY_LEDGER_COLUMNS, type MoneyListQuery } from '@geomix/shared';
import { Alert, Button, Input, Table, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  AccountApiError,
  httpMoney,
  type LedgerPage,
  type MoneyItem,
} from '../../lib/account-client';

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

export function MoneyScreen({
  title,
  load,
}: {
  title: string;
  load?: (query: MoneyListQuery) => Promise<LedgerPage<MoneyItem>>;
}) {
  const fallback = useMemo(
    () => (query: MoneyListQuery) => httpMoney(window.sessionStorage, query),
    [],
  );
  const read = load ?? fallback;
  const [query, setQuery] = useState<MoneyListQuery>(EMPTY);
  const [draft, setDraft] = useState({ title: '', amount: '', from: '', to: '' });
  const [page, setPage] = useState<LedgerPage<MoneyItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
        setError(reason instanceof AccountApiError ? reason.message : '无法加载余额明细');
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [read, query]);

  return (
    <section aria-label="余额明细">
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      <div className="gm-ledger-filter">
        <Input
          aria-label="项目名称"
          placeholder="项目"
          value={draft.title}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
        />
        <Input
          aria-label="金额"
          placeholder="金额"
          value={draft.amount}
          onChange={(event) => setDraft((current) => ({ ...current, amount: event.target.value }))}
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
          onClick={() =>
            setQuery({
              ...EMPTY,
              title: draft.title.trim(),
              amount: draft.amount.trim() || undefined,
              from: draft.from ? new Date(draft.from).toISOString() : undefined,
              to: draft.to ? new Date(draft.to).toISOString() : undefined,
            })
          }
        >
          查询
        </Button>
      </div>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      <Table<MoneyItem>
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
          { title: MONEY_LEDGER_COLUMNS[0], dataIndex: 'title', key: 'title' },
          { title: MONEY_LEDGER_COLUMNS[1], dataIndex: 'amount', key: 'amount' },
          { title: MONEY_LEDGER_COLUMNS[2], dataIndex: 'remark', key: 'remark' },
          {
            title: MONEY_LEDGER_COLUMNS[3],
            key: 'createdAt',
            render: (_value, row) => formatLedgerTime(row.createdAt),
          },
        ]}
      />
    </section>
  );
}
