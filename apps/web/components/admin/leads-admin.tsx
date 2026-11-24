'use client';

import {
  MARKETING_LEAD_MARKETS,
  MARKETING_LEAD_MARKET_LABELS,
  MARKETING_LEAD_STATUSES,
  MARKETING_LEAD_STATUS_LABELS,
  formatShanghaiDateTime,
  isSafeMarketingHttpUrl,
  replaceUxJargon,
  type MarketingLeadDto,
  type MarketingLeadMarket,
  type MarketingLeadStatus,
  type UpdateMarketingLeadStatusInput,
} from '@geomix/shared';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminApiError, type AdminClient, type AdminLeadsQuery } from '../../lib/admin-client';
import { useUxFeedback } from '../crud/ux-feedback';

export type LeadsAdminClient = Pick<AdminClient, 'listAdminLeads' | 'updateAdminLead'>;

type LeadEditFormValues = {
  status: MarketingLeadStatus;
  adminNote: string;
};

const STATUS_TAG_COLORS: Record<MarketingLeadStatus, string> = {
  NEW: 'processing',
  CONTACTED: 'warning',
  TRIAL_PROVISIONED: 'success',
  ARCHIVED: 'default',
};

const STATUS_OPTIONS = MARKETING_LEAD_STATUSES.map((status) => ({
  value: status,
  label: MARKETING_LEAD_STATUS_LABELS[status],
}));

const FILTER_STATUS_OPTIONS: Array<{ value: 'ALL' | MarketingLeadStatus; label: string }> = [
  { value: 'ALL', label: '全部状态' },
  ...STATUS_OPTIONS,
];

const FILTER_MARKET_OPTIONS: Array<{ value: 'ALL' | MarketingLeadMarket; label: string }> = [
  { value: 'ALL', label: '全部市场' },
  ...MARKETING_LEAD_MARKETS.map((market) => ({
    value: market,
    label: MARKETING_LEAD_MARKET_LABELS[market].zh,
  })),
];

function messageOf(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (error instanceof AdminApiError) return replaceUxJargon(error.message || fallback);
  if (error instanceof Error && error.message) return replaceUxJargon(error.message);
  return fallback;
}

export function LeadsAdmin({ client }: { client: LeadsAdminClient }) {
  const feedback = useUxFeedback();
  const [rows, setRows] = useState<MarketingLeadDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<'ALL' | MarketingLeadStatus>('ALL');
  const [marketFilter, setMarketFilter] = useState<'ALL' | MarketingLeadMarket>('ALL');
  const [keywordInput, setKeywordInput] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [updatingIds, setUpdatingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<MarketingLeadDto | null>(null);
  const [modalSaving, setModalSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [editForm] = Form.useForm<LeadEditFormValues>();

  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);
  const updatingIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const hasActiveFilters =
    statusFilter !== 'ALL' ||
    marketFilter !== 'ALL' ||
    appliedKeyword !== '' ||
    keywordInput.trim() !== '';

  const loadLeads = useCallback(async () => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    setLoading(true);
    setError(null);

    const query: AdminLeadsQuery = { page, pageSize };
    if (statusFilter !== 'ALL') query.status = statusFilter;
    if (marketFilter !== 'ALL') query.targetMarket = marketFilter;
    if (appliedKeyword) query.keyword = appliedKeyword;

    try {
      const result = await client.listAdminLeads(query);
      if (!mountedRef.current || requestSeqRef.current !== seq) return;
      setRows(result.items);
      setTotal(result.total);
    } catch (reason) {
      if (!mountedRef.current || requestSeqRef.current !== seq) return;
      setError(messageOf(reason, '加载试用线索失败'));
    } finally {
      if (mountedRef.current && requestSeqRef.current === seq) {
        setLoading(false);
      }
    }
  }, [appliedKeyword, client, marketFilter, page, pageSize, statusFilter]);

  useEffect(() => {
    void loadLeads();
  }, [loadLeads]);

  const handleSearch = useCallback(() => {
    const trimmed = keywordInput.trim();
    setNotice(null);
    if (trimmed !== appliedKeyword) {
      setAppliedKeyword(trimmed);
      setPage(1);
    } else if (page !== 1) {
      setPage(1);
    } else {
      void loadLeads();
    }
  }, [appliedKeyword, keywordInput, loadLeads, page]);

  const handleResetFilters = useCallback(() => {
    setNotice(null);
    setKeywordInput('');
    setAppliedKeyword('');
    setStatusFilter('ALL');
    setMarketFilter('ALL');
    setPage(1);
  }, []);

  const handleQuickStatusChange = useCallback(
    async (row: MarketingLeadDto, nextStatus: MarketingLeadStatus) => {
      if (nextStatus === row.status || updatingIdsRef.current.has(row.id)) return;
      updatingIdsRef.current.add(row.id);
      setUpdatingIds((prev) => {
        const next = new Set(prev);
        next.add(row.id);
        return next;
      });
      setError(null);
      setNotice(null);
      try {
        await client.updateAdminLead(row.id, { status: nextStatus });
        if (!mountedRef.current) return;
        const msg = `已将「${row.companyBrand}」状态更新为${MARKETING_LEAD_STATUS_LABELS[nextStatus]}`;
        setNotice(msg);
        feedback.notifySuccess(msg);
        await loadLeads();
      } catch (reason) {
        if (!mountedRef.current) return;
        const msg = messageOf(reason, '更新线索状态失败');
        setError(msg);
        feedback.notifyError(msg);
      } finally {
        updatingIdsRef.current.delete(row.id);
        if (mountedRef.current) {
          setUpdatingIds((prev) => {
            if (!prev.has(row.id)) return prev;
            const next = new Set(prev);
            next.delete(row.id);
            return next;
          });
        }
      }
    },
    [client, feedback, loadLeads],
  );

  const openEditModal = useCallback((row: MarketingLeadDto) => {
    if (updatingIdsRef.current.has(row.id)) return;
    setEditing(row);
    setModalError(null);
  }, []);

  useEffect(() => {
    if (!editing) return;
    editForm.resetFields();
    editForm.setFieldsValue({
      status: editing.status,
      adminNote: editing.adminNote ?? '',
    });
  }, [editing, editForm]);

  const closeEditModal = useCallback(() => {
    if (modalSaving) return;
    setEditing(null);
    setModalError(null);
  }, [modalSaving]);

  const handleModalSave = useCallback(async () => {
    if (!editing) return;
    let values: LeadEditFormValues;
    try {
      values = await editForm.validateFields();
    } catch {
      return;
    }

    setModalSaving(true);
    setModalError(null);
    const trimmedNote = (values.adminNote ?? '').trim();
    const payload: UpdateMarketingLeadStatusInput = {
      status: values.status,
      adminNote: trimmedNote === '' ? null : trimmedNote,
    };

    let saved = false;
    try {
      const updated = await client.updateAdminLead(editing.id, payload);
      if (!mountedRef.current) return;
      saved = true;
      setRows((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      const msg = `已更新「${editing.companyBrand}」线索跟进信息`;
      setEditing(null);
      setModalSaving(false);
      setNotice(msg);
      feedback.notifySuccess(msg);
    } catch (reason) {
      if (!mountedRef.current) return;
      const msg = messageOf(reason, '保存跟进信息失败');
      setModalError(msg);
      feedback.notifyError(msg);
    } finally {
      if (mountedRef.current && !saved) {
        setModalSaving(false);
      }
    }
    if (saved) {
      await loadLeads();
    }
  }, [client, editForm, editing, feedback, loadLeads]);

  const columns: TableColumnsType<MarketingLeadDto> = useMemo(
    () => [
      {
        title: '品牌 / 官网',
        key: 'brand',
        width: '15%',
        render: (_value, row) => (
          <div>
            <Typography.Text strong>{row.companyBrand}</Typography.Text>
            {row.websiteUrl ? (
              isSafeMarketingHttpUrl(row.websiteUrl) ? (
                <a
                  href={row.websiteUrl.trim()}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'block',
                    color: 'var(--gm-info)',
                    fontSize: 12,
                    wordBreak: 'break-all',
                  }}
                >
                  {row.websiteUrl.trim()}
                </a>
              ) : (
                <Typography.Text
                  type="secondary"
                  style={{ display: 'block', fontSize: 12, wordBreak: 'break-all' }}
                >
                  {row.websiteUrl}
                </Typography.Text>
              )
            ) : null}
          </div>
        ),
      },
      {
        title: '联系人 / 邮箱',
        key: 'contact',
        width: '16%',
        render: (_value, row) => (
          <div>
            <div>{row.name}</div>
            <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
              {row.email}
            </Typography.Text>
            <div style={{ color: 'var(--gm-fg-3)', fontSize: 11 }}>
              {row.locale === 'zh-CN' ? '中文' : 'EN'}
              {row.sourcePage ? ` · ${row.sourcePage}` : ''}
            </div>
          </div>
        ),
      },
      {
        title: '目标市场',
        dataIndex: 'targetMarket',
        key: 'targetMarket',
        width: 118,
        render: (market: MarketingLeadMarket) => (
          <Tag style={{ marginInlineEnd: 0 }}>
            {MARKETING_LEAD_MARKET_LABELS[market]?.zh ?? market}
          </Tag>
        ),
      },
      {
        title: '月度目标 / 预估点数',
        key: 'goal',
        width: '15%',
        render: (_value, row) => {
          const hasPts = row.estimatedPts !== null && row.estimatedPts !== undefined;
          const hasGoal = Boolean(row.monthlyGoal);
          const hasNotes = Boolean(row.notes);
          if (!hasPts && !hasGoal && !hasNotes) {
            return <Typography.Text type="secondary">—</Typography.Text>;
          }
          return (
            <div>
              {hasPts ? (
                <div className="gm-num" style={{ color: 'var(--gm-phosphor)' }}>
                  约 {row.estimatedPts?.toLocaleString('en-US')} 点/月
                </div>
              ) : null}
              {hasGoal ? <div>{row.monthlyGoal}</div> : null}
              {hasNotes ? (
                <Typography.Paragraph
                  type="secondary"
                  ellipsis={{ rows: 2, tooltip: row.notes }}
                  style={{ margin: 0, fontSize: 12 }}
                >
                  {row.notes}
                </Typography.Paragraph>
              ) : null}
            </div>
          );
        },
      },
      {
        title: '状态',
        dataIndex: 'status',
        key: 'status',
        width: 88,
        render: (status: MarketingLeadStatus) => (
          <Tag color={STATUS_TAG_COLORS[status]} style={{ marginInlineEnd: 0 }}>
            {MARKETING_LEAD_STATUS_LABELS[status]}
          </Tag>
        ),
      },
      {
        title: '跟进备注',
        dataIndex: 'adminNote',
        key: 'adminNote',
        width: '12%',
        render: (adminNote: string | null) =>
          adminNote ? (
            <Typography.Paragraph ellipsis={{ rows: 2, tooltip: adminNote }} style={{ margin: 0 }}>
              {adminNote}
            </Typography.Paragraph>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          ),
      },
      {
        title: '提交时间',
        dataIndex: 'createdAt',
        key: 'createdAt',
        width: 132,
        render: (createdAt: string) => (
          <span className="gm-num" style={{ whiteSpace: 'nowrap' }}>
            {formatShanghaiDateTime(createdAt)}
          </span>
        ),
      },
      {
        title: '操作',
        key: 'actions',
        width: 196,
        render: (_value, row) => {
          const isUpdating = updatingIds.has(row.id);
          return (
            <Space size={6} wrap>
              <Select
                size="small"
                aria-label={`变更状态 ${row.companyBrand}`}
                value={row.status}
                disabled={isUpdating}
                loading={isUpdating}
                style={{ width: 102 }}
                options={STATUS_OPTIONS}
                onChange={(nextStatus: MarketingLeadStatus) =>
                  void handleQuickStatusChange(row, nextStatus)
                }
              />
              <Button
                size="small"
                aria-label={`跟进备注 ${row.companyBrand}`}
                disabled={isUpdating}
                onClick={() => openEditModal(row)}
              >
                跟进备注
              </Button>
            </Space>
          );
        },
      },
    ],
    [handleQuickStatusChange, openEditModal, updatingIds],
  );

  return (
    <section aria-label="试用线索">
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
          试用线索
        </Typography.Title>
        <Space wrap>
          <Button loading={loading} onClick={() => void loadLeads()}>
            刷新
          </Button>
          <Link
            href="/admin/tenants"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: 32,
              padding: '0 14px',
              borderRadius: 6,
              background: 'var(--gm-phosphor)',
              color: 'var(--gm-on-phosphor)',
              fontWeight: 600,
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            前往租户管理开通 Demo
          </Link>
        </Space>
      </div>

      <Typography.Paragraph style={{ marginBottom: 12, color: 'var(--gm-fg-2)' }}>
        查看官网预约演示与试用申请，支持按状态与目标市场筛选、记录跟进备注；审核通过后可前往租户管理开通
        1,000 点 / 365 天 Demo 试用账号。
      </Typography.Paragraph>

      <Space wrap style={{ marginBottom: 12, width: '100%' }}>
        <Input
          aria-label="搜索线索"
          placeholder="搜索邮箱、品牌或联系人"
          allowClear
          style={{ width: 260 }}
          value={keywordInput}
          onChange={(event) => {
            const next = event.target.value;
            setKeywordInput(next);
            if (next === '' && appliedKeyword !== '') {
              setAppliedKeyword('');
              setPage(1);
            }
          }}
          onPressEnter={handleSearch}
        />
        <Button onClick={handleSearch}>搜索</Button>
        <Select
          aria-label="状态筛选"
          value={statusFilter}
          style={{ width: 144 }}
          options={FILTER_STATUS_OPTIONS}
          onChange={(value: 'ALL' | MarketingLeadStatus) => {
            setStatusFilter(value);
            setPage(1);
          }}
        />
        <Select
          aria-label="目标市场筛选"
          value={marketFilter}
          style={{ width: 168 }}
          options={FILTER_MARKET_OPTIONS}
          onChange={(value: 'ALL' | MarketingLeadMarket) => {
            setMarketFilter(value);
            setPage(1);
          }}
        />
        {hasActiveFilters ? (
          <Button aria-label="重置筛选" onClick={handleResetFilters}>
            重置
          </Button>
        ) : null}
      </Space>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {notice ? (
        <Alert type="success" showIcon message={notice} style={{ marginBottom: 12 }} />
      ) : null}

      <Table<MarketingLeadDto>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        tableLayout="fixed"
        locale={{ emptyText: hasActiveFilters ? '没有匹配的试用线索' : '暂无试用线索' }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: ['10', '20', '50'],
          showTotal: (count) => `共 ${count} 条`,
          onChange: (nextPage, nextPageSize) => {
            if (nextPageSize !== pageSize) {
              setPageSize(nextPageSize);
              setPage(1);
            } else {
              setPage(nextPage);
            }
          },
        }}
      />

      <Modal
        open={editing !== null}
        title={editing ? `跟进线索 · ${editing.companyBrand}` : '跟进线索'}
        okText="保存"
        cancelText="取消"
        keyboard
        maskClosable={!modalSaving}
        destroyOnHidden
        okButtonProps={{ loading: modalSaving }}
        cancelButtonProps={{ disabled: modalSaving }}
        onOk={() => void handleModalSave()}
        onCancel={closeEditModal}
      >
        {editing ? (
          <div
            style={{
              background: 'var(--gm-bg-elevated)',
              border: '1px solid var(--gm-line-1)',
              borderRadius: 6,
              padding: '10px 12px',
              marginBottom: 16,
              fontSize: 13,
              display: 'grid',
              gap: 4,
            }}
          >
            <div>
              <strong>联系人：</strong>
              {editing.name}（{editing.email}）
            </div>
            <div>
              <strong>目标市场：</strong>
              {MARKETING_LEAD_MARKET_LABELS[editing.targetMarket]?.zh ?? editing.targetMarket}
              {editing.estimatedPts !== null && editing.estimatedPts !== undefined ? (
                <span className="gm-num" style={{ marginLeft: 10, color: 'var(--gm-phosphor)' }}>
                  约 {editing.estimatedPts.toLocaleString('en-US')} 点/月
                </span>
              ) : null}
            </div>
            {editing.websiteUrl ? (
              <div>
                <strong>官网：</strong>
                {isSafeMarketingHttpUrl(editing.websiteUrl) ? (
                  <a
                    href={editing.websiteUrl.trim()}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--gm-info)', wordBreak: 'break-all' }}
                  >
                    {editing.websiteUrl.trim()}
                  </a>
                ) : (
                  <Typography.Text type="secondary">{editing.websiteUrl}</Typography.Text>
                )}
              </div>
            ) : null}
            {editing.monthlyGoal ? (
              <div>
                <strong>月度目标：</strong>
                {editing.monthlyGoal}
              </div>
            ) : null}
            {editing.notes ? (
              <div>
                <strong>客户留言：</strong>
                {editing.notes}
              </div>
            ) : null}
            <div style={{ color: 'var(--gm-fg-3)', fontSize: 12 }}>
              提交时间：
              <span className="gm-num">{formatShanghaiDateTime(editing.createdAt)}</span>
            </div>
          </div>
        ) : null}

        {modalError ? (
          <Alert type="error" showIcon message={modalError} style={{ marginBottom: 12 }} />
        ) : null}

        <Form form={editForm} preserve={false} layout="vertical" scrollToFirstError>
          <Form.Item
            label="线索状态"
            name="status"
            rules={[{ required: true, message: '请选择线索状态' }]}
          >
            <Select aria-label="线索状态" options={STATUS_OPTIONS} />
          </Form.Item>
          <Form.Item
            label="跟进备注"
            name="adminNote"
            rules={[{ max: 2000, message: '备注最多 2000 字' }]}
          >
            <Input.TextArea
              aria-label="管理员跟进备注"
              rows={4}
              maxLength={2000}
              showCount
              placeholder="记录沟通进展、Demo 租户开通信息或归档原因（最多 2000 字）"
            />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}
