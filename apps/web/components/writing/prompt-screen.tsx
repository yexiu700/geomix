'use client';

import {
  PROMPT_CONTENT_MAX,
  PROMPT_KINDS,
  PROMPT_KIND_LABELS,
  PROMPT_NAME_MAX,
  PROMPT_PLACEHOLDERS,
  analyzePromptWarnings,
  insertPlaceholderAtCursor,
  type CrudPageSize,
  type PromptKindName,
  type PromptTemplateRecord,
} from '@geomix/shared';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Input,
  Modal,
  Radio,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CrudTable, type CrudColumn, type CrudSearch } from '../crud/crud-table';
import { PromptApiError, httpPromptGateway, type PromptGateway } from '../../lib/prompts';
import { UX_TERMS, formatShanghaiDateTime, triggerBlobDownload } from '../../lib/ux-foundation';

type KindFilter = 'ALL' | PromptKindName;

type PromptFormDraft = {
  editingId: string | null;
  kind: PromptKindName;
  name: string;
  content: string;
};

function createEmptyDraft(defaultKind: PromptKindName = 'ARTICLE'): PromptFormDraft {
  return {
    editingId: null,
    kind: defaultKind,
    name: '',
    content: '',
  };
}

function kindTagColor(kind: PromptKindName): string {
  if (kind === 'ARTICLE') return 'blue';
  if (kind === 'TITLE') return 'cyan';
  return 'purple';
}

export function PromptScreen({
  title,
  readOnly = false,
  gateway,
}: {
  title: string;
  readOnly?: boolean;
  gateway?: PromptGateway;
}) {
  const client = useMemo(
    () =>
      gateway ??
      httpPromptGateway(
        typeof window === 'undefined'
          ? { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
          : window.sessionStorage,
      ),
    [gateway],
  );

  const [kindFilter, setKindFilter] = useState<KindFilter>('ALL');
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

  const [rows, setRows] = useState<PromptTemplateRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [banner, setBanner] = useState<{
    type: 'success' | 'info' | 'warning' | 'error';
    text: string;
  } | null>(null);

  // Add / Edit Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<PromptFormDraft>(() => createEmptyDraft('ARTICLE'));
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement | null>(null);

  // System Default Prompts Read-Only Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerKind, setDrawerKind] = useState<KindFilter>('ALL');
  const [systemItems, setSystemItems] = useState<PromptTemplateRecord[]>([]);
  const [systemLoading, setSystemLoading] = useState(false);
  const [cloningId, setCloningId] = useState<string | null>(null);

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
        kind: kindFilter === 'ALL' ? undefined : kindFilter,
        q: search.keyword.trim() || undefined,
      })
      .then((res) => {
        if (!active) return;
        setRows(res.items);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof PromptApiError && err.status !== 401) {
          setBanner({ type: 'error', text: err.message });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, page, pageSize, kindFilter, search.keyword, reloadTick]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    let active = true;
    setSystemLoading(true);
    client
      .listSystem(drawerKind === 'ALL' ? undefined : drawerKind)
      .then((res) => {
        if (active) setSystemItems(res.items);
      })
      .catch((err: unknown) => {
        if (active && err instanceof PromptApiError && err.status !== 401) {
          setBanner({ type: 'error', text: err.message });
        }
      })
      .finally(() => {
        if (active) setSystemLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, drawerOpen, drawerKind]);

  const liveWarnings = useMemo(
    () => analyzePromptWarnings(draft.kind, draft.content),
    [draft.kind, draft.content],
  );

  function openCreateModal() {
    setDraft(createEmptyDraft('ARTICLE'));
    setFormError(null);
    setModalOpen(true);
  }

  function openEditModal(row: PromptTemplateRecord) {
    setDraft({
      editingId: row.id,
      kind: row.kind,
      name: row.name,
      content: row.content,
    });
    setFormError(null);
    setModalOpen(true);
  }

  function handleInsertPlaceholder(token: string) {
    const el = contentRef.current;
    const { nextValue, nextCursor } = insertPlaceholderAtCursor(
      draft.content,
      token,
      el?.selectionStart,
      el?.selectionEnd,
    );
    setDraft((prev) => ({ ...prev, content: nextValue }));
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(nextCursor, nextCursor);
      });
    }
  }

  async function handleSave() {
    setFormError(null);
    const trimmedName = draft.name.trim();
    const trimmedContent = draft.content.trim();
    if (!trimmedName) {
      setFormError('请输入指令名称');
      return;
    }
    if (!trimmedContent) {
      setFormError('请输入指令内容');
      return;
    }

    setSubmitting(true);
    try {
      const saved = draft.editingId
        ? await client.update(draft.editingId, {
            kind: draft.kind,
            name: trimmedName,
            content: trimmedContent,
          })
        : await client.create({
            kind: draft.kind,
            name: trimmedName,
            content: trimmedContent,
          });
      setModalOpen(false);
      setSelectedIds([]);
      setPage(1);
      setReloadTick((n) => n + 1);
      setBanner({
        type: saved.warnings.length > 0 ? 'warning' : 'success',
        text:
          saved.warnings.length > 0
            ? `已保存指令「${saved.name}」（${saved.warnings[0]}）`
            : `已保存指令「${saved.name}」`,
      });
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCloneAndEdit(source: PromptTemplateRecord) {
    setCloningId(source.id);
    try {
      const cloned = await client.clone(source.id);
      setDrawerOpen(false);
      setReloadTick((n) => n + 1);
      setBanner({
        type: 'success',
        text: `已从「${source.name}」克隆副本，可直接修改内容后保存`,
      });
      openEditModal(cloned);
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '克隆指令失败',
      });
    } finally {
      setCloningId(null);
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
      setBanner({ type: 'success', text: `已删除 ${res.deleted} 条写作指令` });
    } catch (err: unknown) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '删除失败',
      });
      setDeleteIds(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleExport(format: 'csv' | 'xlsx') {
    try {
      const file = await client.download(
        {
          page: 1,
          pageSize,
          kind: kindFilter === 'ALL' ? undefined : kindFilter,
          q: search.keyword.trim() || undefined,
        },
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

  // Strictly aligned with Issue #14: 指令名称、创作类型、创建时间、操作
  const columns: CrudColumn<PromptTemplateRecord>[] = [
    {
      key: 'name',
      title: '指令名称',
      hideable: false,
      render: (row) => (
        <Space size={6} wrap>
          <Typography.Text strong>{row.name}</Typography.Text>
          {row.clonedFrom ? <Tag>克隆</Tag> : null}
          {!row.randomPool ? <Tag color="warning">{UX_TERMS.manualSlotBadge}</Tag> : null}
        </Space>
      ),
    },
    {
      key: 'kind',
      title: '创作类型',
      width: 150,
      render: (row) => <Tag color={kindTagColor(row.kind)}>{PROMPT_KIND_LABELS[row.kind]}</Tag>,
    },
    {
      key: 'createdAt',
      title: '创建时间',
      width: 180,
      render: (row) => formatShanghaiDateTime(row.createdAt),
    },
    {
      key: 'actions',
      title: '操作',
      width: 190,
      hideable: false,
      render: (row) => (
        <Space size={8}>
          <Button size="small" type="link" disabled={readOnly} onClick={() => openEditModal(row)}>
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            loading={cloningId === row.id}
            disabled={readOnly}
            onClick={() => handleCloneAndEdit(row)}
          >
            克隆
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
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 12,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        <Button onClick={() => setDrawerOpen(true)}>系统默认指令</Button>
      </div>

      <Alert
        style={{ marginBottom: 12 }}
        type="warning"
        showIcon
        message="编写指令时请合理嵌入 {训练词占位符} 与 {转化词占位符} 以保障主题聚焦与品牌转化，严禁包含医疗、网贷、博彩、违禁品等禁做行业及绝对化极限宣传用语。"
      />

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

      <div style={{ marginBottom: 12 }}>
        <Radio.Group
          optionType="button"
          buttonStyle="solid"
          value={kindFilter}
          onChange={(e) => {
            setKindFilter(e.target.value as KindFilter);
            setPage(1);
            setSelectedIds([]);
          }}
        >
          <Radio.Button value="ALL">全部类型</Radio.Button>
          {PROMPT_KINDS.map((k) => (
            <Radio.Button key={k} value={k}>
              {PROMPT_KIND_LABELS[k]}
            </Radio.Button>
          ))}
        </Radio.Group>
      </div>

      <CrudTable
        rows={rows}
        columns={columns}
        total={total}
        page={page}
        pageSize={pageSize}
        loading={loading}
        selectedIds={selectedIds}
        searchOpen={searchOpen}
        search={search}
        searchPlaceholder="搜索指令名称或正文"
        writeDisabled={readOnly}
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

      {/* 添加 / 编辑用户指令弹窗 */}
      <Modal
        title={draft.editingId ? '编辑写作指令' : '添加写作指令'}
        open={modalOpen}
        width={720}
        transitionName=""
        maskTransitionName=""
        confirmLoading={submitting}
        okText="确定"
        cancelText="取消"
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
      >
        {formError ? (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} message={formError} />
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <Typography.Text strong style={{ marginRight: 12 }}>
              <span style={{ color: 'var(--gm-danger)' }}>* </span>创作类型
            </Typography.Text>
            <Radio.Group
              value={draft.kind}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, kind: e.target.value as PromptKindName }))
              }
            >
              {PROMPT_KINDS.map((k) => (
                <Radio key={k} value={k}>
                  {PROMPT_KIND_LABELS[k]}
                </Radio>
              ))}
            </Radio.Group>
          </div>

          <div>
            <Typography.Text strong>
              <span style={{ color: 'var(--gm-danger)' }}>* </span>指令名称
            </Typography.Text>
            <Input
              aria-label="指令名称"
              style={{ marginTop: 6 }}
              maxLength={PROMPT_NAME_MAX}
              placeholder="请输入指令名称"
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
            />
          </div>

          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <Typography.Text strong>
                <span style={{ color: 'var(--gm-danger)' }}>* </span>指令内容
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {Array.from(draft.content).length}/{PROMPT_CONTENT_MAX}
              </Typography.Text>
            </div>

            <div
              style={{
                marginTop: 6,
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 6,
              }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                插入占位符：
              </Typography.Text>
              {PROMPT_PLACEHOLDERS.map((ph) => (
                <Tooltip key={ph.token} title={ph.description}>
                  <Button
                    size="small"
                    aria-label={`插入-${ph.label}`}
                    onClick={() => handleInsertPlaceholder(ph.token)}
                  >
                    {ph.token}
                  </Button>
                </Tooltip>
              ))}
            </div>

            <textarea
              ref={contentRef}
              aria-label="指令内容"
              rows={9}
              maxLength={PROMPT_CONTENT_MAX}
              placeholder="请输入提示词指令正文，可点击上方按钮快速插入变量占位符"
              value={draft.content}
              onChange={(e) => setDraft((prev) => ({ ...prev, content: e.target.value }))}
              style={{
                width: '100%',
                padding: '8px 11px',
                border: '1px solid var(--gm-line-2)',
                borderRadius: 6,
                fontSize: 14,
                lineHeight: 1.65,
                fontFamily: 'inherit',
                resize: 'vertical',
              }}
            />
          </div>

          {liveWarnings.map((warn, idx) => (
            <Alert key={idx} type="warning" showIcon message={warn} />
          ))}
        </div>
      </Modal>

      {/* 系统默认指令只读抽屉（支持按类型筛选、查看完整正文、一键克隆后编辑） */}
      <Drawer
        title="系统默认指令（只读）"
        open={drawerOpen}
        width={680}
        onClose={() => setDrawerOpen(false)}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="系统默认指令为平台内置只读模板，支持直接查看完整提示词正文；如需自定义调整（如填写【品牌1】槽位），请点击「克隆并编辑」。"
        />

        <div style={{ marginBottom: 14 }}>
          <Radio.Group
            optionType="button"
            buttonStyle="solid"
            value={drawerKind}
            onChange={(e) => setDrawerKind(e.target.value as KindFilter)}
          >
            <Radio.Button value="ALL">全部</Radio.Button>
            {PROMPT_KINDS.map((k) => (
              <Radio.Button key={k} value={k}>
                {PROMPT_KIND_LABELS[k]}
              </Radio.Button>
            ))}
          </Radio.Group>
        </div>

        {systemLoading ? (
          <Typography.Paragraph type="secondary">正在加载系统默认指令...</Typography.Paragraph>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {systemItems.map((tpl) => (
              <Card
                key={tpl.id}
                size="small"
                title={
                  <Space size={6} wrap>
                    <span>{tpl.name}</span>
                    <Tag color={kindTagColor(tpl.kind)}>{PROMPT_KIND_LABELS[tpl.kind]}</Tag>
                    <Tag>只读</Tag>
                    {!tpl.randomPool ? <Tag color="warning">含手工槽位·不入随机池</Tag> : null}
                  </Space>
                }
                extra={
                  <Button
                    size="small"
                    type="primary"
                    loading={cloningId === tpl.id}
                    disabled={readOnly}
                    aria-label={`克隆-${tpl.name}`}
                    onClick={() => handleCloneAndEdit(tpl)}
                  >
                    克隆并编辑
                  </Button>
                }
              >
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    lineHeight: 1.7,
                    color: 'var(--gm-fg-1)',
                    background: 'var(--gm-bg-elevated)',
                    padding: '8px 10px',
                    borderRadius: 6,
                  }}
                >
                  {tpl.content}
                </pre>
              </Card>
            ))}
          </div>
        )}
      </Drawer>

      {/* 删除确认弹窗 */}
      <Modal
        title="确认删除写作指令"
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
          确定要删除选中的 {deleteIds?.length ?? 0} 条写作指令吗？
        </Typography.Paragraph>
      </Modal>
    </section>
  );
}
