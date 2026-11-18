'use client';

import {
  AI_IMAGE_COUNTS,
  AI_IMAGE_DEFAULT_RATIO,
  AI_IMAGE_DEFAULT_UNIT_POINTS,
  AI_IMAGE_PROMPT_MAX,
  AI_IMAGE_PROMPT_MIN,
  AI_IMAGE_RATIOS,
  AI_IMAGE_RATIO_LABELS,
  AI_IMAGE_REF_MAX_BYTES,
  AI_IMAGE_STATUS_LABELS,
  AI_IMAGE_STYLES,
  CRUD_EMPTY_TEXT,
  CRUD_PAGE_SIZES,
  formatAiImageSubmitLabel,
  quoteAiImagePoints,
  type AiImageCount,
  type AiImageGeneratedAsset,
  type AiImageJobItem,
  type AiImageJobListQuery,
  type AiImageRatio,
  type CrudExportFormat,
  type TaskStatusName,
} from '@geomix/shared';
import {
  Alert,
  Button,
  Checkbox,
  Dropdown,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CrudModal } from '../crud/crud-modal';
import { ExportAction } from '../crud/export-action';
import { TableClampText } from '../crud/table-clamp-text';
import {
  httpAiImageGateway,
  type AiImageDownloadFile,
  type AiImageFormOptions,
  type AiImageGateway,
} from '../../lib/ai-images';
import { resolveMediaUrl } from '../../lib/gallery';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import {
  formatShanghaiDateTime,
  formatShortDisplayId,
  triggerBlobDownload,
} from '../../lib/ux-foundation';

const DEFAULT_POLL_INTERVAL_MS = 5_000;

const FILTER_STATUSES: TaskStatusName[] = ['QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'];

const NATIVE_SELECT_STYLE: CSSProperties = {
  width: '100%',
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid var(--gm-line-2)',
  backgroundColor: 'var(--gm-bg-elevated)',
  fontSize: 14,
  color: 'var(--gm-fg-1)',
  outline: 'none',
};

const COMPACT_SELECT_STYLE: CSSProperties = {
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid var(--gm-line-2)',
  backgroundColor: 'var(--gm-bg-elevated)',
  fontSize: 13,
  color: 'var(--gm-fg-1)',
  outline: 'none',
};

type RefMode = 'none' | 'upload' | 'gallery';

type CreateDraft = {
  prompt: string;
  ratio: AiImageRatio;
  style: string;
  count: AiImageCount;
  refMode: RefMode;
  refAssetId: string;
  refImageBase64: string;
  refImageFilename: string;
  saveCategoryId: string;
  optKeywordId: string;
  optKbId: string;
};

type ModalState = {
  initial: CreateDraft;
  draft: CreateDraft;
  minimized: boolean;
  maximized: boolean;
};

type ColumnKey =
  | 'thumb'
  | 'prompt'
  | 'styleRatio'
  | 'count'
  | 'category'
  | 'status'
  | 'points'
  | 'createdAt'
  | 'actions';

const ALL_COLUMN_KEYS: { key: ColumnKey; label: string }[] = [
  { key: 'thumb', label: '缩略图' },
  { key: 'prompt', label: '提示词' },
  { key: 'styleRatio', label: '风格/比例' },
  { key: 'count', label: '张数' },
  { key: 'category', label: '归属分类' },
  { key: 'status', label: '状态' },
  { key: 'points', label: '消耗点数' },
  { key: 'createdAt', label: '创建时间' },
  { key: 'actions', label: '操作' },
];

function buildInitialDraft(): CreateDraft {
  return {
    prompt: '',
    ratio: AI_IMAGE_DEFAULT_RATIO,
    style: AI_IMAGE_STYLES[0],
    count: 1,
    refMode: 'none',
    refAssetId: '',
    refImageBase64: '',
    refImageFilename: '',
    saveCategoryId: '',
    optKeywordId: '',
    optKbId: '',
  };
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatShanghaiDateTime(iso);
}

function statusTagColor(status: TaskStatusName): string {
  switch (status) {
    case 'RUNNING':
      return 'processing';
    case 'COMPLETED':
      return 'success';
    case 'PARTIAL':
      return 'warning';
    case 'FAILED':
      return 'error';
    case 'QUEUED':
      return 'blue';
    default:
      return 'default';
  }
}

function defaultDownloadHandler(file: AiImageDownloadFile): void {
  triggerBlobDownload(file);
}

function triggerAssetDownload(asset: AiImageGeneratedAsset, orderNo: string, idx: number): void {
  if (typeof window === 'undefined') return;
  const href = resolveMediaUrl(asset.url);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `${orderNo}-${idx + 1}.jpg`;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('读取本地图片失败'));
    reader.readAsDataURL(file);
  });
}

export function AiImageScreen({
  title,
  tabId,
  readOnly = false,
  featureEnabled = true,
  storage,
  gateway,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  onDownload = defaultDownloadHandler,
  onDispatch,
}: {
  title: string;
  tabId?: string;
  readOnly?: boolean;
  featureEnabled?: boolean;
  storage?: SessionStorageLike;
  gateway?: AiImageGateway;
  pollIntervalMs?: number;
  onDownload?: (file: AiImageDownloadFile) => void;
  onDispatch?: (action: ShellAction) => void;
}) {
  const effectiveStorage = useMemo<SessionStorageLike>(() => {
    if (storage) return storage;
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
    const mem = new Map<string, string>();
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => {
        mem.set(k, v);
      },
      removeItem: (k) => {
        mem.delete(k);
      },
    };
  }, [storage]);

  const api = useMemo(
    () => gateway ?? httpAiImageGateway(effectiveStorage),
    [gateway, effectiveStorage],
  );

  const [query, setQuery] = useState<AiImageJobListQuery>({
    page: 1,
    pageSize: 25,
  });
  const [searchInput, setSearchInput] = useState('');
  const [searchVisible, setSearchVisible] = useState(true);
  const [visibleCols, setVisibleCols] = useState<ColumnKey[]>(
    ALL_COLUMN_KEYS.map((item) => item.key),
  );

  const [items, setItems] = useState<AiImageJobItem[]>([]);
  const [total, setTotal] = useState(0);
  const [unitPoints, setUnitPoints] = useState<number>(AI_IMAGE_DEFAULT_UNIT_POINTS);
  const [serverFeatureEnabled, setServerFeatureEnabled] = useState<boolean>(featureEnabled);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [bannerInfo, setBannerInfo] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [formOptions, setFormOptions] = useState<AiImageFormOptions | null>(null);
  const [modalState, setModalState] = useState<ModalState | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [optimizing, setOptimizing] = useState(false);

  // Zero-copy Save to Gallery Modal
  const [saveTargetJob, setSaveTargetJob] = useState<AiImageJobItem | null>(null);
  const [saveCategoryId, setSaveCategoryId] = useState<string>('');
  const [savingGallery, setSavingGallery] = useState(false);
  const [saveModalError, setSaveModalError] = useState<string | null>(null);

  // Image Preview Modal
  const [previewState, setPreviewState] = useState<{
    job: AiImageJobItem;
    assetIndex: number;
  } | null>(null);

  // Delete Confirmation Modal
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isFeatureActive = featureEnabled && serverFeatureEnabled;

  const loadList = useCallback(
    async (silent = false) => {
      if (!featureEnabled) return;
      if (!silent) setLoading(true);
      try {
        const res = await api.list(query);
        setItems(res.items);
        setTotal(res.total);
        setUnitPoints(res.unitPoints);
        setServerFeatureEnabled(res.featureEnabled);
        if (!silent) setPageError(null);
      } catch (err) {
        if (!silent) {
          setPageError(err instanceof Error ? err.message : '加载生图任务列表失败');
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [api, featureEnabled, query],
  );

  const ensureFormOptions = useCallback(async () => {
    try {
      const opts = await api.loadFormOptions();
      setFormOptions(opts);
      setUnitPoints(opts.unitPoints);
      return opts;
    } catch {
      return null;
    }
  }, [api]);

  useEffect(() => {
    void loadList(false);
  }, [loadList]);

  const hasActiveJobs = useMemo(
    () => items.some((row) => row.status === 'QUEUED' || row.status === 'RUNNING'),
    [items],
  );

  useEffect(() => {
    if (!isFeatureActive || !hasActiveJobs || pollIntervalMs <= 0) return;
    const timer = setInterval(() => {
      void loadList(true);
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [hasActiveJobs, isFeatureActive, loadList, pollIntervalMs]);

  const openCreateModal = async () => {
    setModalError(null);
    const initial = buildInitialDraft();
    setModalState({
      initial,
      draft: initial,
      minimized: false,
      maximized: false,
    });
    await ensureFormOptions();
  };

  const handleOptimizePrompt = async () => {
    if (!modalState) return;
    const basePrompt = modalState.draft.prompt.trim();
    if (basePrompt.length < 2) {
      setModalError('请至少输入 2 个字的基础画面描述后再点击 AI 优化提示词');
      return;
    }
    setModalError(null);
    setOptimizing(true);
    try {
      const res = await api.optimizePrompt({
        prompt: basePrompt,
        style: modalState.draft.style || undefined,
        keywordId: modalState.draft.optKeywordId || undefined,
        kbId: modalState.draft.optKbId || undefined,
      });
      setModalState((prev) =>
        prev
          ? {
              ...prev,
              draft: {
                ...prev.draft,
                prompt: res.optimizedPrompt,
              },
            }
          : null,
      );
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '提示词优化失败');
    } finally {
      setOptimizing(false);
    }
  };

  const handleUploadRefFile = async (file: File | undefined) => {
    if (!file || !modalState) return;
    if (file.size > AI_IMAGE_REF_MAX_BYTES) {
      setModalError('参考图片大小不能超过 10MB');
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setModalError(null);
      setModalState((prev) =>
        prev
          ? {
              ...prev,
              draft: {
                ...prev.draft,
                refMode: 'upload',
                refImageBase64: dataUrl,
                refImageFilename: file.name,
                refAssetId: '',
              },
            }
          : null,
      );
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '读取参考图片失败');
    }
  };

  const handleSubmitCreate = async () => {
    if (!modalState) return;
    const { draft } = modalState;
    const trimmedPrompt = draft.prompt.trim();
    if (trimmedPrompt.length < AI_IMAGE_PROMPT_MIN) {
      setModalError(`画面提示词至少填写 ${AI_IMAGE_PROMPT_MIN} 个字`);
      return;
    }
    if (trimmedPrompt.length > AI_IMAGE_PROMPT_MAX) {
      setModalError(`画面提示词不能超过 ${AI_IMAGE_PROMPT_MAX} 个字`);
      return;
    }
    if (draft.refMode === 'upload' && !draft.refImageBase64) {
      setModalError('请选择需要上传的本地参考图片，或切换为「不使用参考图」');
      return;
    }
    if (draft.refMode === 'gallery' && !draft.refAssetId) {
      setModalError('请选择图库中的参考图片，或切换为「不使用参考图」');
      return;
    }

    setModalError(null);
    setSubmitting(true);
    try {
      const created = await api.create({
        prompt: trimmedPrompt,
        ratio: draft.ratio,
        style: draft.style || undefined,
        count: draft.count,
        refAssetId: draft.refMode === 'gallery' ? draft.refAssetId || undefined : undefined,
        refImageBase64: draft.refMode === 'upload' ? draft.refImageBase64 || undefined : undefined,
        refImageFilename:
          draft.refMode === 'upload' ? draft.refImageFilename || undefined : undefined,
        saveCategoryId: draft.saveCategoryId || undefined,
      });
      setModalState(null);
      setBannerInfo(
        `已提交生图订单 ${created.orderNo}（预冻结 ${created.reservedPoints} 点），系统正在后台生成图片。`,
      );
      await loadList(false);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '提交生图任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  const openSaveGalleryModal = async (job: AiImageJobItem) => {
    setSaveModalError(null);
    setSaveTargetJob(job);
    const opts = formOptions ?? (await ensureFormOptions());
    const initialCat = job.saveCategoryId || opts?.mediaCategories[0]?.id || '';
    setSaveCategoryId(initialCat);
  };

  const handleConfirmSaveGallery = async () => {
    if (!saveTargetJob) return;
    if (!saveCategoryId) {
      setSaveModalError('请先选择目标企业画像图库分组');
      return;
    }
    setSaveModalError(null);
    setSavingGallery(true);
    try {
      const res = await api.saveToGallery(saveTargetJob.id, {
        categoryId: saveCategoryId,
      });
      setSaveTargetJob(null);
      setBannerInfo(
        `已将 ${res.savedCount} 张生成图片存入图库分组「${res.categoryName}」，AI 写作可直接选用！`,
      );
      await loadList(false);
    } catch (err) {
      setSaveModalError(err instanceof Error ? err.message : '存入图库失败');
    } finally {
      setSavingGallery(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTargetIds || deleteTargetIds.length === 0) return;
    setDeleting(true);
    try {
      if (deleteTargetIds.length === 1 && deleteTargetIds[0]) {
        await api.deleteOne(deleteTargetIds[0]);
      } else {
        await api.bulkDelete(deleteTargetIds);
      }
      setSelectedIds((prev) => prev.filter((id) => !deleteTargetIds.includes(id)));
      setDeleteTargetIds(null);
      await loadList(false);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : '删除生图记录失败');
      setDeleteTargetIds(null);
    } finally {
      setDeleting(false);
    }
  };

  const handleExport = async (format: CrudExportFormat) => {
    try {
      const file = await api.downloadTable(query, format);
      onDownload(file);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : '导出生图列表失败');
    }
  };

  const navigateTo = (href: string) => {
    onDispatch?.({
      type: 'open',
      href,
      sourceId: tabId,
    });
  };

  if (!isFeatureActive) {
    return (
      <section>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          {title}
        </Typography.Title>
        <Alert
          type="info"
          showIcon
          message="AI 生图功能当前未启用"
          description="管理员已通过 FEATURE_AI_IMAGE 关闭生图模块。如需使用，请联系管理员开启功能开关。"
        />
      </section>
    );
  }

  const draftQuote = quoteAiImagePoints(modalState?.draft.count ?? 1, unitPoints);
  const submitButtonLabel = formatAiImageSubmitLabel(modalState?.draft.count ?? 1, unitPoints);

  const columns = [
    {
      title: '序号',
      key: 'seq',
      width: 64,
      render: (_: unknown, __: AiImageJobItem, idx: number) =>
        (query.page - 1) * query.pageSize + idx + 1,
    },
    ...(visibleCols.includes('thumb')
      ? [
          {
            title: '缩略图',
            key: 'thumb',
            width: 185,
            render: (_: unknown, row: AiImageJobItem) => {
              if (row.assets.length === 0) {
                if (row.status === 'QUEUED' || row.status === 'RUNNING') {
                  return (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      生成中（0/{row.count}）…
                    </Typography.Text>
                  );
                }
                return (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    无生成结果
                  </Typography.Text>
                );
              }
              return (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {row.assets.map((asset, index) => (
                    <button
                      key={asset.id}
                      type="button"
                      aria-label={`预览图片 ${row.orderNo}-${index + 1}`}
                      onClick={() => setPreviewState({ job: row, assetIndex: index })}
                      style={{
                        padding: 0,
                        border: '1px solid var(--gm-line-1)',
                        borderRadius: 6,
                        overflow: 'hidden',
                        width: 56,
                        height: 42,
                        cursor: 'pointer',
                        background: 'var(--gm-bg-elevated)',
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={resolveMediaUrl(asset.thumbUrl)}
                        alt={`${row.orderNo}-${index + 1}`}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          display: 'block',
                        }}
                      />
                    </button>
                  ))}
                </div>
              );
            },
          },
        ]
      : []),
    ...(visibleCols.includes('prompt')
      ? [
          {
            title: '提示词',
            key: 'prompt',
            width: 380,
            render: (_: unknown, row: AiImageJobItem) => (
              <div style={{ maxWidth: 380 }}>
                <div style={{ marginBottom: 2 }}>
                  <Typography.Text code style={{ fontSize: 12 }}>
                    {row.orderNo}
                  </Typography.Text>
                </div>
                <TableClampText text={row.prompt} lines={3} maxWidth={380} />
                {row.error ? (
                  <div
                    style={{
                      color: 'var(--gm-danger)',
                      fontSize: 12,
                      marginTop: 2,
                      wordBreak: 'break-word',
                    }}
                  >
                    {row.error}
                  </div>
                ) : null}
              </div>
            ),
          },
        ]
      : []),
    ...(visibleCols.includes('styleRatio')
      ? [
          {
            title: '风格/比例',
            key: 'styleRatio',
            width: 150,
            render: (_: unknown, row: AiImageJobItem) => (
              <Space size={4} wrap>
                <Tag>{row.style ?? '默认风格'}</Tag>
                <Tag color="geekblue">{row.ratio}</Tag>
              </Space>
            ),
          },
        ]
      : []),
    ...(visibleCols.includes('count')
      ? [
          {
            title: '张数',
            key: 'count',
            width: 95,
            render: (_: unknown, row: AiImageJobItem) => (
              <Tag color="cyan">
                {row.successCount}/{row.count} 张
              </Tag>
            ),
          },
        ]
      : []),
    ...(visibleCols.includes('category')
      ? [
          {
            title: '归属分类',
            key: 'category',
            width: 145,
            render: (_: unknown, row: AiImageJobItem) =>
              row.saveCategoryName ? (
                <span style={{ fontSize: 12, color: 'var(--gm-sig-cited)' }}>
                  {row.saveCategoryName}
                </span>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>未转存图库</span>
              ),
          },
        ]
      : []),
    ...(visibleCols.includes('status')
      ? [
          {
            title: '状态',
            key: 'status',
            width: 105,
            render: (_: unknown, row: AiImageJobItem) => (
              <Tag color={statusTagColor(row.status)}>
                {AI_IMAGE_STATUS_LABELS[row.status] ?? row.status}
              </Tag>
            ),
          },
        ]
      : []),
    ...(visibleCols.includes('points')
      ? [
          {
            title: '消耗点数',
            key: 'points',
            width: 145,
            render: (_: unknown, row: AiImageJobItem) => (
              <div className="gm-num" style={{ fontSize: 12, lineHeight: 1.6 }}>
                <div style={{ fontWeight: 600, color: 'var(--gm-info)' }}>
                  {row.status === 'QUEUED' || row.status === 'RUNNING'
                    ? `预冻 ${row.reservedPoints} 点`
                    : `实结 ${row.settledPoints} 点`}
                </div>
                <div style={{ color: 'var(--gm-fg-3)' }}>
                  标价 {row.unitPoints} 点/张
                  {row.releasedPoints > 0 ? ` · 已退 ${row.releasedPoints} 点` : ''}
                </div>
              </div>
            ),
          },
        ]
      : []),
    ...(visibleCols.includes('createdAt')
      ? [
          {
            title: '创建时间',
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 150,
            render: (val: string) => (
              <span className="gm-num" style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
                {formatTime(val)}
              </span>
            ),
          },
        ]
      : []),
    ...(visibleCols.includes('actions')
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 215,
            render: (_: unknown, row: AiImageJobItem) => {
              const hasAssets = row.assets.length > 0;
              const isRunning = row.status === 'QUEUED' || row.status === 'RUNNING';
              return (
                <Space size={4} wrap>
                  <Button
                    size="small"
                    type="link"
                    disabled={!hasAssets}
                    onClick={() => {
                      row.assets.forEach((asset, idx) =>
                        triggerAssetDownload(asset, row.orderNo, idx),
                      );
                    }}
                  >
                    下载
                  </Button>
                  <Button
                    size="small"
                    type="link"
                    disabled={readOnly || !hasAssets}
                    onClick={() => void openSaveGalleryModal(row)}
                  >
                    存入图库
                  </Button>
                  <Button
                    size="small"
                    type="link"
                    danger
                    disabled={readOnly || isRunning}
                    onClick={() => setDeleteTargetIds([row.id])}
                  >
                    删除
                  </Button>
                </Space>
              );
            },
          },
        ]
      : []),
  ];

  const previewAsset = previewState?.job.assets[previewState.assetIndex] ?? null;

  return (
    <section>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            支持 9 种商业构图比例与免费提示词扩写；按成功入库张数逐张结算（当前标价 {unitPoints}{' '}
            点数/张），支持一键存入企业画像图库供 AI 写作选用。
          </Typography.Text>
        </div>
        <Space>
          <Button size="small" onClick={() => navigateTo('/material/gallery')}>
            查看企业画像图库
          </Button>
        </Space>
      </div>

      {pageError && (
        <Alert
          style={{ marginBottom: 12 }}
          type="error"
          showIcon
          closable
          onClose={() => setPageError(null)}
          message={pageError}
        />
      )}

      {bannerInfo && (
        <Alert
          style={{ marginBottom: 12 }}
          type="success"
          showIcon
          closable
          onClose={() => setBannerInfo(null)}
          message={bannerInfo}
        />
      )}

      {searchVisible && (
        <div
          style={{
            background: 'var(--gm-bg-surface)',
            border: '1px solid var(--gm-line-1)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            alignItems: 'center',
          }}
        >
          <Input
            aria-label="搜索提示词或订单号"
            placeholder="搜索提示词或订单编号"
            style={{ width: 240 }}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onPressEnter={() =>
              setQuery((prev) => ({
                ...prev,
                page: 1,
                keyword: searchInput.trim() || undefined,
              }))
            }
          />
          <select
            aria-label="状态筛选"
            style={COMPACT_SELECT_STYLE}
            value={query.status ?? ''}
            onChange={(e) => {
              const val = e.target.value as TaskStatusName | '';
              setQuery((prev) => ({
                ...prev,
                page: 1,
                status: val ? val : undefined,
              }));
            }}
          >
            <option value="">全部状态</option>
            {FILTER_STATUSES.map((st) => (
              <option key={st} value={st}>
                {AI_IMAGE_STATUS_LABELS[st]}
              </option>
            ))}
          </select>
          <Button
            aria-label="查询"
            type="primary"
            onClick={() =>
              setQuery((prev) => ({
                ...prev,
                page: 1,
                keyword: searchInput.trim() || undefined,
              }))
            }
          >
            查询
          </Button>
          <Button
            onClick={() => {
              setSearchInput('');
              setQuery({ page: 1, pageSize: query.pageSize });
            }}
          >
            重置筛选
          </Button>
        </div>
      )}

      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <Space wrap>
          <Button aria-label="刷新" onClick={() => void loadList(false)} loading={loading}>
            刷新
          </Button>
          <Button
            aria-label="添加"
            type="primary"
            disabled={readOnly}
            onClick={() => void openCreateModal()}
          >
            添加
          </Button>
          <Button
            danger
            disabled={readOnly || selectedIds.length === 0}
            onClick={() => setDeleteTargetIds(selectedIds)}
          >
            删除{selectedIds.length > 0 ? `（${selectedIds.length}）` : ''}
          </Button>
        </Space>

        <Space wrap>
          <Button onClick={() => setSearchVisible((v) => !v)}>
            {searchVisible ? '收起搜索' : '展开搜索'}
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: ALL_COLUMN_KEYS.map((col) => ({
                key: col.key,
                label: (
                  <Checkbox
                    checked={visibleCols.includes(col.key)}
                    onChange={(e) => {
                      setVisibleCols((prev) =>
                        e.target.checked
                          ? [...prev, col.key]
                          : prev.length > 1
                            ? prev.filter((item) => item !== col.key)
                            : prev,
                      );
                    }}
                  >
                    {col.label}
                  </Checkbox>
                ),
              })),
            }}
          >
            <Button>列显示 ▾</Button>
          </Dropdown>
          <ExportAction
            empty={!loading && total === 0 && items.length === 0}
            onExport={handleExport}
          />
        </Space>
      </div>

      {/* Table */}
      <Table<AiImageJobItem>
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={items}
        locale={{ emptyText: CRUD_EMPTY_TEXT }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys.map(String)),
          getCheckboxProps: (record) => ({
            disabled: readOnly || record.status === 'QUEUED' || record.status === 'RUNNING',
          }),
        }}
        pagination={{
          current: query.page,
          pageSize: query.pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: CRUD_PAGE_SIZES.map(String),
          showTotal: (count) => `共 ${count} 条记录`,
          onChange: (nextPage, nextSize) => {
            const safeSize = (CRUD_PAGE_SIZES as readonly number[]).includes(nextSize)
              ? (nextSize as AiImageJobListQuery['pageSize'])
              : 25;
            setQuery((prev) => ({
              ...prev,
              page: nextPage,
              pageSize: safeSize,
            }));
          },
        }}
      />

      {/* Create AI Image Modal */}
      {modalState && (
        <CrudModal
          open
          title="添加 AI 生图任务"
          minimized={modalState.minimized}
          maximized={modalState.maximized}
          confirmLoading={submitting}
          error={modalError}
          ok={
            <Button
              type="primary"
              loading={submitting}
              disabled={readOnly}
              onClick={() => void handleSubmitCreate()}
            >
              {submitButtonLabel}
            </Button>
          }
          onClose={() => setModalState(null)}
          onReset={() => {
            setModalError(null);
            setModalState((prev) => (prev ? { ...prev, draft: prev.initial } : null));
          }}
          onMinimize={() => setModalState((prev) => (prev ? { ...prev, minimized: true } : null))}
          onRestore={() => setModalState((prev) => (prev ? { ...prev, minimized: false } : null))}
          onMaximize={() =>
            setModalState((prev) => (prev ? { ...prev, maximized: !prev.maximized } : null))
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Upfront Price & Billing Transparency Banner */}
            <div
              data-testid="ai-image-price-banner"
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                background: 'var(--gm-bg-elevated)',
                border: '1px solid rgba(111,168,255,0.32)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <div>
                <div className="gm-num" style={{ fontWeight: 600, color: 'var(--gm-info)' }}>
                  预计消耗说明：单价 {draftQuote.unitPoints} 点数/张 × 生成 {draftQuote.count} 张 ＝
                  合计预冻结 {draftQuote.totalPoints} 点数
                </div>
                <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginTop: 2 }}>
                  提交后按标价预冻结，按成功入库张数逐张结算；生成失败或存储空间不足自动退还点数（体验期仅记录点数明细，不扣减可用点数）。
                </div>
              </div>
              <Tag color="blue" style={{ fontSize: 13, padding: '3px 10px' }}>
                预冻 {draftQuote.totalPoints} 点
              </Tag>
            </div>

            {/* 1. Prompt + Free AI Optimize */}
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 6,
                  flexWrap: 'wrap',
                  gap: 6,
                }}
              >
                <span style={{ fontWeight: 500 }}>
                  画面提示词（{AI_IMAGE_PROMPT_MIN}–{AI_IMAGE_PROMPT_MAX} 字）{' '}
                  <span style={{ color: 'var(--gm-danger)' }}>*</span>
                </span>
                <Button
                  size="small"
                  loading={optimizing}
                  onClick={() => void handleOptimizePrompt()}
                >
                  AI 优化提示词（免费）
                </Button>
              </div>
              <Input.TextArea
                aria-label="画面提示词"
                rows={4}
                maxLength={AI_IMAGE_PROMPT_MAX}
                showCount
                placeholder="请描述期望生成的商业配图主体、环境光线与质感，例如：现代精密激光切割加工车间实景，柔和工业照明，整洁金属产线构图（不生成真人正脸、商标Logo或带字海报）"
                value={modalState.draft.prompt}
                onChange={(e) =>
                  setModalState((prev) =>
                    prev ? { ...prev, draft: { ...prev.draft, prompt: e.target.value } } : null,
                  )
                }
              />

              {/* Optional Keyword / KB context for Free Prompt Optimization */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 10,
                  marginTop: 8,
                }}
              >
                <select
                  aria-label="扩写关联训练主词"
                  style={COMPACT_SELECT_STYLE}
                  value={modalState.draft.optKeywordId}
                  onChange={(e) =>
                    setModalState((prev) =>
                      prev
                        ? {
                            ...prev,
                            draft: { ...prev.draft, optKeywordId: e.target.value },
                          }
                        : null,
                    )
                  }
                >
                  <option value="">扩写辅助：不带入训练主词（可选）</option>
                  {(formOptions?.keywords ?? []).map((kw) => (
                    <option key={kw.id} value={kw.id}>
                      主词：{kw.main}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="扩写关联知识库"
                  style={COMPACT_SELECT_STYLE}
                  value={modalState.draft.optKbId}
                  onChange={(e) =>
                    setModalState((prev) =>
                      prev ? { ...prev, draft: { ...prev.draft, optKbId: e.target.value } } : null,
                    )
                  }
                >
                  <option value="">扩写辅助：不带入知识库产品服务（可选）</option>
                  {(formOptions?.knowledgeBases ?? []).map((kb) => (
                    <option key={kb.id} value={kb.id}>
                      知识库：{kb.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* 2. Aspect Ratio (9 options, default 21:9) */}
            <div>
              <div style={{ fontWeight: 500, marginBottom: 6 }}>
                图片比例（默认 21:9） <span style={{ color: 'var(--gm-danger)' }}>*</span>
              </div>
              <div
                role="radiogroup"
                aria-label="图片比例"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  gap: 8,
                }}
              >
                {AI_IMAGE_RATIOS.map((ratio) => {
                  const selected = modalState.draft.ratio === ratio;
                  return (
                    <button
                      key={ratio}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() =>
                        setModalState((prev) =>
                          prev ? { ...prev, draft: { ...prev.draft, ratio } } : null,
                        )
                      }
                      style={{
                        padding: '8px 10px',
                        borderRadius: 6,
                        border: selected
                          ? '1px solid var(--gm-phosphor-a40)'
                          : '1px solid var(--gm-line-2)',
                        background: selected ? 'var(--gm-bg-selected)' : 'var(--gm-bg-elevated)',
                        color: selected ? 'var(--gm-fg-1)' : 'var(--gm-fg-2)',
                        fontWeight: selected ? 600 : 400,
                        fontSize: 13,
                        textAlign: 'left',
                        cursor: 'pointer',
                      }}
                    >
                      {AI_IMAGE_RATIO_LABELS[ratio]}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 3. Style & Count */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(180px, 1fr) auto',
                gap: 12,
                alignItems: 'end',
              }}
            >
              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>画面风格</div>
                <select
                  aria-label="画面风格"
                  style={NATIVE_SELECT_STYLE}
                  value={modalState.draft.style}
                  onChange={(e) =>
                    setModalState((prev) =>
                      prev ? { ...prev, draft: { ...prev.draft, style: e.target.value } } : null,
                    )
                  }
                >
                  {AI_IMAGE_STYLES.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>生成张数</div>
                <div
                  role="radiogroup"
                  aria-label="生成张数"
                  style={{ display: 'flex', gap: 6, flexWrap: 'nowrap' }}
                >
                  {AI_IMAGE_COUNTS.map((cnt) => {
                    const selected = modalState.draft.count === cnt;
                    return (
                      <button
                        key={cnt}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() =>
                          setModalState((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  draft: {
                                    ...prev.draft,
                                    count: cnt,
                                  },
                                }
                              : null,
                          )
                        }
                        style={{
                          height: 32,
                          padding: '0 12px',
                          borderRadius: 6,
                          border: selected
                            ? '1px solid var(--gm-phosphor-a40)'
                            : '1px solid var(--gm-line-2)',
                          background: selected ? 'var(--gm-bg-selected)' : 'var(--gm-bg-elevated)',
                          color: selected ? 'var(--gm-fg-1)' : 'var(--gm-fg-2)',
                          fontWeight: selected ? 600 : 400,
                          fontSize: 13,
                          whiteSpace: 'nowrap',
                          cursor: 'pointer',
                        }}
                      >
                        {cnt} 张（{cnt * unitPoints} 点）
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 4. Reference Image (Upload or Pick from Gallery) */}
            <div>
              <div style={{ fontWeight: 500, marginBottom: 6 }}>参考图片（可选）</div>
              <div
                role="radiogroup"
                aria-label="参考图片模式"
                style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
              >
                {(
                  [
                    { value: 'none', label: '不使用参考图' },
                    { value: 'upload', label: '上传参考图片' },
                    { value: 'gallery', label: '从图库选择' },
                  ] as const
                ).map((opt) => {
                  const selected = modalState.draft.refMode === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() =>
                        setModalState((prev) =>
                          prev
                            ? {
                                ...prev,
                                draft: {
                                  ...prev.draft,
                                  refMode: opt.value,
                                },
                              }
                            : null,
                        )
                      }
                      style={{
                        height: 32,
                        padding: '0 14px',
                        borderRadius: 6,
                        border: selected
                          ? '1px solid var(--gm-phosphor-a40)'
                          : '1px solid var(--gm-line-2)',
                        background: selected ? 'var(--gm-bg-selected)' : 'var(--gm-bg-elevated)',
                        color: selected ? 'var(--gm-fg-1)' : 'var(--gm-fg-2)',
                        fontWeight: selected ? 600 : 400,
                        fontSize: 13,
                        cursor: 'pointer',
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              {modalState.draft.refMode === 'upload' && (
                <div
                  style={{
                    marginTop: 8,
                    padding: 10,
                    borderRadius: 6,
                    border: '1px dashed var(--gm-line-1)',
                    background: 'var(--gm-bg-surface)',
                  }}
                >
                  <input
                    aria-label="上传参考图片文件"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => void handleUploadRefFile(e.target.files?.[0])}
                  />
                  <div style={{ fontSize: 12, color: 'var(--gm-fg-3)', marginTop: 4 }}>
                    支持 JPG / PNG / WebP，单张不超过 10MB
                    {modalState.draft.refImageFilename
                      ? ` · 已选择：${modalState.draft.refImageFilename}`
                      : ''}
                  </div>
                </div>
              )}

              {modalState.draft.refMode === 'gallery' && (
                <div style={{ marginTop: 8 }}>
                  <select
                    aria-label="选择图库参考图"
                    style={NATIVE_SELECT_STYLE}
                    value={modalState.draft.refAssetId}
                    onChange={(e) =>
                      setModalState((prev) =>
                        prev
                          ? {
                              ...prev,
                              draft: { ...prev.draft, refAssetId: e.target.value },
                            }
                          : null,
                      )
                    }
                  >
                    <option value="">请选择一张已上传的企业画像图片</option>
                    {(formOptions?.galleryAssets ?? []).map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.categoryName ? `[${asset.categoryName}] ` : ''}
                        {formatShortDisplayId(asset.id, '图片')}（{asset.width}×{asset.height}）
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* 5. Save directly to Gallery Category (Optional, default none) */}
            <div>
              <div style={{ fontWeight: 500, marginBottom: 6 }}>
                转存到企业画像（可选，默认不选择）
              </div>
              <select
                aria-label="转存到企业画像"
                style={NATIVE_SELECT_STYLE}
                value={modalState.draft.saveCategoryId}
                onChange={(e) =>
                  setModalState((prev) =>
                    prev
                      ? {
                          ...prev,
                          draft: { ...prev.draft, saveCategoryId: e.target.value },
                        }
                      : null,
                  )
                }
              >
                <option value="">暂不转存（生成后可在列表随时点「存入图库」）</option>
                {(formOptions?.mediaCategories ?? []).map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}（现有 {cat.assetCount} 张）
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CrudModal>
      )}

      {/* Save to Gallery Modal */}
      <Modal
        open={Boolean(saveTargetJob)}
        title="存入企业画像图库"
        confirmLoading={savingGallery}
        okText="确认转存"
        cancelText="取消"
        onCancel={() => setSaveTargetJob(null)}
        onOk={() => void handleConfirmSaveGallery()}
      >
        {saveTargetJob && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Alert
              type="info"
              showIcon
              message={`将订单 ${saveTargetJob.orderNo} 生成的 ${saveTargetJob.assets.length} 张图片归入所选图库分组（不重复占用存储空间配额）。`}
            />
            {saveModalError && <Alert type="error" showIcon message={saveModalError} />}
            <div>
              <div style={{ fontWeight: 500, marginBottom: 6 }}>目标图库分组</div>
              <select
                aria-label="目标图库分组"
                style={NATIVE_SELECT_STYLE}
                value={saveCategoryId}
                onChange={(e) => setSaveCategoryId(e.target.value)}
              >
                <option value="">请选择企业画像图库分组</option>
                {(formOptions?.mediaCategories ?? []).map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}（现有 {cat.assetCount} 张）
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </Modal>

      {/* Image Preview Modal */}
      <Modal
        open={Boolean(previewState && previewAsset)}
        title={
          previewState
            ? `图片预览 · ${previewState.job.orderNo}（第 ${previewState.assetIndex + 1}/${previewState.job.assets.length} 张）`
            : '图片预览'
        }
        footer={
          previewState && previewAsset ? (
            <Space>
              <Button
                onClick={() =>
                  triggerAssetDownload(
                    previewAsset,
                    previewState.job.orderNo,
                    previewState.assetIndex,
                  )
                }
              >
                下载原图
              </Button>
              <Button type="primary" onClick={() => setPreviewState(null)}>
                关闭
              </Button>
            </Space>
          ) : null
        }
        width={760}
        onCancel={() => setPreviewState(null)}
      >
        {previewState && previewAsset && (
          <div>
            <div
              style={{
                background: 'var(--gm-bg-base)',
                borderRadius: 8,
                padding: 12,
                textAlign: 'center',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={resolveMediaUrl(previewAsset.url)}
                alt={previewState.job.orderNo}
                style={{ maxWidth: '100%', maxHeight: 460, borderRadius: 4 }}
              />
            </div>
            <div
              className="gm-num"
              style={{ marginTop: 10, fontSize: 13, color: 'var(--gm-fg-2)' }}
            >
              尺寸：{previewAsset.width} × {previewAsset.height}px · 大小：
              {Math.max(1, Math.round(previewAsset.bytes / 1024))} KB · 文章引用次数：
              {previewAsset.usedCount} 次
            </div>
          </div>
        )}
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        open={Boolean(deleteTargetIds)}
        title="确认删除生图记录"
        confirmLoading={deleting}
        okButtonProps={{ danger: true }}
        okText="确认删除"
        cancelText="取消"
        onCancel={() => setDeleteTargetIds(null)}
        onOk={() => void handleConfirmDelete()}
      >
        <p style={{ margin: 0 }}>
          确定删除选中的 {deleteTargetIds?.length ?? 0}{' '}
          条生图记录吗？已存入企业画像图库的图片将保留在图库中不受影响，未转存图库的图片将同步释放存储空间。
        </p>
      </Modal>
    </section>
  );
}
