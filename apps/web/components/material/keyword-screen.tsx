'use client';

import {
  API_ERROR,
  COMBO_MAX,
  EXPANDER_WORD_PACKS,
  KEYWORD_OPT_LABELS,
  buildKeywordCombos,
  normalizeQuestionKey,
  validateMainKeyword,
  type KeywordListQuery,
  type KeywordOptStatusName,
  type KeywordRecord,
  type QuestionSourceName,
} from '@geomix/shared';
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { KeywordApiError, httpKeywordGateway, type KeywordGateway } from '../../lib/keywords';
import type { PriceItem } from '../../lib/samples';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import { UX_TERMS, formatShanghaiDateTime, triggerBlobDownload } from '../../lib/ux-foundation';
import { CrudModal } from '../crud/crud-modal';
import { CrudTable } from '../crud/crud-table';
import { useUxFeedback } from '../crud/ux-feedback';

type KeywordDraft = {
  main: string;
  brands: string;
  questionsText: string;
};

const EMPTY_DRAFT: KeywordDraft = {
  main: '',
  brands: '',
  questionsText: '',
};

type EditorState = {
  mode: 'create' | 'edit';
  id?: string;
  initial: KeywordDraft;
  draft: KeywordDraft;
  minimized: boolean;
  maximized: boolean;
};

type PreviewModalState = {
  title: string;
  source: QuestionSourceName;
  candidates: string[];
  selected: string[];
  truncated?: boolean;
};

export function KeywordScreen({
  title,
  tabId,
  readOnly = false,
  gateway,
  storage,
  onDispatch,
}: {
  title: string;
  tabId: string;
  readOnly?: boolean;
  gateway?: KeywordGateway;
  storage?: SessionStorageLike;
  onDispatch?: (action: ShellAction) => void;
}) {
  const feedback = useUxFeedback();
  const client = useMemo(
    () => gateway ?? httpKeywordGateway(storage ?? window.sessionStorage),
    [gateway, storage],
  );
  const [query, setQuery] = useState<KeywordListQuery>({
    page: 1,
    pageSize: 10,
    keyword: '',
    optStatus: undefined,
    sort: 'createdAt',
    order: 'desc',
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [rows, setRows] = useState<KeywordRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [prices, setPrices] = useState<PriceItem[] | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [sourceRegistry, setSourceRegistry] = useState<Record<string, QuestionSourceName>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<string[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [locked, setLocked] = useState(false);

  // Distill confirmation, loading & constructive fallback
  const [distillConfirmOpen, setDistillConfirmOpen] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [distillFallback, setDistillFallback] = useState<string | null>(null);

  // Preview checkbox modal (shared by AI distill & manual combo)
  const [preview, setPreview] = useState<PreviewModalState | null>(null);

  // Manual batch combo modal
  const [comboOpen, setComboOpen] = useState(false);
  const [comboPrefixes, setComboPrefixes] = useState('');
  const [comboMains, setComboMains] = useState('');
  const [comboSuffixes, setComboSuffixes] = useState('');
  const [includeEmptyPrefix, setIncludeEmptyPrefix] = useState(false);
  const [includeEmptySuffix, setIncludeEmptySuffix] = useState(false);
  const [comboError, setComboError] = useState<string | null>(null);

  // Free expander modal (editable word packs)
  const [expanderOpen, setExpanderOpen] = useState(false);
  const [packTexts, setPackTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(EXPANDER_WORD_PACKS.map((p) => [p.key, p.words.join('\n')])),
  );
  const [selectedPacks, setSelectedPacks] = useState<string[]>(['region', 'question']);

  const writeLocked = readOnly || locked;
  const distillUnitPrice = prices?.find((item) => item.action === 'distill')?.unitPoints ?? 10;

  useEffect(() => {
    let live = true;
    setLoading(true);
    void client.list(query).then(
      (page) => {
        if (!live) return;
        setRows(page.items);
        setTotal(page.total);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!live) return;
        if (reason instanceof KeywordApiError && reason.status === 401) {
          setLoading(false);
          return;
        }
        setError(messageOf(reason));
        noteLock(reason, setLocked);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [client, query, reloadKey]);

  useEffect(() => {
    let live = true;
    void client.prices().then(
      (items) => {
        if (!live) return;
        setPrices(items);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client]);

  const liveComboPreview = useMemo(() => {
    if (!comboOpen || !editor) return null;
    return buildKeywordCombos({
      mainKeyword: editor.draft.main,
      prefixesText: comboPrefixes,
      mainsText: comboMains,
      suffixesText: comboSuffixes,
      includeEmptyPrefix,
      includeEmptySuffix,
    });
  }, [
    comboOpen,
    editor,
    comboPrefixes,
    comboMains,
    comboSuffixes,
    includeEmptyPrefix,
    includeEmptySuffix,
  ]);

  async function openEdit(row: KeywordRecord): Promise<void> {
    if (writeLocked) return;
    setError(null);
    try {
      const detail = await client.one(row.id);
      const nextRegistry: Record<string, QuestionSourceName> = {};
      for (const q of detail.questions) {
        nextRegistry[normalizeQuestionKey(q.text)] = q.source;
      }
      setSourceRegistry(nextRegistry);
      const initial: KeywordDraft = {
        main: detail.main,
        brands: detail.brands.join('，'),
        questionsText: detail.questions.map((q) => q.text).join('\n'),
      };
      setFormError(null);
      setDistillFallback(null);
      setEditor({
        mode: 'edit',
        id: detail.id,
        initial,
        draft: initial,
        minimized: false,
        maximized: false,
      });
    } catch (reason) {
      setError(messageOf(reason));
      noteLock(reason, setLocked);
    }
  }

  async function save(): Promise<void> {
    if (!editor || saving || writeLocked) return;
    const checked = validateMainKeyword(editor.draft.main);
    if (!checked.ok) {
      setFormError(checked.message);
      return;
    }
    setSaving(true);
    setFormError(null);
    const lines = editor.draft.questionsText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const questionItems = lines.map((text) => ({
      text,
      source: sourceRegistry[normalizeQuestionKey(text)] ?? 'MANUAL',
    }));
    try {
      if (editor.mode === 'create') {
        const res = await client.create({
          main: checked.value,
          brands: editor.draft.brands,
          questionsText: editor.draft.questionsText,
          questionItems,
        });
        const msg =
          res.skippedDuplicates > 0
            ? `已保存${UX_TERMS.mainKeyword}「${res.keyword.main}」，新增 ${res.addedQuestions} 条问题（自动跳过 ${res.skippedDuplicates} 条重复问题）`
            : `已保存${UX_TERMS.mainKeyword}「${res.keyword.main}」，共写入 ${res.addedQuestions} 条拓展问题`;
        setNotice(msg);
        feedback.notifySuccess(msg);
      } else if (editor.id) {
        const res = await client.update(editor.id, {
          main: checked.value,
          brands: editor.draft.brands,
          questionsText: editor.draft.questionsText,
          questionItems,
        });
        const msg = `已更新${UX_TERMS.mainKeyword}「${res.keyword.main}」，当前共 ${res.keyword.questionCount} 条问题`;
        setNotice(msg);
        feedback.notifySuccess(msg);
      }
      setEditor(null);
      setDistillFallback(null);
      setReloadKey((v) => v + 1);
    } catch (reason) {
      const msg = messageOf(reason);
      setFormError(msg);
      feedback.notifyError(msg);
      noteLock(reason, setLocked);
    } finally {
      setSaving(false);
    }
  }

  function requestDistill(): void {
    if (!editor || distilling || writeLocked) return;
    const checked = validateMainKeyword(editor.draft.main);
    if (!checked.ok) {
      setFormError(checked.message);
      return;
    }
    setFormError(null);
    setDistillFallback(null);
    setDistillConfirmOpen(true);
  }

  async function executeDistill(): Promise<void> {
    if (!editor || distilling || writeLocked) return;
    const checked = validateMainKeyword(editor.draft.main);
    if (!checked.ok) {
      setDistillConfirmOpen(false);
      setFormError(checked.message);
      return;
    }
    setDistilling(true);
    setFormError(null);
    setDistillFallback(null);
    try {
      const idem = `distill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await client.distill({
        main: checked.value,
        brands: editor.draft.brands,
        idempotencyKey: idem,
      });
      setDistillConfirmOpen(false);
      setPreview({
        title: `AI蒸馏结果预览（共 ${res.questions.length} 条，${res.shadow ? `记账 ${res.charged} 点·免费期` : `已计 ${res.charged} 点`}）`,
        source: 'AI',
        candidates: res.questions,
        selected: [...res.questions],
      });
    } catch (reason) {
      setDistillConfirmOpen(false);
      const msg = messageOf(reason);
      setFormError(msg);
      setDistillFallback(msg);
      noteLock(reason, setLocked);
    } finally {
      setDistilling(false);
    }
  }

  function openComboModal(): void {
    if (!editor) return;
    const checked = validateMainKeyword(editor.draft.main);
    if (!checked.ok) {
      setFormError(checked.message);
      return;
    }
    setFormError(null);
    setComboError(null);
    if (!comboMains.trim()) {
      setComboMains(checked.value);
    }
    setComboOpen(true);
  }

  function confirmComboToPreview(): void {
    if (!editor) return;
    const built = buildKeywordCombos({
      mainKeyword: editor.draft.main,
      prefixesText: comboPrefixes,
      mainsText: comboMains,
      suffixesText: comboSuffixes,
      includeEmptyPrefix,
      includeEmptySuffix,
    });
    if (!built.ok) {
      setComboError(built.error);
      return;
    }
    setComboError(null);
    setComboOpen(false);
    setPreview({
      title: `手动批量组合预览（${built.prefixCount} × ${built.mainCount} × ${built.suffixCount}，共 ${built.items.length} 条）`,
      source: 'COMBO',
      candidates: built.items,
      selected: [...built.items],
      truncated: built.truncated,
    });
  }

  function applyPreviewToTextarea(): void {
    if (!preview || !editor) return;
    const existingLines = editor.draft.questionsText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const existingKeys = new Set(existingLines.map(normalizeQuestionKey));
    const additions: string[] = [];
    const nextSources = { ...sourceRegistry };
    for (const item of preview.selected) {
      const key = normalizeQuestionKey(item);
      if (!key) continue;
      nextSources[key] = preview.source;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        additions.push(item);
      }
    }
    setSourceRegistry(nextSources);
    const merged = [...existingLines, ...additions].join('\n');
    setEditor((current) =>
      current ? { ...current, draft: { ...current.draft, questionsText: merged } } : current,
    );
    setPreview(null);
  }

  function fillComboFromExpander(mode: 'to_combo' | 'direct_preview'): void {
    if (!editor) return;
    const checked = validateMainKeyword(editor.draft.main);
    if (!checked.ok) {
      setExpanderOpen(false);
      setFormError(checked.message);
      return;
    }
    const chosenPrefixes: string[] = [];
    const chosenSuffixes: string[] = [];
    for (const pack of EXPANDER_WORD_PACKS) {
      if (!selectedPacks.includes(pack.key)) continue;
      const lines = (packTexts[pack.key] ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (pack.target === 'prefix') chosenPrefixes.push(...lines);
      else chosenSuffixes.push(...lines);
    }
    const nextPref = [...new Set(chosenPrefixes)].join('\n');
    const nextSuf = [...new Set(chosenSuffixes)].join('\n');
    setComboPrefixes(nextPref);
    setComboMains(checked.value);
    setComboSuffixes(nextSuf);
    setExpanderOpen(false);

    if (mode === 'to_combo') {
      setComboError(null);
      setComboOpen(true);
      return;
    }

    const built = buildKeywordCombos({
      mainKeyword: checked.value,
      prefixesText: nextPref,
      mainsText: checked.value,
      suffixesText: nextSuf,
      includeEmptyPrefix: true,
      includeEmptySuffix: false,
    });
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    setPreview({
      title: `拓词回填预览（免费，共 ${built.items.length} 条）`,
      source: 'COMBO',
      candidates: built.items,
      selected: [...built.items],
      truncated: built.truncated,
    });
  }

  async function executeDelete(ids: string[]): Promise<void> {
    if (writeLocked || ids.length === 0) return;
    setError(null);
    try {
      await client.bulkDelete(ids);
      setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
      setConfirmDeleteIds(null);
      setReloadKey((v) => v + 1);
    } catch (reason) {
      setConfirmDeleteIds(null);
      setError(messageOf(reason));
      noteLock(reason, setLocked);
    }
  }

  async function download(format: 'csv' | 'xlsx'): Promise<void> {
    try {
      const file = await client.download(query, format);
      triggerBlobDownload({ body: file.body, filename: file.filename, mime: file.mime });
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  return (
    <section>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        管理{UX_TERMS.mainKeyword}与公司品牌词，支持 AI
        蒸馏拓展、手动批量三栏组合及免费拓词词包回填。保存后拓展问题立即同步至写作标题列表。
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {notice ? (
        <Alert
          type="success"
          showIcon
          closable
          message={notice}
          onClose={() => setNotice(null)}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <Space style={{ marginBottom: 12 }} wrap>
        <span>优化状态筛选：</span>
        <Select<KeywordOptStatusName | 'ALL'>
          aria-label="优化状态筛选"
          value={query.optStatus ?? 'ALL'}
          style={{ width: 140 }}
          options={[
            { value: 'ALL', label: '全部状态' },
            { value: 'NONE', label: '未优化' },
            { value: 'OPTIMIZING', label: '优化中' },
            { value: 'INCLUDED', label: '已收录' },
          ]}
          onChange={(val) =>
            setQuery((curr) => ({
              ...curr,
              page: 1,
              optStatus: val === 'ALL' ? undefined : val,
            }))
          }
        />
      </Space>

      <CrudTable
        rows={rows}
        total={total}
        page={query.page}
        pageSize={query.pageSize}
        loading={loading}
        selectedIds={selectedIds}
        searchOpen={searchOpen}
        searchPlaceholder="搜索主关键词或品牌词"
        writeDisabled={writeLocked}
        search={{
          keyword: query.keyword,
          enabled: undefined,
          sort: query.sort,
          order: query.order,
        }}
        sortOptions={[
          { value: 'createdAt', label: '创建时间' },
          { value: 'main', label: UX_TERMS.mainKeyword },
        ]}
        onSearchOpenChange={setSearchOpen}
        onSearch={(search) => {
          setSelectedIds([]);
          setQuery((curr) => ({
            ...curr,
            page: 1,
            keyword: search.keyword,
            sort: search.sort === 'main' ? 'main' : 'createdAt',
            order: search.order,
          }));
        }}
        onPageChange={(page, pageSize) => {
          setSelectedIds([]);
          setQuery((curr) => ({ ...curr, page, pageSize }));
        }}
        onSelectionChange={setSelectedIds}
        onExport={download}
        onRefresh={() => setReloadKey((v) => v + 1)}
        onCreate={
          writeLocked
            ? undefined
            : () => {
                setFormError(null);
                setDistillFallback(null);
                setSourceRegistry({});
                setEditor({
                  mode: 'create',
                  initial: EMPTY_DRAFT,
                  draft: EMPTY_DRAFT,
                  minimized: false,
                  maximized: false,
                });
              }
        }
        toolbarOrder="create-first"
        onDelete={writeLocked ? undefined : () => setConfirmDeleteIds(selectedIds)}
        columns={[
          {
            key: 'seq',
            title: '序号',
            width: 72,
            hideable: false,
            render: (_row, index) => (query.page - 1) * query.pageSize + index + 1,
          },
          {
            key: 'main',
            title: UX_TERMS.mainKeyword,
            hideable: false,
            render: (row) => (
              <Space direction="vertical" size={2}>
                <strong>{row.main}</strong>
                {row.brands.length > 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    品牌：{row.brands.join('、')}
                  </Typography.Text>
                ) : null}
              </Space>
            ),
          },
          {
            key: 'questionCount',
            title: '问题数量',
            width: 110,
            render: (row) => (
              <Button
                type="link"
                style={{ padding: 0 }}
                onClick={() =>
                  onDispatch?.({
                    type: 'open',
                    href: `/material/questions?keywordId=${encodeURIComponent(row.id)}`,
                    sourceId: tabId,
                  })
                }
              >
                {row.questionCount}
              </Button>
            ),
          },
          {
            key: 'optStatus',
            title: '优化状态',
            width: 110,
            render: (row) => (
              <Tag
                color={
                  row.optStatus === 'INCLUDED'
                    ? 'success'
                    : row.optStatus === 'OPTIMIZING'
                      ? 'processing'
                      : 'default'
                }
              >
                {KEYWORD_OPT_LABELS[row.optStatus]}
              </Tag>
            ),
          },
          {
            key: 'createdAt',
            title: '创建时间',
            width: 156,
            render: (row) => formatShanghaiDateTime(row.createdAt),
          },
          {
            key: 'actions',
            title: '操作',
            width: 210,
            hideable: false,
            render: (row) => (
              <Space size={4}>
                <Button
                  size="small"
                  type="link"
                  onClick={() =>
                    onDispatch?.({
                      type: 'open',
                      href: `/material/questions?keywordId=${encodeURIComponent(row.id)}`,
                      sourceId: tabId,
                    })
                  }
                >
                  查看问题
                </Button>
                <Button
                  size="small"
                  type="link"
                  disabled={writeLocked}
                  onClick={() => void openEdit(row)}
                >
                  编辑
                </Button>
                <Button
                  size="small"
                  type="link"
                  danger
                  disabled={writeLocked}
                  onClick={() => setConfirmDeleteIds([row.id])}
                >
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <CrudModal
        open={editor !== null}
        title={editor?.mode === 'edit' ? '编辑关键词' : '添加关键词'}
        width={780}
        minimized={editor?.minimized ?? false}
        maximized={editor?.maximized ?? false}
        confirmLoading={saving}
        error={formError}
        onMinimize={() => setEditor((curr) => (curr ? { ...curr, minimized: true } : curr))}
        onRestore={() => setEditor((curr) => (curr ? { ...curr, minimized: false } : curr))}
        onMaximize={() =>
          setEditor((curr) => (curr ? { ...curr, maximized: !curr.maximized } : curr))
        }
        onClose={() => {
          setEditor(null);
          setFormError(null);
          setDistillFallback(null);
        }}
        onReset={() => {
          setFormError(null);
          setDistillFallback(null);
          setEditor((curr) => (curr ? { ...curr, draft: curr.initial } : curr));
        }}
        ok={
          <Button
            aria-label="确定"
            type="primary"
            loading={saving}
            disabled={writeLocked}
            onClick={() => void save()}
          >
            确定
          </Button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Typography.Text strong>
              <span style={{ color: 'var(--gm-danger)' }}>* </span>
              {UX_TERMS.mainKeyword}（必填，不少于 3 个字，只能填一个）
            </Typography.Text>
            <Input
              aria-label="主关键词"
              placeholder="请输入主关键词，只能一个，不低于 3 个字"
              value={editor?.draft.main ?? ''}
              onChange={(e) => {
                setDistillFallback(null);
                setEditor((curr) =>
                  curr ? { ...curr, draft: { ...curr.draft, main: e.target.value } } : curr,
                );
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Space size={6} align="center">
              <Typography.Text strong>
                公司或品牌 / 达标命中词（选填，多个词用逗号分隔）
              </Typography.Text>
              <Tooltip title="用于判断生成文章或 AI 回答是否成功提及您的品牌：回答中出现此处填写的任意公司名、品牌简称或产品词，即视为「达标命中 / 收录命中」。">
                <Button
                  type="text"
                  size="small"
                  aria-label="达标命中说明"
                  style={{ padding: '0 6px', height: 20, color: 'var(--gm-fg-3)' }}
                >
                  ?
                </Button>
              </Tooltip>
            </Space>
            <Input
              aria-label="公司或品牌"
              placeholder="请输入公司名、品牌简称等达标命中词，多个用逗号隔开（如：安克创新, Anker）"
              value={editor?.draft.brands ?? ''}
              onChange={(e) => {
                setDistillFallback(null);
                setEditor((curr) =>
                  curr ? { ...curr, draft: { ...curr.draft, brands: e.target.value } } : curr,
                );
              }}
            />
          </div>

          <Space wrap style={{ paddingTop: 2, paddingBottom: 2 }}>
            <Button
              type="primary"
              ghost
              loading={distilling}
              disabled={writeLocked}
              onClick={requestDistill}
            >
              {`AI蒸馏拓展（${distillUnitPrice}点/次）`}
            </Button>
            <Button disabled={writeLocked} onClick={openComboModal}>
              手动批量添加
            </Button>
            <Button
              disabled={writeLocked}
              onClick={() => {
                const checked = validateMainKeyword(editor?.draft.main ?? '');
                if (!checked.ok) {
                  setFormError(checked.message);
                  return;
                }
                setFormError(null);
                setExpanderOpen(true);
              }}
            >
              拓词工具
            </Button>
          </Space>

          {distillFallback ? (
            <Alert
              type="warning"
              showIcon
              message={`AI 蒸馏未生成足够的有效问题：${distillFallback}`}
              description={
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <span>
                    未扣除点数。建议换用更具体的品类词（如去掉过长修饰或确认「公司或品牌」未与主关键词重叠）后重试，也可立即使用免费拓词方案：
                  </span>
                  <Space wrap>
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      onClick={() => {
                        setFormError(null);
                        setExpanderOpen(true);
                      }}
                    >
                      改用免费拓词工具
                    </Button>
                    <Button size="small" onClick={openComboModal}>
                      改用手动批量添加
                    </Button>
                  </Space>
                </Space>
              }
            />
          ) : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Typography.Text strong>
              一行一个拓展问题（保存不收费；保存前可自由增删改，保存后占用写作问题配额）
            </Typography.Text>
            <Input.TextArea
              aria-label="一行一个拓展问题"
              rows={6}
              placeholder="每行输入一条包含主关键词的咨询问题"
              value={editor?.draft.questionsText ?? ''}
              onChange={(e) =>
                setEditor((curr) =>
                  curr
                    ? {
                        ...curr,
                        draft: { ...curr.draft, questionsText: e.target.value },
                      }
                    : curr,
                )
              }
            />
          </div>
        </div>
      </CrudModal>

      {/* AI蒸馏费用确认弹层 */}
      <Modal
        centered
        keyboard
        transitionName=""
        maskTransitionName=""
        open={distillConfirmOpen}
        title="确认执行 AI 蒸馏拓展"
        confirmLoading={distilling}
        okText={`确认蒸馏（${distillUnitPrice}点/次）`}
        cancelText="取消"
        onOk={() => void executeDistill()}
        onCancel={() => setDistillConfirmOpen(false)}
      >
        <p>
          将围绕{UX_TERMS.mainKeyword}「<strong>{editor?.draft.main.trim()}</strong>
          」生成潜在客户咨询问题。
        </p>
        <p>
          <strong>有效判定标准与计费说明：</strong>本次标价{' '}
          <strong>{distillUnitPrice} 点/次</strong>。系统需筛选出
          <strong>至少 5 条</strong>
          「完整包含主关键词、不含额外品牌词且与现有问题不重复」的合规问题才判定为有效。
        </p>
        <p style={{ marginBottom: 0 }}>
          <strong>不扣点保障：</strong>若有效问题不足 5 条或上游服务异常，系统
          <strong>不会扣除点数</strong>（预扣将自动全额退还）。返回后可勾选预览再追加到问题框。
        </p>
      </Modal>

      {/* 手动批量组合弹层 */}
      <Modal
        open={comboOpen}
        centered
        keyboard
        width={760}
        title="手动批量组合（免费）"
        okText="生成组合预览"
        cancelText="取消"
        transitionName=""
        maskTransitionName=""
        onOk={confirmComboToPreview}
        onCancel={() => setComboOpen(false)}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Typography.Text type="secondary">
            按「前缀 × 主词 × 后缀」生成组合。空前缀或空后缀列按 1
            个空项参与组合；也可开启「含空前缀项 / 含空后缀项」同时保留带词与不带词组合（上限{' '}
            {COMBO_MAX} 条）。
          </Typography.Text>
          {comboError ? <Alert type="error" showIcon message={comboError} /> : null}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
                <span>前缀（一行一个）</span>
                <label style={{ fontSize: 12 }}>
                  <Switch
                    size="small"
                    aria-label="含空前缀项"
                    checked={includeEmptyPrefix}
                    onChange={setIncludeEmptyPrefix}
                  />{' '}
                  含空项
                </label>
              </div>
              <Input.TextArea
                aria-label="组合前缀"
                rows={7}
                placeholder="如：华东&#10;深圳&#10;家用"
                value={comboPrefixes}
                onChange={(e) => setComboPrefixes(e.target.value)}
              />
            </div>
            <div>
              <div style={{ marginBottom: 4 }}>
                <span>
                  <span style={{ color: 'var(--gm-danger)' }}>* </span>
                  主词（每行须含{UX_TERMS.mainKeyword}）
                </span>
              </div>
              <Input.TextArea
                aria-label="组合主词"
                rows={7}
                placeholder={`每行必须包含当前${UX_TERMS.mainKeyword}`}
                value={comboMains}
                onChange={(e) => setComboMains(e.target.value)}
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
                <span>后缀（一行一个）</span>
                <label style={{ fontSize: 12 }}>
                  <Switch
                    size="small"
                    aria-label="含空后缀项"
                    checked={includeEmptySuffix}
                    onChange={setIncludeEmptySuffix}
                  />{' '}
                  含空项
                </label>
              </div>
              <Input.TextArea
                aria-label="组合后缀"
                rows={7}
                placeholder="如：哪家好&#10;值得买吗&#10;参数对比"
                value={comboSuffixes}
                onChange={(e) => setComboSuffixes(e.target.value)}
              />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography.Text>
              {liveComboPreview?.ok
                ? `预计组合数：${liveComboPreview.prefixCount} × ${liveComboPreview.mainCount} × ${liveComboPreview.suffixCount} = ${liveComboPreview.items.length} 条${liveComboPreview.truncated ? `（超出 ${COMBO_MAX} 已截断）` : ''}`
                : liveComboPreview
                  ? `校验提示：${liveComboPreview.error}`
                  : ''}
            </Typography.Text>
            <Button
              size="small"
              onClick={() => {
                setComboOpen(false);
                setExpanderOpen(true);
              }}
            >
              从拓词词包导入
            </Button>
          </div>
        </Space>
      </Modal>

      {/* 免费拓词工具弹层 */}
      <Modal
        open={expanderOpen}
        centered
        keyboard
        width={760}
        title="拓词工具（免费词包，不扣点）"
        transitionName=""
        maskTransitionName=""
        footer={
          <Space>
            <Button onClick={() => setExpanderOpen(false)}>取消</Button>
            <Button onClick={() => fillComboFromExpander('to_combo')}>回填到三栏组合编辑</Button>
            <Button type="primary" onClick={() => fillComboFromExpander('direct_preview')}>
              生成预览并回填当前表单
            </Button>
          </Space>
        }
        onCancel={() => setExpanderOpen(false)}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Typography.Text type="secondary">
            勾选并按需修改下方词包（支持消费品/数码场景与企业服务场景；前缀与后缀自动组合），不调用大模型、不消耗点数，可直接回填到当前关键词表单。
          </Typography.Text>
          <Space wrap size={8}>
            <Button
              size="small"
              onClick={() => setSelectedPacks(['consumerScene', 'question', 'consumerReview'])}
            >
              消费品/数码常用组合
            </Button>
            <Button
              size="small"
              onClick={() => setSelectedPacks(['region', 'service', 'question', 'recommend'])}
            >
              企业服务/工业常用组合
            </Button>
            <Button
              size="small"
              onClick={() => setSelectedPacks(EXPANDER_WORD_PACKS.map((p) => p.key))}
            >
              全选
            </Button>
          </Space>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {EXPANDER_WORD_PACKS.map((pack) => {
              const checked = selectedPacks.includes(pack.key);
              return (
                <div
                  key={pack.key}
                  style={{ border: '1px solid var(--gm-line-1)', borderRadius: 8, padding: 10 }}
                >
                  <Checkbox
                    checked={checked}
                    onChange={(e) =>
                      setSelectedPacks((curr) =>
                        e.target.checked ? [...curr, pack.key] : curr.filter((k) => k !== pack.key),
                      )
                    }
                  >
                    <strong>{pack.label}</strong>
                  </Checkbox>
                  <Input.TextArea
                    aria-label={pack.label}
                    rows={3}
                    style={{ marginTop: 8 }}
                    value={packTexts[pack.key] ?? ''}
                    onChange={(e) =>
                      setPackTexts((curr) => ({ ...curr, [pack.key]: e.target.value }))
                    }
                  />
                </div>
              );
            })}
          </div>
        </Space>
      </Modal>

      {/* 勾选预览弹层（蒸馏与组合共用） */}
      <Modal
        open={preview !== null}
        centered
        keyboard
        width={680}
        title={preview?.title ?? '结果预览'}
        okText={`添加到问题框（已选 ${preview?.selected.length ?? 0} 条）`}
        cancelText="取消"
        transitionName=""
        maskTransitionName=""
        okButtonProps={{ disabled: (preview?.selected.length ?? 0) === 0 }}
        onOk={applyPreviewToTextarea}
        onCancel={() => setPreview(null)}
      >
        {preview ? (
          <Space direction="vertical" style={{ width: '100%' }} size={10}>
            {preview.truncated ? (
              <Alert
                type="warning"
                showIcon
                message={`组合总数超过 ${COMBO_MAX} 条上限，已自动保留前 ${COMBO_MAX} 条。`}
              />
            ) : null}
            <Space>
              <Button
                size="small"
                onClick={() =>
                  setPreview((curr) => (curr ? { ...curr, selected: [...curr.candidates] } : curr))
                }
              >
                全选
              </Button>
              <Button
                size="small"
                onClick={() =>
                  setPreview((curr) =>
                    curr
                      ? {
                          ...curr,
                          selected: curr.candidates.filter((item) => !curr.selected.includes(item)),
                        }
                      : curr,
                  )
                }
              >
                反选
              </Button>
              <Button
                size="small"
                onClick={() => setPreview((curr) => (curr ? { ...curr, selected: [] } : curr))}
              >
                清空勾选
              </Button>
            </Space>
            <div
              style={{
                maxHeight: 320,
                overflowY: 'auto',
                border: '1px solid var(--gm-line-1)',
                borderRadius: 6,
                padding: 10,
              }}
            >
              <Checkbox.Group
                style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                value={preview.selected}
                onChange={(vals) =>
                  setPreview((curr) => (curr ? { ...curr, selected: vals as string[] } : curr))
                }
              >
                {preview.candidates.map((item) => (
                  <Checkbox key={item} value={item}>
                    {item}
                  </Checkbox>
                ))}
              </Checkbox.Group>
            </div>
          </Space>
        ) : null}
      </Modal>

      {/* 删除确认弹层 */}
      <Modal
        open={confirmDeleteIds !== null}
        centered
        keyboard
        title="确认删除关键词"
        okText="确认删除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        transitionName=""
        maskTransitionName=""
        onOk={() => void executeDelete(confirmDeleteIds ?? [])}
        onCancel={() => setConfirmDeleteIds(null)}
      >
        <p>
          将删除所选 {confirmDeleteIds?.length ?? 0} 个{UX_TERMS.mainKeyword}
          及其关联的写作问题，并同步回退{UX_TERMS.mainKeyword}与写作问题配额。
        </p>
      </Modal>
    </section>
  );
}

function messageOf(reason: unknown): string {
  if (reason instanceof KeywordApiError) return reason.message;
  return '无法连接接口';
}

function noteLock(reason: unknown, setLocked: (value: boolean) => void): void {
  if (reason instanceof KeywordApiError && reason.code === API_ERROR.TENANT_EXPIRED) {
    setLocked(true);
  }
}
