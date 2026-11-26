'use client';

import {
  formatCountNumber,
  formatLlmModelDisplayLabel,
  formatLlmProviderDisplayLabel,
  formatLlmTenantDisplayName,
  formatYuanAmount,
  LLM_COST_DAY_OPTIONS,
  LLM_COST_DEFAULT_DAYS,
  llmDailyReportToCsv,
  type LlmDailyBucket,
  type LlmDailyCostReport,
  type LlmModelBreakdown,
  type LlmSceneBreakdown,
  type LlmTenantBreakdown,
} from '@geomix/shared';
import { Alert, Button, Card, Select, Space, Switch, Table, Tabs, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { AdminApiError, type AdminClient, type TenantRow } from '../../lib/admin-client';
import {
  formatShanghaiDate,
  formatShortDisplayId,
  isOpaqueEntityId,
  replaceUxJargon,
  triggerBlobDownload,
} from '../../lib/ux-foundation';
import { StatusBadge } from '../ui';

export type LlmCostAdminClient = Pick<AdminClient, 'llmCosts'> &
  Partial<Pick<AdminClient, 'listTenants'>>;

export function LlmCostAdmin({ client }: { client: LlmCostAdminClient }) {
  const [days, setDays] = useState<number>(LLM_COST_DEFAULT_DAYS);
  const [includeFake, setIncludeFake] = useState<boolean>(true);
  const [tenantId, setTenantId] = useState<string>('');
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [report, setReport] = useState<LlmDailyCostReport | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client.listTenants) return;
    let live = true;
    void client.listTenants().then(
      (rows) => {
        if (live) setTenants(rows);
      },
      () => {
        // 租户下拉加载失败不阻塞成本日报主视图
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  const loadReport = useCallback(
    async (next: { days: number; includeFake: boolean; tenantId: string }) => {
      setLoading(true);
      setError(null);
      try {
        const data = await client.llmCosts({
          days: next.days,
          includeFake: next.includeFake,
          ...(next.tenantId ? { tenantId: next.tenantId } : {}),
        });
        setReport(data);
      } catch (reason: unknown) {
        setError(replaceUxJargon(messageOf(reason)));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void loadReport({ days, includeFake, tenantId });
  }, [days, includeFake, tenantId, loadReport]);

  const handleExportCsv = () => {
    if (!report) return;
    const csv = llmDailyReportToCsv(report);
    triggerBlobDownload({
      filename: `geomix-llm-costs-${report.windowEndDate || 'report'}.csv`,
      mime: 'text/csv;charset=utf-8;',
      body: new TextEncoder().encode(`\uFEFF${csv}`),
    });
  };

  const windowStart = report
    ? formatShanghaiDate(report.windowStartDate, report.windowStartDate)
    : '';
  const windowEnd = report ? formatShanghaiDate(report.windowEndDate, report.windowEndDate) : '';

  return (
    <section aria-label="LLM成本日报">
      <div className="gm-admin-head gm-admin-head--lg">
        <Typography.Title level={3} className="gm-admin-title">
          LLM 成本日报
        </Typography.Title>
        <Space wrap>
          <Select
            aria-label="统计周期"
            value={days}
            className="gm-admin-select-sm"
            options={LLM_COST_DAY_OPTIONS.map((d) => ({
              value: d,
              label: `近 ${d} 天`,
            }))}
            onChange={(value) => setDays(value)}
          />
          {tenants.length > 0 ? (
            <Select
              aria-label="筛选租户"
              value={tenantId}
              className="gm-admin-select-lg"
              options={[
                { value: '', label: '全部租户' },
                ...tenants.map((t) => ({
                  value: t.id,
                  label: `${t.name}（${t.username}）`,
                })),
              ]}
              onChange={(value) => setTenantId(value)}
            />
          ) : null}
          <Space size={6}>
            <span>含模拟调用</span>
            <Switch
              aria-label="含模拟调用"
              checked={includeFake}
              onChange={(checked) => setIncludeFake(checked)}
            />
          </Space>
          <Button
            onClick={() => void loadReport({ days, includeFake, tenantId })}
            loading={loading}
          >
            刷新
          </Button>
          <Button type="primary" onClick={handleExportCsv} disabled={!report}>
            导出 CSV
          </Button>
        </Space>
      </div>

      {error ? <Alert type="error" showIcon message={error} className="gm-admin-alert" /> : null}

      {report ? (
        <Alert
          type={report.rateConfigured ? 'info' : 'warning'}
          showIcon
          className="gm-admin-alert-lg"
          message={
            report.rateConfigured
              ? `统计区间 ${windowStart} 至 ${windowEnd}（北京时间 UTC+8）：已启用自定义模型单价核算，本报表仅用于运维成本统计，不触发租户点数扣减。`
              : `统计区间 ${windowStart} 至 ${windowEnd}（北京时间 UTC+8）：当前按系统默认参考费率估算，与租户点数账本相互独立（如需调整各模型千 Token 单价，请联系运维更新部署配置）。`
          }
        />
      ) : null}

      <div className="gm-admin-cost-grid">
        <Card size="small" title="总调用次数">
          <Typography.Title level={4} className="gm-num gm-admin-kpi-val">
            {formatCountNumber(report?.totals.calls)}
          </Typography.Title>
          <Typography.Text type="secondary" className="gm-num">
            真实 {formatCountNumber(report?.totals.realCalls)} / 模拟{' '}
            {formatCountNumber(report?.totals.fakeCalls)}
          </Typography.Text>
        </Card>
        <Card size="small" title="总 Token 消耗">
          <Typography.Title level={4} className="gm-num gm-admin-kpi-val">
            {formatCountNumber(report?.totals.totalTokens)}
          </Typography.Title>
          <Typography.Text type="secondary" className="gm-num">
            输入 {formatCountNumber(report?.totals.tokensIn)} / 输出{' '}
            {formatCountNumber(report?.totals.tokensOut)}
          </Typography.Text>
        </Card>
        <Card size="small" title="预估总成本（元）">
          <Typography.Title level={4} className="gm-num gm-admin-kpi-val">
            {formatYuanAmount(report?.totals.costYuan)}
          </Typography.Title>
          <Typography.Text type="secondary" className="gm-num">
            {formatCountNumber(report?.totals.costMicro)} 微元
          </Typography.Text>
        </Card>
      </div>

      <Tabs
        items={[
          {
            key: 'daily',
            label: '按日明细',
            children: (
              <Table<LlmDailyBucket>
                rowKey="date"
                loading={loading}
                dataSource={report?.daily ?? []}
                scroll={{ x: 'max-content' }}
                pagination={false}
                columns={[
                  {
                    title: '日期',
                    dataIndex: 'date',
                    render: (val: string) => (
                      <span className="gm-num">{formatShanghaiDate(val, val)}</span>
                    ),
                  },
                  {
                    title: '总调用',
                    dataIndex: 'calls',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '真实调用',
                    dataIndex: 'realCalls',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '模拟调用',
                    dataIndex: 'fakeCalls',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '输入 Token',
                    dataIndex: 'tokensIn',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '输出 Token',
                    dataIndex: 'tokensOut',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '总 Token',
                    dataIndex: 'totalTokens',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '预估成本（元）',
                    dataIndex: 'costYuan',
                    render: (val: string) => (
                      <span className="gm-num">{formatYuanAmount(val)}</span>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'scene',
            label: '按场景分布',
            children: (
              <Table<LlmSceneBreakdown>
                rowKey="scene"
                loading={loading}
                dataSource={report?.byScene ?? []}
                scroll={{ x: 'max-content' }}
                pagination={false}
                columns={[
                  { title: '业务场景', dataIndex: 'label' },
                  { title: '场景编码', dataIndex: 'scene' },
                  {
                    title: '调用次数',
                    dataIndex: 'calls',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '输入 Token',
                    dataIndex: 'tokensIn',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '输出 Token',
                    dataIndex: 'tokensOut',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '总 Token',
                    dataIndex: 'totalTokens',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '预估成本（元）',
                    dataIndex: 'costYuan',
                    render: (val: string) => (
                      <span className="gm-num">{formatYuanAmount(val)}</span>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'model',
            label: '按模型分布',
            children: (
              <Table<LlmModelBreakdown>
                rowKey={(row) => `${row.provider}-${row.model}-${row.fake ? 'fake' : 'real'}`}
                loading={loading}
                dataSource={report?.byModel ?? []}
                scroll={{ x: 'max-content' }}
                pagination={false}
                columns={[
                  {
                    title: '服务商',
                    dataIndex: 'provider',
                    render: (val: string, row) =>
                      row.model.startsWith('deterministic-') || val === 'local-rule'
                        ? '本地规则'
                        : formatLlmProviderDisplayLabel(val, row.fake),
                  },
                  {
                    title: '模型',
                    dataIndex: 'model',
                    render: (val: string, row) =>
                      val.startsWith('deterministic-')
                        ? '规则判定（免模型调用）'
                        : formatLlmModelDisplayLabel(val, row.fake),
                  },
                  {
                    title: '类型',
                    dataIndex: 'fake',
                    render: (fake: boolean, row) =>
                      row.model.startsWith('deterministic-') ? (
                        <StatusBadge tone="neutral">规则跳过</StatusBadge>
                      ) : fake ? (
                        <StatusBadge tone="neutral">内置模拟</StatusBadge>
                      ) : (
                        <StatusBadge tone="active">真实模型</StatusBadge>
                      ),
                  },
                  {
                    title: '调用次数',
                    dataIndex: 'calls',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '总 Token',
                    dataIndex: 'totalTokens',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '预估成本（元）',
                    dataIndex: 'costYuan',
                    render: (val: string) => (
                      <span className="gm-num">{formatYuanAmount(val)}</span>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'tenant',
            label: '按租户排行',
            children: (
              <Table<LlmTenantBreakdown>
                rowKey="tenantId"
                loading={loading}
                dataSource={report?.byTenant ?? []}
                scroll={{ x: 'max-content' }}
                pagination={false}
                columns={[
                  {
                    title: '租户名称',
                    dataIndex: 'tenantName',
                    render: (val: string, row) => formatLlmTenantDisplayName(val, row.tenantId),
                  },
                  {
                    title: '租户编号',
                    dataIndex: 'tenantId',
                    render: (val: string) => (
                      <Typography.Text code title={isOpaqueEntityId(val) ? undefined : val}>
                        {formatShortDisplayId(val, '')}
                      </Typography.Text>
                    ),
                  },
                  {
                    title: '调用次数',
                    dataIndex: 'calls',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '总 Token',
                    dataIndex: 'totalTokens',
                    render: (val: number) => (
                      <span className="gm-num">{formatCountNumber(val)}</span>
                    ),
                  },
                  {
                    title: '预估成本（元）',
                    dataIndex: 'costYuan',
                    render: (val: string) => (
                      <span className="gm-num">{formatYuanAmount(val)}</span>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
    </section>
  );
}

function messageOf(reason: unknown): string {
  if (reason instanceof AdminApiError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return '加载成本日报失败';
}
