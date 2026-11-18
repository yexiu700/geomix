'use client';

import { COPY_TYPES, CREATIVE_DIRECTIONS } from '@geomix/shared/catalog';
import {
  KB_AGREEMENT_CHECKBOX_LABEL,
  KB_AGREEMENT_CONFIRM_BUTTON_LABEL,
  KB_AGREEMENT_KIND,
  KB_AGREEMENT_PARAGRAPHS,
  KB_AGREEMENT_TITLE,
  KB_AGREEMENT_VERSION,
  KB_BRAND_SHORT_MAX,
  KB_COMPANY_MAX,
  KB_DETAIL_FIELDS_META,
  KB_DETAIL_FIELD_MAX,
  KB_INDEX_STATUS_LABELS,
  KB_MODE_LABELS,
  KB_NAME_MAX,
  KB_SUMMARY_MAX,
  KB_UNSIGNED_ERROR_MSG,
  KB_WARNING_BANNER_TEXT,
  emptyKbDetailFields,
  isAgreementScrolledToBottom,
  type AgreementStatusView,
  type CrudPageSize,
  type KbDetailFieldKey,
  type KbDetailFieldMeta,
  type KbDetailFields,
  type KbIndexStatusName,
  type KbModeName,
  type KnowledgeBaseRecord,
  type KnowledgeWriteInput,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Input, Modal, Radio, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { CrudTable, type CrudColumn, type CrudSearch } from '../crud/crud-table';
import { TableClampText } from '../crud/table-clamp-text';
import {
  KnowledgeApiError,
  httpKnowledgeGateway,
  type KnowledgeGateway,
} from '../../lib/knowledge';
import { formatShanghaiDateTime, triggerBlobDownload } from '../../lib/ux-foundation';

type DetailModeDraft = {
  companyName: string;
  brandShort: string;
  directions: string[];
  copyTypes: string[];
  fields: KbDetailFields;
};

type SummaryModeDraft = {
  summaryText: string;
};

type FormDraft = {
  editingId: string | null;
  name: string;
  mode: KbModeName;
  detail: DetailModeDraft;
  summary: SummaryModeDraft;
};

function createEmptyFormDraft(): FormDraft {
  return {
    editingId: null,
    name: '',
    mode: 'DETAIL',
    detail: {
      companyName: '',
      brandShort: '',
      directions: [],
      copyTypes: [],
      fields: emptyKbDetailFields(),
    },
    summary: {
      summaryText: '',
    },
  };
}

function draftFromRecord(row: KnowledgeBaseRecord): FormDraft {
  return {
    editingId: row.id,
    name: row.name,
    mode: row.mode,
    detail: {
      companyName: row.mode === 'DETAIL' ? (row.companyName ?? '') : '',
      brandShort: row.mode === 'DETAIL' ? (row.brandShort ?? '') : '',
      directions: row.mode === 'DETAIL' ? [...row.directions] : [],
      copyTypes: row.mode === 'DETAIL' ? [...row.copyTypes] : [],
      fields:
        row.mode === 'DETAIL' && row.fields
          ? { ...emptyKbDetailFields(), ...row.fields }
          : emptyKbDetailFields(),
    },
    summary: {
      summaryText: row.mode === 'SUMMARY' ? (row.summaryText ?? '') : '',
    },
  };
}

function indexStatusColor(status: KbIndexStatusName): string {
  if (status === 'READY') return 'success';
  if (status === 'INDEXING') return 'processing';
  if (status === 'FAILED') return 'error';
  return 'default';
}

export function KnowledgeScreen({
  title,
  readOnly = false,
  gateway,
}: {
  title: string;
  readOnly?: boolean;
  gateway?: KnowledgeGateway;
}) {
  const client = useMemo(
    () =>
      gateway ??
      httpKnowledgeGateway(
        typeof window === 'undefined'
          ? { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
          : window.sessionStorage,
      ),
    [gateway],
  );

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<CrudPageSize>(10);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState<CrudSearch>({
    keyword: '',
    enabled: undefined,
    sort: 'createdAt',
    order: 'desc',
  });
  const [reloadTick, setReloadTick] = useState(0);

  const [rows, setRows] = useState<KnowledgeBaseRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [agreement, setAgreement] = useState<AgreementStatusView>({
    kind: KB_AGREEMENT_KIND,
    version: KB_AGREEMENT_VERSION,
    signed: false,
    signatureId: null,
    signedAt: null,
  });

  const [banner, setBanner] = useState<{
    type: 'success' | 'info' | 'warning' | 'error';
    text: string;
  } | null>(null);

  // Add / Edit modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<FormDraft>(createEmptyFormDraft);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const errorAlertRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!modalOpen || !formError) return;
    errorAlertRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [modalOpen, formError]);

  // Help preview modal ("查看说明")
  const [helpField, setHelpField] = useState<KbDetailFieldMeta | null>(null);

  // Agreement modal ("查看必读承诺协议")
  const [agreementOpen, setAgreementOpen] = useState(false);
  const [scrolledBottom, setScrolledBottom] = useState(false);
  const [agreeChecked, setAgreeChecked] = useState(false);
  const [signing, setSigning] = useState(false);

  // Delete confirmation modal
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    client
      .list({
        page,
        pageSize,
        q: search.keyword.trim() || undefined,
      })
      .then((res) => {
        if (!active) return;
        setRows(res.items);
        setTotal(res.total);
        setAgreement(res.agreement);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof KnowledgeApiError && err.status !== 401) {
          setBanner({ type: 'error', text: err.message });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, page, pageSize, search.keyword, reloadTick]);

  // Auto-poll while any summary KB row is INDEXING
  const hasIndexing = rows.some((r) => r.indexStatus === 'INDEXING');
  useEffect(() => {
    if (!hasIndexing) return undefined;
    const timer = setInterval(() => {
      setReloadTick((n) => n + 1);
    }, 2500);
    return () => clearInterval(timer);
  }, [hasIndexing]);

  const directionOptions = useMemo(
    () => CREATIVE_DIRECTIONS.map((d) => ({ value: d, label: d })),
    [],
  );
  const copyTypeOptions = useMemo(() => COPY_TYPES.map((c) => ({ value: c, label: c })), []);

  function openCreateModal() {
    setDraft(createEmptyFormDraft());
    setFormError(null);
    setModalOpen(true);
  }

  function openEditModal(row: KnowledgeBaseRecord) {
    setDraft(draftFromRecord(row));
    setFormError(null);
    setModalOpen(true);
  }

  function openAgreementModal() {
    setScrolledBottom(agreement.signed);
    setAgreeChecked(agreement.signed);
    setAgreementOpen(true);
  }

  function handleAgreementScroll(event: UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    if (
      isAgreementScrolledToBottom({
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      })
    ) {
      setScrolledBottom(true);
    }
  }

  async function handleSignAgreement() {
    if (!scrolledBottom || !agreeChecked) return;
    setSigning(true);
    try {
      const res = await client.signAgreement();
      setAgreement(res);
      setAgreementOpen(false);
      if (formError === KB_UNSIGNED_ERROR_MSG) {
        setFormError(null);
      }
      setBanner({ type: 'success', text: '已签署企业知识库信息真实性与合规承诺协议' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '签署协议失败';
      setFormError(msg);
    } finally {
      setSigning(false);
    }
  }

  function updateDetailField(key: KbDetailFieldKey, value: string) {
    setDraft((prev) => ({
      ...prev,
      detail: {
        ...prev.detail,
        fields: {
          ...prev.detail.fields,
          [key]: value,
        },
      },
    }));
  }

  function validateAndBuildPayload(): KnowledgeWriteInput | null {
    const trimmedName = draft.name.trim();
    if (!trimmedName) {
      setFormError('请输入知识库名称');
      return null;
    }
    if (Array.from(trimmedName).length > KB_NAME_MAX) {
      setFormError(`知识库名称不超过 ${KB_NAME_MAX} 字`);
      return null;
    }

    if (draft.mode === 'DETAIL') {
      const companyName = draft.detail.companyName.trim();
      const brandShort = draft.detail.brandShort.trim();
      if (!companyName) {
        setFormError('请输入公司名称');
        return null;
      }
      if (Array.from(companyName).length > KB_COMPANY_MAX) {
        setFormError(`公司名称不超过 ${KB_COMPANY_MAX} 字`);
        return null;
      }
      if (!brandShort) {
        setFormError('请输入品牌简称');
        return null;
      }
      if (Array.from(brandShort).length > KB_BRAND_SHORT_MAX) {
        setFormError(`品牌简称不超过 ${KB_BRAND_SHORT_MAX} 字`);
        return null;
      }
      if (draft.detail.directions.length === 0) {
        setFormError('请至少选择 1 个创作方向');
        return null;
      }
      if (draft.detail.copyTypes.length === 0) {
        setFormError('请至少选择 1 个文案类型');
        return null;
      }
      for (const meta of KB_DETAIL_FIELDS_META) {
        const val = draft.detail.fields[meta.key] ?? '';
        if (Array.from(val).length > KB_DETAIL_FIELD_MAX) {
          setFormError(`${meta.label}不能超过 ${KB_DETAIL_FIELD_MAX} 字`);
          return null;
        }
      }
      return {
        name: trimmedName,
        mode: 'DETAIL',
        companyName,
        brandShort,
        directions: draft.detail.directions,
        copyTypes: draft.detail.copyTypes,
        fields: draft.detail.fields,
      };
    }

    const summaryText = draft.summary.summaryText.trim();
    if (!summaryText) {
      setFormError('请输入汇总信息');
      return null;
    }
    if (Array.from(summaryText).length > KB_SUMMARY_MAX) {
      setFormError(`汇总信息不能超过 ${KB_SUMMARY_MAX} 字`);
      return null;
    }
    return {
      name: trimmedName,
      mode: 'SUMMARY',
      summaryText,
    };
  }

  async function handleSave() {
    setFormError(null);
    if (!agreement.signed) {
      setFormError(KB_UNSIGNED_ERROR_MSG);
      openAgreementModal();
      return;
    }

    const payload = validateAndBuildPayload();
    if (!payload) return;

    setSubmitting(true);
    try {
      const saved = draft.editingId
        ? await client.update(draft.editingId, payload)
        : await client.create(payload);
      setModalOpen(false);
      setSelectedIds([]);
      setPage(1);
      setReloadTick((n) => n + 1);
      setBanner({
        type: 'success',
        text:
          saved.indexStatus === 'INDEXING'
            ? `已保存「${saved.name}」，后台正在分段建立智能检索，完成后状态将更新为「可用」`
            : `已保存知识库「${saved.name}」`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '保存失败';
      setFormError(msg);
      if (msg.includes('承诺协议')) {
        setAgreement((prev) => ({ ...prev, signed: false, signatureId: null }));
        openAgreementModal();
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteIds || deleteIds.length === 0) return;
    setDeleting(true);
    try {
      const res = await client.bulkDelete(deleteIds);
      setDeleteIds(null);
      setSelectedIds([]);
      setReloadTick((n) => n + 1);
      setBanner({ type: 'success', text: `已删除 ${res.deleted} 个企业知识库` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '删除失败';
      setBanner({ type: 'error', text: msg });
      setDeleteIds(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleExport(format: 'csv' | 'xlsx') {
    try {
      const file = await client.download(
        { page: 1, pageSize, q: search.keyword.trim() || undefined },
        format,
      );
      triggerBlobDownload(file);
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '导出失败',
      });
    }
  }

  // Strictly 5 columns per Issue #13: 名称、类型、公司名、创建时间、操作（无序号列、无独立状态列）
  const columns: CrudColumn<KnowledgeBaseRecord>[] = [
    {
      key: 'name',
      title: '名称',
      width: 240,
      hideable: false,
      render: (row) => <TableClampText text={row.name} lines={2} strong maxWidth={320} />,
    },
    {
      key: 'mode',
      title: '类型',
      width: 190,
      render: (row) => (
        <Space size={4}>
          <Tag color={row.mode === 'DETAIL' ? 'blue' : 'purple'}>{KB_MODE_LABELS[row.mode]}</Tag>
          {row.mode === 'SUMMARY' && row.indexStatus !== 'NONE' ? (
            <Tag color={indexStatusColor(row.indexStatus)}>
              {KB_INDEX_STATUS_LABELS[row.indexStatus]}
            </Tag>
          ) : null}
        </Space>
      ),
    },
    {
      key: 'companyName',
      title: '公司名',
      width: 220,
      render: (row) =>
        row.mode === 'DETAIL' && row.companyName ? (
          <TableClampText text={row.companyName} lines={2} maxWidth={280} />
        ) : (
          '-'
        ),
    },
    {
      key: 'createdAt',
      title: '创建时间',
      width: 168,
      render: (row) => formatShanghaiDateTime(row.createdAt),
    },
    {
      key: 'actions',
      title: '操作',
      width: 150,
      hideable: false,
      render: (row) => (
        <Space size={8}>
          <Button size="small" type="link" disabled={readOnly} onClick={() => openEditModal(row)}>
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            danger
            disabled={readOnly}
            onClick={() => setDeleteIds([row.id])}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <section>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>

      {banner ? (
        <Alert
          style={{ marginBottom: 12 }}
          type={banner.type}
          showIcon
          closable
          message={banner.text}
          onClose={() => setBanner(null)}
        />
      ) : null}

      <CrudTable
        rows={rows}
        columns={columns}
        total={total}
        page={page}
        pageSize={pageSize}
        loading={loading}
        selectedIds={selectedIds}
        searchOpen={searchOpen}
        searchPlaceholder="搜索知识库、公司或品牌简称"
        search={search}
        writeDisabled={readOnly}
        toolbarOrder="create-first"
        onSearchOpenChange={setSearchOpen}
        onSearch={(next) => {
          setPage(1);
          setSearch(next);
        }}
        onPageChange={(nextPage, nextSize) => {
          setPage(nextPage);
          setPageSize(nextSize);
        }}
        onSelectionChange={setSelectedIds}
        onExport={handleExport}
        onRefresh={() => setReloadTick((n) => n + 1)}
        onCreate={openCreateModal}
        onDelete={() => setDeleteIds(selectedIds)}
      />

      {/* 添加 / 编辑企业知识库弹窗 */}
      <Modal
        title={draft.editingId ? '编辑企业知识库' : '添加企业知识库'}
        open={modalOpen}
        width={780}
        transitionName=""
        maskTransitionName=""
        confirmLoading={submitting}
        okText="确定"
        cancelText="取消"
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <span>{KB_WARNING_BANNER_TEXT}</span>
              <Space size={8}>
                {agreement.signed ? <Tag color="success">已签署承诺协议</Tag> : null}
                <Button type="link" style={{ padding: 0 }} onClick={openAgreementModal}>
                  查看必读承诺协议
                </Button>
              </Space>
            </div>
          }
        />

        {formError ? (
          <div ref={errorAlertRef}>
            <Alert type="error" showIcon style={{ marginBottom: 12 }} message={formError} />
          </div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <Typography.Text strong>
              <span style={{ color: 'var(--gm-danger)' }}>* </span>知识库名称
            </Typography.Text>
            <Input
              aria-label="知识库名称"
              style={{ marginTop: 6 }}
              maxLength={KB_NAME_MAX}
              placeholder="请输入知识库名称"
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
            />
          </div>

          <div>
            <Typography.Text strong style={{ marginRight: 12 }}>
              录入模式
            </Typography.Text>
            <Radio.Group
              value={draft.mode}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, mode: e.target.value as KbModeName }))
              }
            >
              <Radio value="DETAIL">细分模式</Radio>
              <Radio value="SUMMARY">汇总模式</Radio>
            </Radio.Group>
          </div>

          {draft.mode === 'DETAIL' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <Typography.Text strong>
                    <span style={{ color: 'var(--gm-danger)' }}>* </span>公司名称
                  </Typography.Text>
                  <Input
                    aria-label="公司名称"
                    style={{ marginTop: 6 }}
                    maxLength={KB_COMPANY_MAX}
                    placeholder="请输入完整公司名称"
                    value={draft.detail.companyName}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        detail: { ...prev.detail, companyName: e.target.value },
                      }))
                    }
                  />
                </div>
                <div>
                  <Typography.Text strong>
                    <span style={{ color: 'var(--gm-danger)' }}>* </span>品牌简称
                  </Typography.Text>
                  <Input
                    aria-label="品牌简称"
                    style={{ marginTop: 6 }}
                    maxLength={KB_BRAND_SHORT_MAX}
                    placeholder="请输入品牌简称"
                    value={draft.detail.brandShort}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        detail: { ...prev.detail, brandShort: e.target.value },
                      }))
                    }
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <Typography.Text strong>
                    <span style={{ color: 'var(--gm-danger)' }}>* </span>创作方向
                  </Typography.Text>
                  <Select
                    aria-label="创作方向"
                    mode="multiple"
                    allowClear
                    style={{ width: '100%', marginTop: 6 }}
                    placeholder="请选择创作方向（可多选）"
                    options={directionOptions}
                    value={draft.detail.directions}
                    onChange={(values) =>
                      setDraft((prev) => ({
                        ...prev,
                        detail: { ...prev.detail, directions: values },
                      }))
                    }
                  />
                </div>
                <div>
                  <Typography.Text strong>
                    <span style={{ color: 'var(--gm-danger)' }}>* </span>文案类型
                  </Typography.Text>
                  <Select
                    aria-label="文案类型"
                    mode="multiple"
                    allowClear
                    style={{ width: '100%', marginTop: 6 }}
                    placeholder="请选择文案类型（可多选）"
                    options={copyTypeOptions}
                    value={draft.detail.copyTypes}
                    onChange={(values) =>
                      setDraft((prev) => ({
                        ...prev,
                        detail: { ...prev.detail, copyTypes: values },
                      }))
                    }
                  />
                </div>
              </div>

              {KB_DETAIL_FIELDS_META.map((field) => {
                const val = draft.detail.fields[field.key] ?? '';
                return (
                  <div key={field.key}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <Space size={8}>
                        <Typography.Text strong>{field.label}</Typography.Text>
                        {field.help ? (
                          <Button
                            type="link"
                            size="small"
                            style={{ padding: 0 }}
                            aria-label={`查看说明-${field.label}`}
                            onClick={() => setHelpField(field)}
                          >
                            查看说明
                          </Button>
                        ) : null}
                      </Space>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {Array.from(val).length}/{KB_DETAIL_FIELD_MAX}
                      </Typography.Text>
                    </div>
                    <Input.TextArea
                      aria-label={field.label}
                      style={{ marginTop: 4 }}
                      rows={3}
                      maxLength={KB_DETAIL_FIELD_MAX}
                      placeholder={field.placeholder}
                      value={val}
                      onChange={(e) => updateDetailField(field.key, e.target.value)}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Typography.Text strong>
                  <span style={{ color: 'var(--gm-danger)' }}>* </span>汇总信息
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {Array.from(draft.summary.summaryText).length}/{KB_SUMMARY_MAX}
                </Typography.Text>
              </div>
              <Input.TextArea
                aria-label="汇总信息"
                style={{ marginTop: 6 }}
                rows={10}
                maxLength={KB_SUMMARY_MAX}
                placeholder="请输入企业综合介绍、主营产品与参数、服务流程、资质与脱敏案例（上限 20000 字）"
                value={draft.summary.summaryText}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    summary: { summaryText: e.target.value },
                  }))
                }
              />
              <Typography.Paragraph
                type="secondary"
                style={{ marginTop: 6, marginBottom: 0, fontSize: 12 }}
              >
                说明：汇总资料 6000 字以内写作时完整带入参考；超过 6000
                字保存后自动分段建立智能检索，准备完成后状态更新为「可用」。
              </Typography.Paragraph>
            </div>
          )}
        </div>
      </Modal>

      {/* 字段「查看说明」预览弹窗 */}
      <Modal
        title="预览"
        open={Boolean(helpField)}
        transitionName=""
        maskTransitionName=""
        footer={[
          <Button key="close" type="primary" onClick={() => setHelpField(null)}>
            知道了
          </Button>,
        ]}
        onCancel={() => setHelpField(null)}
      >
        {helpField?.help ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              {helpField.label}
            </Typography.Title>
            <div>
              <Typography.Text strong>内容：</Typography.Text>
              <Typography.Paragraph style={{ marginBottom: 0, marginTop: 4 }}>
                {helpField.help.content}
              </Typography.Paragraph>
            </div>
            <div>
              <Typography.Text strong>说明：</Typography.Text>
              <Typography.Paragraph style={{ marginBottom: 0, marginTop: 4 }}>
                {helpField.help.explanation}
              </Typography.Paragraph>
            </div>
            <div>
              <Typography.Text strong>实例：</Typography.Text>
              <Typography.Paragraph
                style={{
                  marginBottom: 0,
                  marginTop: 4,
                  background: 'var(--gm-bg-elevated)',
                  padding: 10,
                  borderRadius: 6,
                }}
              >
                {helpField.help.example}
              </Typography.Paragraph>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* 必读承诺协议弹窗（滚动到底部解锁勾选与确认按钮） */}
      <Modal
        title={KB_AGREEMENT_TITLE}
        open={agreementOpen}
        width={640}
        transitionName=""
        maskTransitionName=""
        footer={[
          <Button key="cancel" onClick={() => setAgreementOpen(false)}>
            关闭
          </Button>,
          <Button
            key="confirm"
            type="primary"
            loading={signing}
            disabled={!scrolledBottom || !agreeChecked}
            onClick={handleSignAgreement}
          >
            {KB_AGREEMENT_CONFIRM_BUTTON_LABEL}
          </Button>,
        ]}
        onCancel={() => setAgreementOpen(false)}
      >
        <div
          data-testid="kb-agreement-scroll"
          onScroll={handleAgreementScroll}
          style={{
            maxHeight: 220,
            overflowY: 'auto',
            padding: '12px 14px',
            border: '1px solid var(--gm-line-1)',
            borderRadius: 6,
            background: 'var(--gm-bg-elevated)',
            lineHeight: 1.85,
          }}
        >
          {KB_AGREEMENT_PARAGRAPHS.map((para, idx) => (
            <Typography.Paragraph key={idx} style={{ marginBottom: 12 }}>
              {para}
            </Typography.Paragraph>
          ))}
        </div>

        <div style={{ marginTop: 12 }}>
          {!scrolledBottom ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 6, fontSize: 12 }}>
              请将上方协议正文滚动阅读至底部后勾选同意条款。
            </Typography.Paragraph>
          ) : null}
          <Checkbox
            disabled={!scrolledBottom}
            checked={agreeChecked}
            onChange={(e) => setAgreeChecked(e.target.checked)}
          >
            {KB_AGREEMENT_CHECKBOX_LABEL}
          </Checkbox>
        </div>
      </Modal>

      {/* 删除确认弹窗 */}
      <Modal
        title="确认删除企业知识库"
        open={Boolean(deleteIds)}
        transitionName=""
        maskTransitionName=""
        confirmLoading={deleting}
        okText="确认删除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        onOk={handleConfirmDelete}
        onCancel={() => setDeleteIds(null)}
      >
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          确定要删除选中的 {deleteIds?.length ?? 0} 个企业知识库吗？删除后关联检索内容将一并移除。
        </Typography.Paragraph>
      </Modal>
    </section>
  );
}
