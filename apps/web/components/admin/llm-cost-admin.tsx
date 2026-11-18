'use client';

import {
  LLM_COST_DAY_OPTIONS,
  LLM_COST_DEFAULT_DAYS,
  llmDailyReportToCsv,
  type LlmDailyBucket,
  type LlmDailyCostReport,
  type LlmModelBreakdown,
  type LlmSceneBreakdown,
  type LlmTenantBreakdown,
} from '@geomix/shared';
import { Alert, Button, Card, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { AdminApiError, type AdminClient, type TenantRow } from '../../lib/admin-client';
import { formatShortDisplayId, triggerBlobDownload } from '../../lib/ux-foundation';

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
        setError(messageOf(reason));
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

  return (
    <section aria-label="LLM成本日报">
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          LLM 成本日报
        </Typography.Title>
        <Space wrap>
          <Select
            aria-label="统计周期"
            value={days}
            style={{ width: 132 }}
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
              style={{ width: 180 }}
              options={[
                { value: '', label: '全部租户' },
                ...tenants.map((t) => ({ value: t.id, label: `${t.name} (${t.username})` })),
              ]}
              onChange={(value) => setTenantId(value)}
            />
          ) : null}
          <Space size={6}>
            <span>含占位假调用</span>
            <Switch
              aria-label="含占位假调用"
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

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}

      {report ? (
        <Alert
          type={report.rateConfigured ? 'info' : 'warning'}
          showIcon
          style={{ marginBottom: 16 }}
          message={
            report.rateConfigured
              ? `统计区间 ${report.windowStartDate} 至 ${report.windowEndDate}（北京时间）：已启用自定义模型单价核算，本报表仅用于运维成本统计，不触发租户点数扣减。`
              : `统计区间 ${report.windowStartDate} 至 ${report.windowEndDate}（北京时间）：当前按默认参考费率估算，与租户点数账本相互独立；可在系统费率配置中设置各模型千 Token 单价。`
          }
        />
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <Card size="small" title="总调用次数">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {report?.totals.calls ?? 0}
          </Typography.Title>
          <Typography.Text type="secondary">
            真实 {report?.totals.realCalls ?? 0} / 占位 {report?.totals.fakeCalls ?? 0}
          </Typography.Text>
        </Card>
        <Card size="small" title="总 Token 消耗">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {(report?.totals.totalTokens ?? 0).toLocaleString('en-US')}
          </Typography.Title>
          <Typography.Text type="secondary">
            输入 {(report?.totals.tokensIn ?? 0).toLocaleString('en-US')} / 输出{' '}
            {(report?.totals.tokensOut ?? 0).toLocaleString('en-US')}
          </Typography.Text>
        </Card>
        <Card size="small" title="预估总成本（元）">
          <Typography.Title level={4} style={{ margin: 0 }}>
            ¥{report?.totals.costYuan ?? '0.0000'}
          </Typography.Title>
          <Typography.Text type="secondary">
            {(report?.totals.costMicro ?? 0).toLocaleString('en-US')} 微元
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
                pagination={false}
                columns={[
                  { title: '日期', dataIndex: 'date' },
                  { title: '总调用', dataIndex: 'calls' },
                  { title: '真实调用', dataIndex: 'realCalls' },
                  { title: '占位调用', dataIndex: 'fakeCalls' },
                  { title: '输入 Token', dataIndex: 'tokensIn' },
                  { title: '输出 Token', dataIndex: 'tokensOut' },
                  { title: '总 Token', dataIndex: 'totalTokens' },
                  {
                    title: '预估成本（元）',
                    dataIndex: 'costYuan',
                    render: (val: string) => `¥${val}`,
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
                pagination={false}
                columns={[
                  { title: '业务场景', dataIndex: 'label' },
                  { title: '场景编码', dataIndex: 'scene' },
                  { title: '调用次数', dataIndex: 'calls' },
                  { title: '输入 Token', dataIndex: 'tokensIn' },
                  { title: '输出 Token', dataIndex: 'tokensOut' },
                  { title: '总 Token', dataIndex: 'totalTokens' },
                  {
                    title: '预估成本（元）',
                    dataIndex: 'costYuan',
                    render: (val: string) => `¥${val}`,
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
                pagination={false}
                columns={[
                  { title: '服务商', dataIndex: 'provider' },
                  { title: '模型', dataIndex: 'model' },
                  {
                    title: '类型',
                    dataIndex: 'fake',
                    render: (fake: boolean) =>
                      fake ? <Tag>开发占位</Tag> : <Tag color="blue">真实模型</Tag>,
                  },
                  { title: '调用次数', dataIndex: 'calls' },
                  { title: '总 Token', dataIndex: 'totalTokens' },
                  {
                    title: '预估成本（元）',
                    dataIndex: 'costYuan',
                    render: (val: string) => `¥${val}`,
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
                pagination={false}
                columns={[
                  { title: '租户名称', dataIndex: 'tenantName' },
                  {
                    title: '租户编号',
                    dataIndex: 'tenantId',
                    render: (val: string) => (
                      <Typography.Text code title={val}>
                        {formatShortDisplayId(val, '')}
                      </Typography.Text>
                    ),
                  },
                  { title: '调用次数', dataIndex: 'calls' },
                  { title: '总 Token', dataIndex: 'totalTokens' },
                  {
                    title: '预估成本（元）',
                    dataIndex: 'costYuan',
                    render: (val: string) => `¥${val}`,
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
