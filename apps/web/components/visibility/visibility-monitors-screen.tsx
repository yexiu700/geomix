'use client';

import {
  CITATION_SOURCE_LABELS,
  CRUD_EMPTY_TEXT,
  DOMESTIC_VISIBILITY_ENGINE_KEYS,
  ITEM_STATUS_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  VISIBILITY_BRAND_NAME_MAX,
  VISIBILITY_DEFAULT_UNIT_POINTS,
  VISIBILITY_ENGINES,
  VISIBILITY_ENGINE_LABELS,
  VISIBILITY_MAX_COMPETITORS,
  VISIBILITY_PROFILE_NAME_MAX,
  VISIBILITY_RUN_NAME_MAX,
  VISIBILITY_SENTIMENTS,
  VISIBILITY_SENTIMENT_LABELS,
  isTaskStatus,
  isVisibilityEngine,
  isVisibilitySentiment,
  normalizeVisibilityDomain,
  quoteVisibilityRunPoints,
  type CitationSourceKind,
  type CrudExportFormat,
  type KeywordRecord,
  type QuestionRecord,
  type TaskStatusName,
  type VisibilityCompetitor,
  type VisibilityEngineKey,
  type VisibilityObservationRecord,
  type VisibilityPrefillSources,
  type VisibilityProfileRecord,
  type VisibilityRunDetailRecord,
  type VisibilityRunListQuery,
  type VisibilityRunRecord,
  type VisibilitySentiment,
} from '@geomix/shared';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Input,
  Modal,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CrudModal } from '../crud/crud-modal';
import { CrudTable, type CrudColumn } from '../crud/crud-table';
import { PriceButton } from '../crud/price-button';
import type { PriceItem } from '../../lib/samples';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import {
  createVisibilityIdempotencyKey,
  httpVisibilityGateway,
  type VisibilityGateway,
} from '../../lib/visibility';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_PROFILE_STORAGE_KEY = 'geomix:visibility:default-profile-id';

const NATIVE_SELECT_STYLE: CSSProperties = {
  width: '100%',
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid #d9d9d9',
  backgroundColor: '#ffffff',
  fontSize: 14,
  color: 'rgba(0, 0, 0, 0.88)',
  outline: 'none',
};

const COMPACT_SELECT_STYLE: CSSProperties = {
  height: 32,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid #d9d9d9',
  backgroundColor: '#ffffff',
  fontSize: 13,
  color: 'rgba(0, 0, 0, 0.88)',
  outline: 'none',
  maxWidth: '100%',
};

type CompetitorDraftRow = {
  key: string;
  name: string;
  aliasesText: string;
  domainsText: string;
};

type ProfileDraft = {
  mode: 'create' | 'edit';
  editId?: string;
  name: string;
  brandName: string;
  brandAliasesText: string;
  ownedDomainsText: string;
  competitors: CompetitorDraftRow[];
  isDefault: boolean;
  importFromKeywordId: string;
  importFromKbId: string;
};

type ProfileModalState = {
  initial: ProfileDraft;
  draft: ProfileDraft;
  minimized: boolean;
  maximized: boolean;
};

type RunCreateDraft = {
  profileId: string;
  name: string;
  keywordId: string;
  questionIds: string[];
  customPromptsText: string;
  engines: VisibilityEngineKey[];
};

type RunModalState = {
  initial: RunCreateDraft;
  draft: RunCreateDraft;
  idempotencyKey: string;
  minimized: boolean;
  maximized: boolean;
};

export type VisibilityExportFile = {
  filename: string;
  mime: string;
  body: Uint8Array;
};

function parseHrefParams(href?: string): { profileId?: string; runId?: string } {
  if (!href) return {};
  const qIndex = href.indexOf('?');
  if (qIndex < 0) return {};
  const params = new URLSearchParams(href.slice(qIndex + 1));
  const profileId = params.get('profileId')?.trim() || undefined;
  const runId = params.get('runId')?.trim() || undefined;
  return { profileId, runId };
}

function splitTagList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,，;；]+/)) {
    const cleaned = part.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function splitPromptLines(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = line.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16);
}

function statusTagColor(status: TaskStatusName): string {
  switch (status) {
    case 'RUNNING':
      return 'processing';
    case 'COMPLETED':
      return 'success';
    case 'PAUSED':
      return 'warning';
    case 'PARTIAL':
      return 'gold';
    case 'FAILED':
      return 'error';
    case 'CANCELLED':
      return 'default';
    case 'QUEUED':
    default:
      return 'blue';
  }
}

function itemStatusTagColor(status: VisibilityObservationRecord['status']): string {
  switch (status) {
    case 'SUCCESS':
      return 'success';
    case 'RUNNING':
      return 'processing';
    case 'FAILED':
      return 'error';
    case 'SKIPPED':
      return 'default';
    case 'PENDING':
    default:
      return 'blue';
  }
}

/** 色盲友好情感色板（蓝绿/中性灰/琥珀/玫瑰红） */
function sentimentBadgeStyle(sentiment: VisibilitySentiment): CSSProperties {
  switch (sentiment) {
    case 'positive':
      return {
        background: '#e6fffb',
        color: '#006d75',
        border: '1px solid #87e8de',
      };
    case 'mixed':
      return {
        background: '#fff7e6',
        color: '#ad4e00',
        border: '1px solid #ffd591',
      };
    case 'negative':
      return {
        background: '#fff1f0',
        color: '#a8071a',
        border: '1px solid #ffa39e',
      };
    case 'neutral':
    default:
      return {
        background: '#f1f5f9',
        color: '#334155',
        border: '1px solid #cbd5e1',
      };
  }
}

export function citationSourceBadgeColor(kind: CitationSourceKind): string {
  switch (kind) {
    case 'OWNED':
      return 'blue';
    case 'COMPETITOR':
      return 'orange';
    case 'AUTHORITY':
      return 'cyan';
    case 'SOCIAL':
      return 'purple';
    case 'OTHER':
    default:
      return 'default';
  }
}

function isControllableRunStatus(status: TaskStatusName): boolean {
  return status === 'QUEUED' || status === 'RUNNING' || status === 'PAUSED';
}

function engineLabelOf(engine: string): string {
  return isVisibilityEngine(engine) ? VISIBILITY_ENGINE_LABELS[engine] : engine;
}

function defaultDownloadHandler(file: VisibilityExportFile): void {
  if (typeof window === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([file.body as BlobPart], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function escapeCsvCell(val: string): string {
  if (/[",\r\n]/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function buildRunsExportBytes(rows: VisibilityRunRecord[]): Uint8Array {
  const headers = [
    '任务编号',
    '任务名称',
    '监测档案',
    '主品牌',
    '关联主词',
    '监测引擎',
    '完成进度',
    '品牌提及率(%)',
    '预冻点数',
    '已结算点数',
    '状态',
    '创建时间',
  ];
  const lines = [
    headers.join(','),
    ...rows.map((r) =>
      [
        r.id,
        r.name,
        r.profileName,
        r.brandName,
        r.keywordMain ?? '自定义问题',
        r.engines.map((e) => VISIBILITY_ENGINE_LABELS[e] ?? e).join(' / '),
        `${r.doneCount}/${r.totalChecks}`,
        String(r.visibilityPct ?? 0),
        String(r.frozenPoints ?? r.totalChecks * r.unitPrice),
        String(r.settledPoints ?? 0),
        TASK_STATUS_LABELS[r.status],
        formatTime(r.createdAt),
      ]
        .map(escapeCsvCell)
        .join(','),
    ),
  ];
  return new TextEncoder().encode(`\uFEFF${lines.join('\r\n')}`);
}

function buildEmptyProfileDraft(isDefault: boolean): ProfileDraft {
  return {
    mode: 'create',
    name: '',
    brandName: '',
    brandAliasesText: '',
    ownedDomainsText: '',
    competitors: [],
    isDefault,
    importFromKeywordId: '',
    importFromKbId: '',
  };
}

function buildEditProfileDraft(profile: VisibilityProfileRecord, isDefault: boolean): ProfileDraft {
  return {
    mode: 'edit',
    editId: profile.id,
    name: profile.name,
    brandName: profile.brandName,
    brandAliasesText: profile.brandAliases.join(', '),
    ownedDomainsText: profile.ownedDomains.join(', '),
    competitors: profile.competitors.map((comp, idx) => ({
      key: `comp_${idx}_${comp.name}`,
      name: comp.name,
      aliasesText: comp.aliases.join(', '),
      domainsText: comp.domains.join(', '),
    })),
    isDefault,
    importFromKeywordId: '',
    importFromKbId: '',
  };
}

function buildDefaultRunDraft(defaultProfileId: string, defaultKeywordId = ''): RunCreateDraft {
  return {
    profileId: defaultProfileId,
    name: '',
    keywordId: defaultKeywordId,
    questionIds: [],
    customPromptsText: '',
    engines: ['deepseek', 'doubao', 'tongyi', 'yuanbao'],
  };
}

export function VisibilityMonitorsScreen({
  title,
  tabId,
  href,
  readOnly = false,
  featureEnabled = true,
  storage,
  gateway,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  downloadFile = defaultDownloadHandler,
  onDispatch,
}: {
  title: string;
  tabId?: string;
  href?: string;
  readOnly?: boolean;
  featureEnabled?: boolean;
  storage?: SessionStorageLike;
  gateway?: VisibilityGateway;
  pollIntervalMs?: number;
  downloadFile?: (file: VisibilityExportFile) => void;
  onDispatch?: (action: ShellAction) => void;
}) {
  const effectiveStorage = useMemo<SessionStorageLike>(() => {
    if (storage) return storage;
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
    const mem = new Map<string, string>();
    return {
      getItem: (key) => mem.get(key) ?? null,
      setItem: (key, value) => {
        mem.set(key, value);
      },
      removeItem: (key) => {
        mem.delete(key);
      },
    };
  }, [storage]);

  const client = useMemo(
    () => gateway ?? httpVisibilityGateway(effectiveStorage),
    [effectiveStorage, gateway],
  );

  const initialUrlParams = useMemo(() => parseHrefParams(href), [href]);

  const [activeTab, setActiveTab] = useState<'runs' | 'profiles'>('runs');
  const [profiles, setProfiles] = useState<VisibilityProfileRecord[]>([]);
  const [prefillSources, setPrefillSources] = useState<VisibilityPrefillSources>({
    keywords: [],
    knowledgeBases: [],
  });
  const [defaultProfileId, setDefaultProfileId] = useState<string>(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(DEFAULT_PROFILE_STORAGE_KEY) ?? '';
    }
    return '';
  });

  const [keywords, setKeywords] = useState<KeywordRecord[]>([]);
  const [prices, setPrices] = useState<PriceItem[] | null>(null);

  const [query, setQuery] = useState<VisibilityRunListQuery>(() => ({
    page: 1,
    pageSize: 10,
    profileId: initialUrlParams.profileId,
    status: undefined,
    keyword: undefined,
  }));
  const [keywordDraft, setKeywordDraft] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const [runs, setRuns] = useState<VisibilityRunRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reloadTick, setReloadTick] = useState(0);

  const [banner, setBanner] = useState<{
    type: 'success' | 'error' | 'info' | 'warning';
    text: string;
  } | null>(null);

  // Profile Create/Edit Modal
  const [profileModal, setProfileModal] = useState<ProfileModalState | null>(null);
  const [profileModalError, setProfileModalError] = useState<string | null>(null);
  const [profileSubmitting, setProfileSubmitting] = useState(false);
  const [deleteProfileTarget, setDeleteProfileTarget] = useState<VisibilityProfileRecord | null>(
    null,
  );

  // Run Create Modal
  const [runModal, setRunModal] = useState<RunModalState | null>(null);
  const [runModalError, setRunModalError] = useState<string | null>(null);
  const [runSubmitting, setRunSubmitting] = useState(false);
  const [keywordQuestions, setKeywordQuestions] = useState<QuestionRecord[]>([]);
  const [questionsLoading, setQuestionsLoading] = useState(false);

  // Run Control Modals
  const [cancelTarget, setCancelTarget] = useState<VisibilityRunRecord | null>(null);
  const [deleteRunIds, setDeleteRunIds] = useState<string[] | null>(null);
  const [controlLoading, setControlLoading] = useState(false);

  // Diagnostic Detail Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRun, setDetailRun] = useState<VisibilityRunDetailRecord | null>(null);
  const [obsEngineFilter, setObsEngineFilter] = useState<string>('');
  const [obsMentionFilter, setObsMentionFilter] = useState<'all' | 'mentioned' | 'unmentioned'>(
    'all',
  );
  const [obsSentimentFilter, setObsSentimentFilter] = useState<string>('');
  const [expandedAnswerIds, setExpandedAnswerIds] = useState<Record<string, boolean>>({});
  const [expandedCitationIds, setExpandedCitationIds] = useState<Record<string, boolean>>({});

  const effectiveDefaultProfileId = useMemo(() => {
    if (defaultProfileId && profiles.some((p) => p.id === defaultProfileId)) {
      return defaultProfileId;
    }
    return profiles[0]?.id ?? '';
  }, [defaultProfileId, profiles]);

  const persistDefaultProfile = useCallback((id: string) => {
    setDefaultProfileId(id);
    if (typeof window !== 'undefined' && window.localStorage) {
      if (id) window.localStorage.setItem(DEFAULT_PROFILE_STORAGE_KEY, id);
      else window.localStorage.removeItem(DEFAULT_PROFILE_STORAGE_KEY);
    }
  }, []);

  const unitPoints = useMemo(() => {
    const found = prices?.find((item) => item.action === 'visibility_check' && item.enabled);
    return found?.unitPoints ?? VISIBILITY_DEFAULT_UNIT_POINTS;
  }, [prices]);

  // Load profiles, keywords, and prices on mount
  const loadMeta = useCallback(async () => {
    if (!featureEnabled) return;
    try {
      const [profileRes, kwList, priceList] = await Promise.all([
        client.listProfiles(),
        client.listKeywords().catch(() => []),
        client.listPrices().catch(() => [
          {
            action: 'visibility_check',
            unitPoints: VISIBILITY_DEFAULT_UNIT_POINTS,
            enabled: true,
            label: 'AI可见性监测',
          },
        ]),
      ]);
      setProfiles(profileRes.items);
      if (profileRes.prefillSources) {
        setPrefillSources(profileRes.prefillSources);
      }
      setKeywords(kwList);
      setPrices(priceList);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '加载监测档案失败',
      });
    }
  }, [client, featureEnabled]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  // Load runs list when query or reloadTick changes
  useEffect(() => {
    if (!featureEnabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void client
      .listRuns(query)
      .then((res) => {
        if (cancelled) return;
        setRuns(res.items);
        setTotal(res.total);
      })
      .catch((err) => {
        if (cancelled) return;
        setBanner({
          type: 'error',
          text: err instanceof Error ? err.message : '读取监测任务列表失败',
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, featureEnabled, query, reloadTick]);

  // Open detail drawer automatically when href carries ?runId=...
  const openDetailDrawer = useCallback(
    async (runId: string) => {
      setDrawerOpen(true);
      setDetailLoading(true);
      setObsEngineFilter('');
      setObsMentionFilter('all');
      setObsSentimentFilter('');
      setExpandedAnswerIds({});
      setExpandedCitationIds({});
      try {
        const detail = await client.getRun(runId);
        setDetailRun(detail);
      } catch (err) {
        setBanner({
          type: 'error',
          text: err instanceof Error ? err.message : '加载诊断详情失败',
        });
        setDrawerOpen(false);
      } finally {
        setDetailLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    if (!featureEnabled) return;
    if (initialUrlParams.profileId) {
      setQuery((curr) =>
        curr.profileId === initialUrlParams.profileId
          ? curr
          : { ...curr, page: 1, profileId: initialUrlParams.profileId },
      );
    }
    if (initialUrlParams.runId) {
      void openDetailDrawer(initialUrlParams.runId);
    }
  }, [featureEnabled, initialUrlParams.profileId, initialUrlParams.runId, openDetailDrawer]);

  // 5-second automatic polling when any run (or open detail run) is QUEUED or RUNNING
  const hasActiveRun = useMemo(() => {
    const listActive = runs.some((r) => r.status === 'QUEUED' || r.status === 'RUNNING');
    const drawerActive =
      drawerOpen &&
      detailRun !== null &&
      (detailRun.status === 'QUEUED' || detailRun.status === 'RUNNING');
    return listActive || drawerActive;
  }, [detailRun, drawerOpen, runs]);

  const detailRunId = detailRun?.id ?? null;

  useEffect(() => {
    if (!featureEnabled || !hasActiveRun || pollIntervalMs <= 0) return;
    const timer = setInterval(() => {
      void client
        .listRuns(query)
        .then((res) => {
          setRuns(res.items);
          setTotal(res.total);
        })
        .catch(() => undefined);

      if (drawerOpen && detailRunId) {
        void client
          .getRun(detailRunId)
          .then((fresh) => setDetailRun(fresh))
          .catch(() => undefined);
      }
    }, pollIntervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [client, detailRunId, drawerOpen, featureEnabled, hasActiveRun, pollIntervalMs, query]);

  // Load questions whenever runModal opens or its selected keywordId changes
  const isRunModalOpen = runModal !== null;
  const activeModalKeywordId = runModal?.draft.keywordId ?? '';
  useEffect(() => {
    if (!isRunModalOpen) return;
    if (!activeModalKeywordId) {
      setKeywordQuestions([]);
      return;
    }
    let cancelled = false;
    setQuestionsLoading(true);
    void client
      .listQuestionsByKeyword(activeModalKeywordId)
      .then((items) => {
        if (cancelled) return;
        setKeywordQuestions(items);
      })
      .catch(() => {
        if (!cancelled) setKeywordQuestions([]);
      })
      .finally(() => {
        if (!cancelled) setQuestionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeModalKeywordId, client, isRunModalOpen]);

  // ===================== Profile Handlers =====================

  function openCreateProfileModal() {
    if (readOnly) return;
    const initial = buildEmptyProfileDraft(profiles.length === 0);
    setProfileModalError(null);
    setProfileModal({
      initial,
      draft: initial,
      minimized: false,
      maximized: false,
    });
  }

  function openEditProfileModal(profile: VisibilityProfileRecord) {
    if (readOnly) return;
    const initial = buildEditProfileDraft(profile, profile.id === effectiveDefaultProfileId);
    setProfileModalError(null);
    setProfileModal({
      initial,
      draft: initial,
      minimized: false,
      maximized: false,
    });
  }

  function applyKeywordPrefill(keywordId: string) {
    setProfileModal((curr) => {
      if (!curr) return curr;
      if (!keywordId) {
        return {
          ...curr,
          draft: { ...curr.draft, importFromKeywordId: '' },
        };
      }
      const kw = prefillSources.keywords.find((item) => item.id === keywordId);
      if (!kw) return curr;
      const cleanBrands = kw.brands.map((b) => b.trim()).filter(Boolean);
      const primaryBrand = curr.draft.brandName.trim() || cleanBrands[0] || kw.main;
      const existingAliases = splitTagList(curr.draft.brandAliasesText);
      const mergedAliases = [
        ...new Set(
          [...existingAliases, ...cleanBrands].filter(
            (alias) => alias.toLowerCase() !== primaryBrand.toLowerCase(),
          ),
        ),
      ];
      return {
        ...curr,
        draft: {
          ...curr.draft,
          importFromKeywordId: keywordId,
          name: curr.draft.name.trim() || `${primaryBrand}品牌监测档案`,
          brandName: primaryBrand,
          brandAliasesText: mergedAliases.join(', '),
        },
      };
    });
  }

  function applyKbPrefill(kbId: string) {
    setProfileModal((curr) => {
      if (!curr) return curr;
      if (!kbId) {
        return {
          ...curr,
          draft: { ...curr.draft, importFromKbId: '' },
        };
      }
      const kb = prefillSources.knowledgeBases.find((item) => item.id === kbId);
      if (!kb) return curr;
      const candidates = [kb.brandShort, kb.companyName, kb.name]
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => v.trim());
      const primaryBrand = curr.draft.brandName.trim() || candidates[0] || '';
      const existingAliases = splitTagList(curr.draft.brandAliasesText);
      const extraTerms = [kb.brandShort, kb.companyName]
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => v.trim());
      const mergedAliases = [
        ...new Set(
          [...existingAliases, ...extraTerms].filter(
            (alias) => alias.toLowerCase() !== primaryBrand.toLowerCase(),
          ),
        ),
      ];
      return {
        ...curr,
        draft: {
          ...curr.draft,
          importFromKbId: kbId,
          name: curr.draft.name.trim() || `${primaryBrand || kb.name}监测档案`,
          brandName: primaryBrand,
          brandAliasesText: mergedAliases.join(', '),
        },
      };
    });
  }

  async function handleSaveProfile() {
    if (!profileModal || readOnly) return;
    const { draft } = profileModal;
    setProfileModalError(null);

    const name = draft.name.trim();
    if (!name) {
      setProfileModalError('请填写监测档案名称');
      return;
    }
    if (name.length > VISIBILITY_PROFILE_NAME_MAX) {
      setProfileModalError(`档案名称不能超过 ${VISIBILITY_PROFILE_NAME_MAX} 个字符`);
      return;
    }

    const brandName = draft.brandName.trim();
    if (
      !brandName &&
      !(draft.mode === 'create' && (draft.importFromKeywordId || draft.importFromKbId))
    ) {
      setProfileModalError('请填写主品牌名称，或选择关键词/企业知识库快捷导入');
      return;
    }
    if (brandName.length > VISIBILITY_BRAND_NAME_MAX) {
      setProfileModalError(`主品牌名称不能超过 ${VISIBILITY_BRAND_NAME_MAX} 个字符`);
      return;
    }

    const rawOwnedDomains = splitTagList(draft.ownedDomainsText);
    const ownedDomains: string[] = [];
    for (const rawDom of rawOwnedDomains) {
      const normalized = normalizeVisibilityDomain(rawDom);
      if (!normalized) {
        setProfileModalError(`自有域名格式不正确：${rawDom}（示例：geomix.cn 或 docs.geomix.cn）`);
        return;
      }
      if (!ownedDomains.includes(normalized)) ownedDomains.push(normalized);
    }

    if (draft.competitors.length > VISIBILITY_MAX_COMPETITORS) {
      setProfileModalError(`最多配置 ${VISIBILITY_MAX_COMPETITORS} 个监测竞品`);
      return;
    }

    const competitors: VisibilityCompetitor[] = [];
    for (let i = 0; i < draft.competitors.length; i += 1) {
      const row = draft.competitors[i]!;
      const compName = row.name.trim();
      if (!compName) {
        setProfileModalError(`请填写第 ${i + 1} 个竞品的品牌名称，或移除空行`);
        return;
      }
      const compDomains: string[] = [];
      for (const rawDom of splitTagList(row.domainsText)) {
        const normalized = normalizeVisibilityDomain(rawDom);
        if (!normalized) {
          setProfileModalError(`竞品「${compName}」的域名格式不正确：${rawDom}`);
          return;
        }
        if (!compDomains.includes(normalized)) compDomains.push(normalized);
      }
      competitors.push({
        name: compName,
        aliases: splitTagList(row.aliasesText),
        domains: compDomains,
      });
    }

    const brandAliases = splitTagList(draft.brandAliasesText);

    setProfileSubmitting(true);
    try {
      let saved: VisibilityProfileRecord;
      if (draft.mode === 'edit' && draft.editId) {
        saved = await client.updateProfile(draft.editId, {
          name,
          brandName,
          brandAliases,
          ownedDomains,
          competitors,
        });
        setProfiles((curr) => curr.map((item) => (item.id === saved.id ? saved : item)));
        setBanner({ type: 'success', text: `已更新监测档案「${saved.name}」` });
      } else {
        saved = await client.createProfile({
          name,
          ...(brandName ? { brandName } : {}),
          brandAliases,
          ownedDomains,
          competitors,
          ...(draft.importFromKeywordId ? { importFromKeywordId: draft.importFromKeywordId } : {}),
          ...(draft.importFromKbId ? { importFromKbId: draft.importFromKbId } : {}),
        });
        setProfiles((curr) => [saved, ...curr]);
        setBanner({ type: 'success', text: `已创建监测档案「${saved.name}」` });
      }

      if (draft.isDefault || profiles.length === 0) {
        persistDefaultProfile(saved.id);
      }
      setProfileModal(null);
    } catch (err) {
      setProfileModalError(err instanceof Error ? err.message : '保存监测档案失败');
    } finally {
      setProfileSubmitting(false);
    }
  }

  async function handleConfirmDeleteProfile() {
    if (!deleteProfileTarget || readOnly) return;
    setControlLoading(true);
    try {
      await client.deleteProfile(deleteProfileTarget.id);
      const removedId = deleteProfileTarget.id;
      const removedName = deleteProfileTarget.name;
      setProfiles((curr) => curr.filter((p) => p.id !== removedId));
      if (defaultProfileId === removedId) {
        persistDefaultProfile('');
      }
      if (query.profileId === removedId) {
        setQuery((curr) => ({ ...curr, page: 1, profileId: undefined }));
      }
      setDeleteProfileTarget(null);
      setBanner({ type: 'success', text: `已删除监测档案「${removedName}」` });
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '删除监测档案失败',
      });
      setDeleteProfileTarget(null);
    } finally {
      setControlLoading(false);
    }
  }

  // ===================== Run Creation & Control Handlers =====================

  function openCreateRunModal(presetProfileId?: string) {
    if (readOnly) return;
    if (profiles.length === 0) {
      setActiveTab('profiles');
      openCreateProfileModal();
      setBanner({
        type: 'info',
        text: '请先创建至少一个「品牌与竞品档案」，随后即可发起多引擎可见度监测',
      });
      return;
    }
    const targetProfileId = presetProfileId || query.profileId || effectiveDefaultProfileId;
    const initial = buildDefaultRunDraft(targetProfileId, keywords[0]?.id ?? '');
    setRunModalError(null);
    setRunModal({
      initial,
      draft: initial,
      idempotencyKey: createVisibilityIdempotencyKey('vrun'),
      minimized: false,
      maximized: false,
    });
  }

  function patchRunDraft(updater: (prev: RunCreateDraft) => RunCreateDraft) {
    setRunModal((curr) => {
      if (!curr) return curr;
      return {
        ...curr,
        draft: updater(curr.draft),
        idempotencyKey: createVisibilityIdempotencyKey('vrun'),
      };
    });
  }

  const runPromptCount = useMemo(() => {
    if (!runModal) return 0;
    const seen = new Set<string>();
    for (const qId of runModal.draft.questionIds) {
      const q = keywordQuestions.find((item) => item.id === qId);
      const key = (q?.text ?? qId).replace(/\s+/g, ' ').trim().toLowerCase();
      if (key) seen.add(key);
    }
    for (const line of splitPromptLines(runModal.draft.customPromptsText)) {
      seen.add(line.toLowerCase());
    }
    return seen.size;
  }, [keywordQuestions, runModal]);

  const runEngineCount = runModal?.draft.engines.length ?? 0;
  const runTotalChecks = runPromptCount * runEngineCount;
  const runTotalPoints =
    runTotalChecks > 0 ? quoteVisibilityRunPoints(runTotalChecks, unitPoints).totalPoints : 0;

  async function handleCreateRunSubmit() {
    if (!runModal || readOnly) return;
    const { draft, idempotencyKey } = runModal;
    setRunModalError(null);

    if (!draft.profileId) {
      setRunModalError('请选择监测档案');
      return;
    }
    if (draft.name.trim().length > VISIBILITY_RUN_NAME_MAX) {
      setRunModalError(`任务名称不能超过 ${VISIBILITY_RUN_NAME_MAX} 个字符`);
      return;
    }
    if (draft.engines.length === 0) {
      setRunModalError('请至少选择一个目标 AI 监测引擎');
      return;
    }
    const customPrompts = splitPromptLines(draft.customPromptsText);
    const tooShort = customPrompts.find((p) => p.length < 2);
    if (tooShort) {
      setRunModalError(`自定义监测问题至少需要 2 个字：「${tooShort}」`);
      return;
    }
    if (draft.questionIds.length === 0 && customPrompts.length === 0) {
      setRunModalError('请至少勾选一条已有问题或输入一条自定义监测问题');
      return;
    }

    setRunSubmitting(true);
    try {
      const created = await client.createRun(
        {
          profileId: draft.profileId,
          ...(draft.keywordId ? { keywordId: draft.keywordId } : {}),
          ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
          engines: draft.engines,
          questionIds: draft.questionIds,
          customPrompts,
        },
        idempotencyKey,
      );
      setRunModal(null);
      setActiveTab('runs');
      setBanner({
        type: 'success',
        text: `已发起监测任务「${created.name}」，共 ${created.totalChecks} 次检测（预冻 ${created.frozenPoints ?? created.totalChecks * created.unitPrice} 点数）`,
      });
      setReloadTick((n) => n + 1);
      void loadMeta();
    } catch (err) {
      setRunModalError(err instanceof Error ? err.message : '发起监测任务失败');
    } finally {
      setRunSubmitting(false);
    }
  }

  async function handlePauseRun(row: VisibilityRunRecord) {
    if (readOnly) return;
    try {
      const updated = await client.pauseRun(row.id);
      setRuns((curr) => curr.map((r) => (r.id === updated.id ? updated : r)));
      if (detailRun?.id === updated.id) setDetailRun(updated);
      setBanner({ type: 'success', text: `已暂停监测任务「${updated.name}」` });
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : '暂停监测任务失败' });
    }
  }

  async function handleResumeRun(row: VisibilityRunRecord) {
    if (readOnly) return;
    try {
      const updated = await client.resumeRun(row.id);
      setRuns((curr) => curr.map((r) => (r.id === updated.id ? updated : r)));
      if (detailRun?.id === updated.id) setDetailRun(updated);
      setBanner({ type: 'success', text: `已继续运行监测任务「${updated.name}」` });
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : '继续监测任务失败' });
    }
  }

  async function handleConfirmCancelRun() {
    if (!cancelTarget || readOnly) return;
    setControlLoading(true);
    try {
      const updated = await client.cancelRun(cancelTarget.id);
      setRuns((curr) => curr.map((r) => (r.id === updated.id ? updated : r)));
      if (detailRun?.id === updated.id) setDetailRun(updated);
      setCancelTarget(null);
      setBanner({
        type: 'success',
        text: `已终止监测任务「${updated.name}」，未执行检测项预冻点数已退回`,
      });
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : '终止监测任务失败' });
      setCancelTarget(null);
    } finally {
      setControlLoading(false);
    }
  }

  async function handleConfirmDeleteRuns() {
    if (!deleteRunIds || deleteRunIds.length === 0 || readOnly) return;
    setControlLoading(true);
    try {
      const res = await client.bulkDeleteRuns(deleteRunIds);
      if (detailRun && deleteRunIds.includes(detailRun.id)) {
        setDrawerOpen(false);
        setDetailRun(null);
      }
      setSelectedIds((curr) => curr.filter((id) => !deleteRunIds.includes(id)));
      setDeleteRunIds(null);
      setBanner({ type: 'success', text: `已删除 ${res.deleted} 条监测任务记录` });
      setReloadTick((n) => n + 1);
      void loadMeta();
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : '删除监测任务失败' });
      setDeleteRunIds(null);
    } finally {
      setControlLoading(false);
    }
  }

  function handleExportRuns(format: CrudExportFormat) {
    const bytes = buildRunsExportBytes(runs);
    const ext = format === 'xlsx' ? 'csv' : 'csv';
    downloadFile({
      filename: `geomix-visibility-runs.${ext}`,
      mime: 'text/csv;charset=utf-8',
      body: bytes,
    });
  }

  function openOverviewForProfile(profileId?: string) {
    const targetHref = profileId
      ? `/visibility/overview?profileId=${encodeURIComponent(profileId)}`
      : '/visibility/overview';
    onDispatch?.({ type: 'open', href: targetHref, sourceId: tabId });
  }

  // ===================== Filtered Observations in Drawer =====================

  const filteredObservations = useMemo(() => {
    if (!detailRun) return [];
    return detailRun.observations.filter((obs) => {
      if (obsEngineFilter && obs.engine !== obsEngineFilter) return false;
      if (obsMentionFilter === 'mentioned' && !obs.brandMentioned) return false;
      if (obsMentionFilter === 'unmentioned' && obs.brandMentioned) return false;
      if (obsSentimentFilter && obs.brandSentiment !== obsSentimentFilter) return false;
      return true;
    });
  }, [detailRun, obsEngineFilter, obsMentionFilter, obsSentimentFilter]);

  // ===================== CrudTable Columns =====================

  const columns: CrudColumn<VisibilityRunRecord>[] = [
    {
      key: 'name',
      title: '任务名称',
      width: 200,
      hideable: false,
      render: (row) => (
        <div>
          <Typography.Text strong>{row.name}</Typography.Text>
          {row.lastError ? (
            <div style={{ marginTop: 2 }}>
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                {row.lastError}
              </Typography.Text>
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'profile',
      title: '监测档案 / 主品牌',
      width: 170,
      render: (row) => (
        <Space direction="vertical" size={2}>
          <span>{row.profileName}</span>
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            {row.brandName}
          </Tag>
        </Space>
      ),
    },
    {
      key: 'keywordMain',
      title: '关联主词',
      width: 130,
      render: (row) =>
        row.keywordMain ? (
          <Tag color="geekblue">{row.keywordMain}</Tag>
        ) : (
          <Typography.Text type="secondary">自定义问题</Typography.Text>
        ),
    },
    {
      key: 'engines',
      title: '监测引擎',
      width: 210,
      render: (row) => {
        const shown = row.engines.slice(0, 3);
        const rest = row.engines.length - shown.length;
        return (
          <Space size={[4, 4]} wrap>
            {shown.map((eng) => (
              <Tag key={eng} style={{ marginInlineEnd: 0 }}>
                {VISIBILITY_ENGINE_LABELS[eng] ?? eng}
              </Tag>
            ))}
            {rest > 0 ? <Tag style={{ marginInlineEnd: 0 }}>+{rest}</Tag> : null}
          </Space>
        );
      },
    },
    {
      key: 'progress',
      title: '检测进度',
      width: 130,
      render: (row) => (
        <div>
          <Typography.Text strong>
            {row.doneCount} / {row.totalChecks}
          </Typography.Text>
          {row.failCount > 0 || (row.skipCount ?? 0) > 0 ? (
            <div style={{ fontSize: 12, color: '#64748b' }}>
              {row.failCount > 0 ? `失败 ${row.failCount} ` : ''}
              {(row.skipCount ?? 0) > 0 ? `跳过 ${row.skipCount}` : ''}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'visibilityPct',
      title: '品牌提及率',
      width: 110,
      render: (row) => {
        const pct = row.visibilityPct ?? 0;
        return (
          <Tag color={pct >= 50 ? 'success' : pct > 0 ? 'processing' : 'default'}>
            {pct.toFixed(1)}%
          </Tag>
        );
      },
    },
    {
      key: 'points',
      title: '预冻 / 结算点数',
      width: 140,
      render: (row) => {
        const frozen = row.frozenPoints ?? row.totalChecks * row.unitPrice;
        const settled = row.settledPoints ?? 0;
        return (
          <div style={{ fontSize: 13 }}>
            <div>预冻 {frozen} 点</div>
            <div style={{ color: '#64748b', fontSize: 12 }}>已结 {settled} 点</div>
          </div>
        );
      },
    },
    {
      key: 'status',
      title: '状态',
      width: 96,
      render: (row) => (
        <Tag color={statusTagColor(row.status)}>{TASK_STATUS_LABELS[row.status]}</Tag>
      ),
    },
    {
      key: 'createdAt',
      title: '创建时间',
      width: 144,
      render: (row) => formatTime(row.createdAt),
    },
    {
      key: 'actions',
      title: '操作',
      width: 210,
      hideable: false,
      render: (row) => (
        <Space size={4} wrap>
          <Button
            type="link"
            size="small"
            aria-label={`查看详情-${row.name}`}
            onClick={() => void openDetailDrawer(row.id)}
          >
            查看详情
          </Button>
          <Button
            type="link"
            size="small"
            aria-label={`去看板分析-${row.name}`}
            onClick={() => openOverviewForProfile(row.profileId)}
          >
            去看板分析
          </Button>
          {(row.status === 'QUEUED' || row.status === 'RUNNING') && !readOnly ? (
            <Button
              type="link"
              size="small"
              aria-label={`暂停-${row.name}`}
              onClick={() => void handlePauseRun(row)}
            >
              暂停
            </Button>
          ) : null}
          {row.status === 'PAUSED' && !readOnly ? (
            <Button
              type="link"
              size="small"
              aria-label={`继续-${row.name}`}
              onClick={() => void handleResumeRun(row)}
            >
              继续
            </Button>
          ) : null}
          {isControllableRunStatus(row.status) && !readOnly ? (
            <Button
              type="link"
              size="small"
              danger
              aria-label={`终止-${row.name}`}
              onClick={() => setCancelTarget(row)}
            >
              终止
            </Button>
          ) : null}
          {!isControllableRunStatus(row.status) && !readOnly ? (
            <Button
              type="link"
              size="small"
              danger
              aria-label={`删除-${row.name}`}
              onClick={() => setDeleteRunIds([row.id])}
            >
              删除
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  if (!featureEnabled) {
    return (
      <section>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          {title}
        </Typography.Title>
        <Alert
          type="info"
          showIcon
          message="当前站点尚未开启 AI 可见度诊断功能，如需启用请联系管理员开启 FEATURE_VISIBILITY。"
        />
      </section>
    );
  }

  return (
    <section style={{ minWidth: 0 }}>
      {/* Top Header */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            跨国内 8
            大主流模型与海外搜索引擎，批量诊断企业品牌提及率、推荐顺位、情感倾向与权威引用信源
          </Typography.Text>
        </div>
        <Space wrap>
          <PriceButton action="visibility_check" prices={prices} />
          <Button
            aria-label="新建品牌档案"
            disabled={readOnly}
            onClick={() => openCreateProfileModal()}
          >
            新建品牌档案
          </Button>
          <Button
            type="primary"
            aria-label="新建监测任务"
            disabled={readOnly}
            onClick={() => openCreateRunModal()}
          >
            新建监测任务
          </Button>
          <Button
            aria-label="前往AI数据看板"
            onClick={() => openOverviewForProfile(query.profileId)}
          >
            AI数据看板
          </Button>
        </Space>
      </div>

      {banner ? (
        <Alert
          type={banner.type}
          showIcon
          closable
          onClose={() => setBanner(null)}
          message={banner.text}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key === 'profiles' ? 'profiles' : 'runs')}
        items={[
          {
            key: 'runs',
            label: `监测任务（${total}）`,
            children: (
              <div style={{ minWidth: 0 }}>
                {/* Quick Filter Bar */}
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 8,
                    padding: 12,
                    marginBottom: 12,
                    borderRadius: 8,
                    border: '1px solid #e6eaf0',
                    background: '#f8fafc',
                  }}
                >
                  <select
                    aria-label="筛选监测档案"
                    style={{ ...COMPACT_SELECT_STYLE, width: 180 }}
                    value={query.profileId ?? ''}
                    onChange={(e) => {
                      const nextProfileId = e.target.value || undefined;
                      setSelectedIds([]);
                      setQuery((curr) => ({ ...curr, page: 1, profileId: nextProfileId }));
                    }}
                  >
                    <option value="">全部监测档案</option>
                    {profiles.map((prof) => (
                      <option key={prof.id} value={prof.id}>
                        {prof.name}（{prof.brandName}）
                      </option>
                    ))}
                  </select>

                  <select
                    aria-label="筛选任务状态"
                    style={{ ...COMPACT_SELECT_STYLE, width: 140 }}
                    value={query.status ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSelectedIds([]);
                      setQuery((curr) => ({
                        ...curr,
                        page: 1,
                        status: isTaskStatus(val) ? val : undefined,
                      }));
                    }}
                  >
                    <option value="">全部状态</option>
                    {TASK_STATUSES.map((st) => (
                      <option key={st} value={st}>
                        {TASK_STATUS_LABELS[st]}
                      </option>
                    ))}
                  </select>

                  <Input
                    aria-label="搜索监测任务"
                    placeholder="搜索任务名、品牌或主词"
                    value={keywordDraft}
                    style={{ width: 220, maxWidth: '100%' }}
                    onChange={(e) => setKeywordDraft(e.target.value)}
                    onPressEnter={() => {
                      setSelectedIds([]);
                      setQuery((curr) => ({
                        ...curr,
                        page: 1,
                        keyword: keywordDraft.trim() || undefined,
                      }));
                    }}
                  />

                  <Button
                    type="primary"
                    aria-label="查询监测任务"
                    onClick={() => {
                      setSelectedIds([]);
                      setQuery((curr) => ({
                        ...curr,
                        page: 1,
                        keyword: keywordDraft.trim() || undefined,
                      }));
                    }}
                  >
                    查询
                  </Button>

                  <Button
                    aria-label="重置任务筛选"
                    onClick={() => {
                      setKeywordDraft('');
                      setSelectedIds([]);
                      setQuery((curr) => ({
                        ...curr,
                        page: 1,
                        profileId: undefined,
                        status: undefined,
                        keyword: undefined,
                      }));
                    }}
                  >
                    重置筛选
                  </Button>

                  {hasActiveRun ? (
                    <Tag color="processing" style={{ marginInlineStart: 'auto' }}>
                      运行中每 5 秒自动同步进度
                    </Tag>
                  ) : null}
                </div>

                <div style={{ width: '100%', overflowX: 'auto' }}>
                  <CrudTable
                    rows={runs}
                    columns={columns}
                    total={total}
                    page={query.page}
                    pageSize={query.pageSize}
                    loading={loading}
                    selectedIds={selectedIds}
                    searchOpen={searchOpen}
                    writeDisabled={readOnly}
                    emptyText={
                      profiles.length === 0
                        ? '尚未创建品牌监测档案，请先点击「新建品牌档案」配置主品牌与竞品后再发起监测'
                        : CRUD_EMPTY_TEXT
                    }
                    search={{
                      keyword: query.keyword ?? '',
                      enabled: undefined,
                      sort: 'createdAt',
                      order: 'desc',
                    }}
                    onSearchOpenChange={setSearchOpen}
                    onSearch={(search) => {
                      setKeywordDraft(search.keyword);
                      setSelectedIds([]);
                      setQuery((curr) => ({
                        ...curr,
                        page: 1,
                        keyword: search.keyword.trim() || undefined,
                      }));
                    }}
                    onPageChange={(page, pageSize) => {
                      setSelectedIds([]);
                      setQuery((curr) => ({ ...curr, page, pageSize }));
                    }}
                    onSelectionChange={setSelectedIds}
                    onExport={handleExportRuns}
                    onRefresh={() => {
                      setReloadTick((n) => n + 1);
                      void loadMeta();
                    }}
                    onCreate={readOnly ? undefined : () => openCreateRunModal()}
                    onDelete={readOnly ? undefined : () => setDeleteRunIds(selectedIds)}
                  />
                </div>
              </div>
            ),
          },
          {
            key: 'profiles',
            label: `品牌与竞品档案（${profiles.length}）`,
            children: (
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 12,
                  }}
                >
                  <Typography.Text type="secondary">
                    每个档案定义主品牌名称、常见中英文别名、自有官网域名及最多{' '}
                    {VISIBILITY_MAX_COMPETITORS} 个同赛道竞品，用于自动识别提及顺位与引用信源分类。
                  </Typography.Text>
                  <Button
                    type="primary"
                    aria-label="新增品牌与竞品档案"
                    disabled={readOnly}
                    onClick={() => openCreateProfileModal()}
                  >
                    新增档案
                  </Button>
                </div>

                {profiles.length === 0 ? (
                  <div
                    style={{
                      padding: '36px 20px',
                      textAlign: 'center',
                      border: '1px dashed #d9e2ef',
                      borderRadius: 10,
                      background: '#f8fafc',
                    }}
                  >
                    <Typography.Title level={5} style={{ marginTop: 0 }}>
                      暂无品牌与竞品监测档案
                    </Typography.Title>
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                      您可以直接录入主品牌与官网域名，或从已有「关键词 /
                      企业知识库」一键预填品牌词。
                    </Typography.Paragraph>
                    <Button
                      type="primary"
                      disabled={readOnly}
                      onClick={() => openCreateProfileModal()}
                    >
                      立即创建首个品牌档案
                    </Button>
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))',
                      gap: 14,
                    }}
                  >
                    {profiles.map((prof) => {
                      const isDefault = prof.id === effectiveDefaultProfileId;
                      return (
                        <div
                          key={prof.id}
                          data-testid={`profile-card-${prof.id}`}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between',
                            gap: 12,
                            padding: 16,
                            border: isDefault ? '1px solid #91caff' : '1px solid #e6eaf0',
                            borderRadius: 10,
                            background: isDefault ? '#f8fbff' : '#ffffff',
                            minWidth: 0,
                          }}
                        >
                          <div>
                            <div
                              style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 6,
                                marginBottom: 8,
                              }}
                            >
                              <Typography.Text strong style={{ fontSize: 16 }}>
                                {prof.name}
                              </Typography.Text>
                              <Space size={4} wrap>
                                {isDefault ? <Tag color="blue">默认档案</Tag> : null}
                                <Tag>{prof.runCount ?? 0} 次任务</Tag>
                              </Space>
                            </div>

                            <div style={{ marginBottom: 8, fontSize: 13 }}>
                              <Typography.Text type="secondary">主品牌：</Typography.Text>
                              <Tag color="geekblue" style={{ marginInlineStart: 4 }}>
                                {prof.brandName}
                              </Tag>
                            </div>

                            <div style={{ marginBottom: 8, fontSize: 13 }}>
                              <Typography.Text type="secondary">品牌别名：</Typography.Text>
                              {prof.brandAliases.length > 0 ? (
                                <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
                                  {prof.brandAliases.map((alias) => (
                                    <Tag key={alias} style={{ marginInlineEnd: 0 }}>
                                      {alias}
                                    </Tag>
                                  ))}
                                </Space>
                              ) : (
                                <Typography.Text type="secondary">未设置别名</Typography.Text>
                              )}
                            </div>

                            <div style={{ marginBottom: 8, fontSize: 13 }}>
                              <Typography.Text type="secondary">自有官网域名：</Typography.Text>
                              {prof.ownedDomains.length > 0 ? (
                                <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
                                  {prof.ownedDomains.map((dom) => (
                                    <Tag key={dom} color="cyan" style={{ marginInlineEnd: 0 }}>
                                      {dom}
                                    </Tag>
                                  ))}
                                </Space>
                              ) : (
                                <Typography.Text type="secondary">未配置域名</Typography.Text>
                              )}
                            </div>

                            <div style={{ fontSize: 13 }}>
                              <Typography.Text type="secondary">
                                监测竞品（{prof.competitors.length}/{VISIBILITY_MAX_COMPETITORS}
                                ）：
                              </Typography.Text>
                              {prof.competitors.length > 0 ? (
                                <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
                                  {prof.competitors.map((comp) => (
                                    <Tag
                                      key={comp.name}
                                      color="orange"
                                      style={{ marginInlineEnd: 0 }}
                                    >
                                      {comp.name}
                                    </Tag>
                                  ))}
                                </Space>
                              ) : (
                                <Typography.Text type="secondary">未添加竞品</Typography.Text>
                              )}
                            </div>
                          </div>

                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: 6,
                              paddingTop: 10,
                              borderTop: '1px solid #f0f2f5',
                            }}
                          >
                            <Button
                              size="small"
                              type="primary"
                              aria-label={`发起监测-${prof.name}`}
                              disabled={readOnly}
                              onClick={() => openCreateRunModal(prof.id)}
                            >
                              发起监测
                            </Button>
                            <Button
                              size="small"
                              aria-label={`档案看板-${prof.name}`}
                              onClick={() => openOverviewForProfile(prof.id)}
                            >
                              看板分析
                            </Button>
                            {!isDefault ? (
                              <Button
                                size="small"
                                aria-label={`设为默认-${prof.name}`}
                                disabled={readOnly}
                                onClick={() => {
                                  persistDefaultProfile(prof.id);
                                  setBanner({
                                    type: 'success',
                                    text: `已将「${prof.name}」设为默认监测档案`,
                                  });
                                }}
                              >
                                设为默认
                              </Button>
                            ) : null}
                            <Button
                              size="small"
                              aria-label={`编辑档案-${prof.name}`}
                              disabled={readOnly}
                              onClick={() => openEditProfileModal(prof)}
                            >
                              编辑
                            </Button>
                            <Button
                              size="small"
                              danger
                              aria-label={`删除档案-${prof.name}`}
                              disabled={readOnly}
                              onClick={() => setDeleteProfileTarget(prof)}
                            >
                              删除
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />

      {/* ===================== Create / Edit Profile Modal ===================== */}
      <CrudModal
        open={profileModal !== null}
        title={profileModal?.draft.mode === 'edit' ? '编辑品牌与竞品档案' : '新建品牌与竞品档案'}
        minimized={profileModal?.minimized ?? false}
        maximized={profileModal?.maximized ?? false}
        confirmLoading={profileSubmitting}
        error={profileModalError}
        onMinimize={() => setProfileModal((curr) => (curr ? { ...curr, minimized: true } : curr))}
        onRestore={() => setProfileModal((curr) => (curr ? { ...curr, minimized: false } : curr))}
        onMaximize={() =>
          setProfileModal((curr) => (curr ? { ...curr, maximized: !curr.maximized } : curr))
        }
        onClose={() => {
          if (profileSubmitting) return;
          setProfileModal(null);
          setProfileModalError(null);
        }}
        onReset={() => {
          setProfileModalError(null);
          setProfileModal((curr) => (curr ? { ...curr, draft: curr.initial } : curr));
        }}
        ok={
          <Button
            type="primary"
            aria-label="保存品牌档案"
            loading={profileSubmitting}
            onClick={() => void handleSaveProfile()}
          >
            保存档案
          </Button>
        }
      >
        {profileModal ? (
          <div>
            {profileModal.draft.mode === 'create' &&
            (prefillSources.keywords.length > 0 || prefillSources.knowledgeBases.length > 0) ? (
              <div
                style={{
                  padding: 12,
                  marginBottom: 14,
                  borderRadius: 8,
                  border: '1px solid #d9e6ff',
                  background: '#f5f9ff',
                }}
              >
                <Typography.Text strong style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>
                  快捷预填品牌信息（可选）
                </Typography.Text>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: 10,
                  }}
                >
                  {prefillSources.keywords.length > 0 ? (
                    <label style={{ marginBottom: 0 }}>
                      <span style={{ fontSize: 12, color: '#475569' }}>从训练主词导入品牌词</span>
                      <select
                        aria-label="从关键词快捷预填"
                        style={NATIVE_SELECT_STYLE}
                        value={profileModal.draft.importFromKeywordId}
                        onChange={(e) => applyKeywordPrefill(e.target.value)}
                      >
                        <option value="">不导入主词</option>
                        {prefillSources.keywords.map((kw) => (
                          <option key={kw.id} value={kw.id}>
                            {kw.main}
                            {kw.brands.length > 0 ? `（品牌：${kw.brands.join(' / ')}）` : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {prefillSources.knowledgeBases.length > 0 ? (
                    <label style={{ marginBottom: 0 }}>
                      <span style={{ fontSize: 12, color: '#475569' }}>从企业知识库导入品牌词</span>
                      <select
                        aria-label="从知识库快捷预填"
                        style={NATIVE_SELECT_STYLE}
                        value={profileModal.draft.importFromKbId}
                        onChange={(e) => applyKbPrefill(e.target.value)}
                      >
                        <option value="">不导入知识库</option>
                        {prefillSources.knowledgeBases.map((kb) => (
                          <option key={kb.id} value={kb.id}>
                            {kb.name}
                            {kb.brandShort ? `（${kb.brandShort}）` : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              </div>
            ) : null}

            <label>
              <span>档案名称 *</span>
              <Input
                aria-label="档案名称"
                placeholder="例如：星图办公硬件-便携显示器监测档案"
                maxLength={VISIBILITY_PROFILE_NAME_MAX}
                value={profileModal.draft.name}
                onChange={(e) =>
                  setProfileModal((curr) =>
                    curr ? { ...curr, draft: { ...curr.draft, name: e.target.value } } : curr,
                  )
                }
              />
            </label>

            <label>
              <span>主品牌名称 *</span>
              <Input
                aria-label="主品牌名称"
                placeholder="例如：星图显示"
                maxLength={VISIBILITY_BRAND_NAME_MAX}
                value={profileModal.draft.brandName}
                onChange={(e) =>
                  setProfileModal((curr) =>
                    curr ? { ...curr, draft: { ...curr.draft, brandName: e.target.value } } : curr,
                  )
                }
              />
            </label>

            <label>
              <span>品牌别名（支持逗号或换行分隔，自动识别中英文简称）</span>
              <Input.TextArea
                aria-label="品牌别名"
                rows={2}
                placeholder="例如：StarView, 星图便携屏, 星图触控显示器"
                value={profileModal.draft.brandAliasesText}
                onChange={(e) =>
                  setProfileModal((curr) =>
                    curr
                      ? { ...curr, draft: { ...curr.draft, brandAliasesText: e.target.value } }
                      : curr,
                  )
                }
              />
              {splitTagList(profileModal.draft.brandAliasesText).length > 0 ? (
                <Space size={[4, 4]} wrap>
                  {splitTagList(profileModal.draft.brandAliasesText).map((tag) => (
                    <Tag key={tag} color="geekblue">
                      {tag}
                    </Tag>
                  ))}
                </Space>
              ) : null}
            </label>

            <label>
              <span>自有官网与文档域名（支持逗号或换行分隔，用于统计自有信源引用率）</span>
              <Input.TextArea
                aria-label="自有官网域名"
                rows={2}
                placeholder="例如：starview.cn, docs.starview.cn"
                value={profileModal.draft.ownedDomainsText}
                onChange={(e) =>
                  setProfileModal((curr) =>
                    curr
                      ? { ...curr, draft: { ...curr.draft, ownedDomainsText: e.target.value } }
                      : curr,
                  )
                }
              />
            </label>

            {/* Dynamic Competitor Rows */}
            <div style={{ marginBottom: 14 }}>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <Typography.Text strong>
                  同赛道监测竞品（{profileModal.draft.competitors.length}/
                  {VISIBILITY_MAX_COMPETITORS}）
                </Typography.Text>
                <Button
                  size="small"
                  aria-label="添加监测竞品"
                  disabled={profileModal.draft.competitors.length >= VISIBILITY_MAX_COMPETITORS}
                  onClick={() =>
                    setProfileModal((curr) => {
                      if (!curr || curr.draft.competitors.length >= VISIBILITY_MAX_COMPETITORS) {
                        return curr;
                      }
                      const nextRow: CompetitorDraftRow = {
                        key: `comp_${Date.now()}_${curr.draft.competitors.length}`,
                        name: '',
                        aliasesText: '',
                        domainsText: '',
                      };
                      return {
                        ...curr,
                        draft: {
                          ...curr.draft,
                          competitors: [...curr.draft.competitors, nextRow],
                        },
                      };
                    })
                  }
                >
                  添加竞品
                </Button>
              </div>

              {profileModal.draft.competitors.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  添加同品类竞品后，看板将自动计算本品牌与各竞品的声量占比（Share of
                  Voice）与竞品官网引用占比。
                </Typography.Text>
              ) : (
                <div style={{ display: 'grid', gap: 10 }}>
                  {profileModal.draft.competitors.map((comp, idx) => (
                    <div
                      key={comp.key}
                      style={{
                        padding: 10,
                        borderRadius: 8,
                        border: '1px solid #e6eaf0',
                        background: '#f8fafc',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: 6,
                        }}
                      >
                        <Typography.Text strong style={{ fontSize: 13 }}>
                          竞品 #{idx + 1}
                        </Typography.Text>
                        <Button
                          size="small"
                          type="text"
                          danger
                          aria-label={`移除竞品-${idx + 1}`}
                          onClick={() =>
                            setProfileModal((curr) =>
                              curr
                                ? {
                                    ...curr,
                                    draft: {
                                      ...curr.draft,
                                      competitors: curr.draft.competitors.filter(
                                        (_, i) => i !== idx,
                                      ),
                                    },
                                  }
                                : curr,
                            )
                          }
                        >
                          移除
                        </Button>
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                          gap: 8,
                        }}
                      >
                        <Input
                          aria-label={`竞品名称-${idx + 1}`}
                          placeholder="竞品名称（必填）"
                          value={comp.name}
                          onChange={(e) => {
                            const val = e.target.value;
                            setProfileModal((curr) =>
                              curr
                                ? {
                                    ...curr,
                                    draft: {
                                      ...curr.draft,
                                      competitors: curr.draft.competitors.map((row, i) =>
                                        i === idx ? { ...row, name: val } : row,
                                      ),
                                    },
                                  }
                                : curr,
                            );
                          }}
                        />
                        <Input
                          aria-label={`竞品别名-${idx + 1}`}
                          placeholder="竞品别名（逗号分隔）"
                          value={comp.aliasesText}
                          onChange={(e) => {
                            const val = e.target.value;
                            setProfileModal((curr) =>
                              curr
                                ? {
                                    ...curr,
                                    draft: {
                                      ...curr.draft,
                                      competitors: curr.draft.competitors.map((row, i) =>
                                        i === idx ? { ...row, aliasesText: val } : row,
                                      ),
                                    },
                                  }
                                : curr,
                            );
                          }}
                        />
                        <Input
                          aria-label={`竞品域名-${idx + 1}`}
                          placeholder="竞品域名（如 rival.cn）"
                          value={comp.domainsText}
                          onChange={(e) => {
                            const val = e.target.value;
                            setProfileModal((curr) =>
                              curr
                                ? {
                                    ...curr,
                                    draft: {
                                      ...curr.draft,
                                      competitors: curr.draft.competitors.map((row, i) =>
                                        i === idx ? { ...row, domainsText: val } : row,
                                      ),
                                    },
                                  }
                                : curr,
                            );
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Switch
                aria-label="设为默认档案"
                checked={profileModal.draft.isDefault}
                onChange={(checked) =>
                  setProfileModal((curr) =>
                    curr ? { ...curr, draft: { ...curr.draft, isDefault: checked } } : curr,
                  )
                }
              />
              <span>设为默认监测档案（进入数据看板与新建监测时默认选中）</span>
            </div>
          </div>
        ) : null}
      </CrudModal>

      {/* ===================== Create Monitoring Run Modal ===================== */}
      <CrudModal
        open={runModal !== null}
        title="新建 AI 可见度监测任务"
        minimized={runModal?.minimized ?? false}
        maximized={runModal?.maximized ?? false}
        confirmLoading={runSubmitting}
        error={runModalError}
        onMinimize={() => setRunModal((curr) => (curr ? { ...curr, minimized: true } : curr))}
        onRestore={() => setRunModal((curr) => (curr ? { ...curr, minimized: false } : curr))}
        onMaximize={() =>
          setRunModal((curr) => (curr ? { ...curr, maximized: !curr.maximized } : curr))
        }
        onClose={() => {
          if (runSubmitting) return;
          setRunModal(null);
          setRunModalError(null);
        }}
        onReset={() => {
          setRunModalError(null);
          setRunModal((curr) =>
            curr
              ? {
                  ...curr,
                  draft: curr.initial,
                  idempotencyKey: createVisibilityIdempotencyKey('vrun'),
                }
              : curr,
          );
        }}
        ok={
          <Button
            type="primary"
            aria-label={`开始监测（${unitPoints}点数/次，共 ${runTotalPoints} 点）`}
            loading={runSubmitting}
            disabled={runSubmitting}
            onClick={() => void handleCreateRunSubmit()}
          >
            {`开始监测（${unitPoints}点数/次，共 ${runTotalPoints} 点）`}
          </Button>
        }
      >
        {runModal ? (
          <div>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 14 }}
              message={`共 ${runPromptCount} 个问题 × ${runEngineCount} 个引擎 = ${runTotalChecks} 次检测，预计冻结 ${runTotalPoints} 点数（单价 ${unitPoints} 点/次，失败或终止未执行项自动退回）`}
            />

            <label>
              <span>选择监测档案 *</span>
              <select
                aria-label="选择监测档案"
                style={NATIVE_SELECT_STYLE}
                value={runModal.draft.profileId}
                onChange={(e) => patchRunDraft((prev) => ({ ...prev, profileId: e.target.value }))}
              >
                <option value="">请选择品牌监测档案</option>
                {profiles.map((prof) => (
                  <option key={prof.id} value={prof.id}>
                    {prof.name}（主品牌：{prof.brandName}）
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>任务名称（留空自动按品牌+日期生成）</span>
              <Input
                aria-label="监测任务名称"
                placeholder="例如：便携显示器2026采购季多模型可见度诊断"
                maxLength={VISIBILITY_RUN_NAME_MAX}
                value={runModal.draft.name}
                onChange={(e) => patchRunDraft((prev) => ({ ...prev, name: e.target.value }))}
              />
            </label>

            <label>
              <span>关联训练主词（可选，选中后可勾选该主词下的写作标题作为监测问题）</span>
              <select
                aria-label="关联训练主词"
                style={NATIVE_SELECT_STYLE}
                value={runModal.draft.keywordId}
                onChange={(e) => {
                  const nextKw = e.target.value;
                  patchRunDraft((prev) => ({
                    ...prev,
                    keywordId: nextKw,
                    questionIds: [],
                  }));
                }}
              >
                <option value="">不关联主词（仅使用下方自定义问题）</option>
                {keywords.map((kw) => (
                  <option key={kw.id} value={kw.id}>
                    {kw.main}
                  </option>
                ))}
              </select>
            </label>

            {runModal.draft.keywordId ? (
              <div
                style={{
                  padding: 12,
                  marginBottom: 12,
                  borderRadius: 8,
                  border: '1px solid #e6eaf0',
                  background: '#f8fafc',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    勾选待检测写作标题（已选 {runModal.draft.questionIds.length}/
                    {keywordQuestions.length}）
                  </Typography.Text>
                  <Space size={6}>
                    <Button
                      size="small"
                      aria-label="全选当前主词问题"
                      disabled={keywordQuestions.length === 0}
                      onClick={() =>
                        patchRunDraft((prev) => ({
                          ...prev,
                          questionIds: keywordQuestions.map((q) => q.id),
                        }))
                      }
                    >
                      全选
                    </Button>
                    <Button
                      size="small"
                      aria-label="清空已选问题"
                      disabled={runModal.draft.questionIds.length === 0}
                      onClick={() => patchRunDraft((prev) => ({ ...prev, questionIds: [] }))}
                    >
                      清空
                    </Button>
                  </Space>
                </div>

                {questionsLoading ? (
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    正在加载主词关联问题…
                  </Typography.Text>
                ) : keywordQuestions.length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    该主词下暂无写作标题，请在下方直接输入自定义监测问题。
                  </Typography.Text>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gap: 6,
                      maxHeight: 168,
                      overflowY: 'auto',
                    }}
                  >
                    {keywordQuestions.map((q) => {
                      const checked = runModal.draft.questionIds.includes(q.id);
                      return (
                        <Checkbox
                          key={q.id}
                          checked={checked}
                          onChange={(e) => {
                            const nextChecked = e.target.checked;
                            patchRunDraft((prev) => ({
                              ...prev,
                              questionIds: nextChecked
                                ? [...prev.questionIds, q.id]
                                : prev.questionIds.filter((id) => id !== q.id),
                            }));
                          }}
                        >
                          <span>{q.text}</span>
                          {q.included ? (
                            <Tag color="success" style={{ marginInlineStart: 6 }}>
                              已收录
                            </Tag>
                          ) : null}
                        </Checkbox>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}

            <label>
              <span>自定义监测问题（每行一条，支持与上方勾选标题同时提交）</span>
              <Input.TextArea
                aria-label="自定义监测问题"
                rows={4}
                placeholder={
                  '2026年出差办公便携显示器推荐哪几款？\n4K触控便携屏哪个品牌色彩准确且售后稳定？'
                }
                value={runModal.draft.customPromptsText}
                onChange={(e) =>
                  patchRunDraft((prev) => ({ ...prev, customPromptsText: e.target.value }))
                }
              />
            </label>

            <div style={{ marginBottom: 8 }}>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <Typography.Text strong>
                  目标 AI 引擎 *（已选 {runModal.draft.engines.length} 个）
                </Typography.Text>
                <Space size={6} wrap>
                  <Button
                    size="small"
                    aria-label="全选国内8大引擎"
                    onClick={() =>
                      patchRunDraft((prev) => ({
                        ...prev,
                        engines: [...DOMESTIC_VISIBILITY_ENGINE_KEYS],
                      }))
                    }
                  >
                    全选国内8大引擎
                  </Button>
                  <Button
                    size="small"
                    aria-label="全选全部引擎"
                    onClick={() =>
                      patchRunDraft((prev) => ({
                        ...prev,
                        engines: VISIBILITY_ENGINES.map((item) => item.key),
                      }))
                    }
                  >
                    全选全部引擎
                  </Button>
                  <Button
                    size="small"
                    aria-label="清空引擎选择"
                    onClick={() => patchRunDraft((prev) => ({ ...prev, engines: [] }))}
                  >
                    清空
                  </Button>
                </Space>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                  gap: 8,
                  padding: 10,
                  borderRadius: 8,
                  border: '1px solid #e6eaf0',
                  background: '#f8fafc',
                }}
              >
                {VISIBILITY_ENGINES.map((eng) => {
                  const checked = runModal.draft.engines.includes(eng.key);
                  return (
                    <Checkbox
                      key={eng.key}
                      aria-label={`选择引擎-${eng.label}`}
                      checked={checked}
                      onChange={(e) => {
                        const nextChecked = e.target.checked;
                        patchRunDraft((prev) => ({
                          ...prev,
                          engines: nextChecked
                            ? [...prev.engines, eng.key]
                            : prev.engines.filter((k) => k !== eng.key),
                        }));
                      }}
                    >
                      <span>{eng.label}</span>
                      {eng.domestic ? (
                        <Tag color="blue" style={{ marginInlineStart: 4, fontSize: 11 }}>
                          国内
                        </Tag>
                      ) : null}
                    </Checkbox>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}
      </CrudModal>

      {/* ===================== Diagnostic Detail Drawer ===================== */}
      <Drawer
        open={drawerOpen}
        title={detailRun ? `可见度诊断明细 · ${detailRun.name}` : '可见度诊断明细'}
        width="min(880px, 100vw)"
        onClose={() => setDrawerOpen(false)}
        extra={
          detailRun ? (
            <Space size={6} wrap>
              <Button size="small" onClick={() => openOverviewForProfile(detailRun.profileId)}>
                去看板分析
              </Button>
              {(detailRun.status === 'QUEUED' || detailRun.status === 'RUNNING') && !readOnly ? (
                <Button size="small" onClick={() => void handlePauseRun(detailRun)}>
                  暂停
                </Button>
              ) : null}
              {detailRun.status === 'PAUSED' && !readOnly ? (
                <Button size="small" onClick={() => void handleResumeRun(detailRun)}>
                  继续
                </Button>
              ) : null}
              {isControllableRunStatus(detailRun.status) && !readOnly ? (
                <Button size="small" danger onClick={() => setCancelTarget(detailRun)}>
                  终止
                </Button>
              ) : null}
            </Space>
          ) : null
        }
      >
        {detailLoading && !detailRun ? (
          <Typography.Text type="secondary">正在加载诊断明细…</Typography.Text>
        ) : detailRun ? (
          <div style={{ minWidth: 0 }}>
            {/* Summary Status Strip */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12,
              }}
            >
              <Tag color={statusTagColor(detailRun.status)}>
                {TASK_STATUS_LABELS[detailRun.status]}
              </Tag>
              <Tag color="geekblue">主品牌：{detailRun.brandName}</Tag>
              <Tag>监测档案：{detailRun.profileName}</Tag>
              <Tag>
                进度：{detailRun.doneCount}/{detailRun.totalChecks}
              </Tag>
              <Tag>
                计费：预冻 {detailRun.frozenPoints ?? detailRun.totalChecks * detailRun.unitPrice}{' '}
                点 / 已结 {detailRun.settledPoints ?? 0} 点
              </Tag>
            </div>

            {/* 4 Core Summary Cards */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))',
                gap: 10,
                marginBottom: 14,
              }}
            >
              <div className="gm-right-card">
                <div className="label">总提及率（Visibility）</div>
                <div className="value">{detailRun.metrics.visibilityPct.toFixed(1)}%</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                  提及 {detailRun.metrics.mentionedChecks} / 有效{' '}
                  {detailRun.metrics.completedChecks} 次
                </div>
              </div>
              <div className="gm-right-card">
                <div className="label">声量占比（SoV）</div>
                <div className="value">
                  {detailRun.metrics.shareOfVoice.brandSharePct.toFixed(1)}%
                </div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                  本品牌 {detailRun.metrics.shareOfVoice.brandMentions} / 总提及{' '}
                  {detailRun.metrics.shareOfVoice.totalMentions}
                </div>
              </div>
              <div className="gm-right-card">
                <div className="label">平均推荐顺位</div>
                <div className="value">
                  {detailRun.metrics.avgPosition !== null
                    ? `#${detailRun.metrics.avgPosition.toFixed(1)}`
                    : '—'}
                </div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                  {detailRun.metrics.avgPosition !== null
                    ? '数字越小推荐越靠前'
                    : '暂无品牌命中顺位'}
                </div>
              </div>
              <div className="gm-right-card">
                <div className="label">自有域名引用率</div>
                <div className="value">{detailRun.metrics.ownedCitationRatePct.toFixed(1)}%</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                  自有 {detailRun.metrics.ownedCitations} / 总引用{' '}
                  {detailRun.metrics.totalCitations}
                </div>
              </div>
            </div>

            {/* Drawer Filter Bar */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 8,
                padding: 10,
                marginBottom: 12,
                borderRadius: 8,
                border: '1px solid #e6eaf0',
                background: '#f8fafc',
              }}
            >
              <select
                aria-label="筛选明细引擎"
                style={{ ...COMPACT_SELECT_STYLE, width: 150 }}
                value={obsEngineFilter}
                onChange={(e) => setObsEngineFilter(e.target.value)}
              >
                <option value="">全部引擎</option>
                {detailRun.engines.map((eng) => (
                  <option key={eng} value={eng}>
                    {VISIBILITY_ENGINE_LABELS[eng] ?? eng}
                  </option>
                ))}
              </select>

              <select
                aria-label="筛选提及状态"
                style={{ ...COMPACT_SELECT_STYLE, width: 140 }}
                value={obsMentionFilter}
                onChange={(e) =>
                  setObsMentionFilter(
                    e.target.value === 'mentioned' || e.target.value === 'unmentioned'
                      ? e.target.value
                      : 'all',
                  )
                }
              >
                <option value="all">全部提及状态</option>
                <option value="mentioned">已提及本品牌</option>
                <option value="unmentioned">未提及本品牌</option>
              </select>

              <select
                aria-label="筛选情感倾向"
                style={{ ...COMPACT_SELECT_STYLE, width: 140 }}
                value={obsSentimentFilter}
                onChange={(e) => setObsSentimentFilter(e.target.value)}
              >
                <option value="">全部情感倾向</option>
                {VISIBILITY_SENTIMENTS.map((s) => (
                  <option key={s} value={s}>
                    {VISIBILITY_SENTIMENT_LABELS[s]}
                  </option>
                ))}
              </select>

              <Button
                size="small"
                aria-label="重置明细筛选"
                onClick={() => {
                  setObsEngineFilter('');
                  setObsMentionFilter('all');
                  setObsSentimentFilter('');
                }}
              >
                重置
              </Button>

              <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 'auto' }}>
                当前展示 {filteredObservations.length} / {detailRun.observations.length} 条观测
              </Typography.Text>
            </div>

            {/* Observations List */}
            {filteredObservations.length === 0 ? (
              <Alert type="info" showIcon message="当前筛选条件下暂无匹配的诊断观测记录" />
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {filteredObservations.map((obs) => {
                  const answerExpanded = Boolean(expandedAnswerIds[obs.id]);
                  const citationsExpanded = Boolean(expandedCitationIds[obs.id]);
                  const mentionedCompetitors = obs.competitorHits.filter((c) => c.mentioned);

                  return (
                    <div
                      key={obs.id}
                      data-testid={`observation-card-${obs.id}`}
                      style={{
                        padding: 14,
                        borderRadius: 10,
                        border: '1px solid #e6eaf0',
                        background: '#ffffff',
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          marginBottom: 8,
                        }}
                      >
                        <Typography.Text strong style={{ fontSize: 15 }}>
                          {obs.promptText}
                        </Typography.Text>
                        <Space size={[4, 4]} wrap>
                          <Tag color="blue">{engineLabelOf(obs.engine)}</Tag>
                          <Tag color={itemStatusTagColor(obs.status)}>
                            {ITEM_STATUS_LABELS[obs.status]}
                          </Tag>
                          {obs.status === 'SUCCESS' ? (
                            obs.brandMentioned ? (
                              <Tag color="success">已提及品牌</Tag>
                            ) : (
                              <Tag>未提及品牌</Tag>
                            )
                          ) : null}
                          {obs.brandPosition !== null ? (
                            <Tag color="geekblue">顺位 #{obs.brandPosition}</Tag>
                          ) : null}
                          {obs.brandSentiment && isVisibilitySentiment(obs.brandSentiment) ? (
                            <span
                              style={{
                                ...sentimentBadgeStyle(obs.brandSentiment),
                                display: 'inline-block',
                                padding: '1px 8px',
                                borderRadius: 6,
                                fontSize: 12,
                                lineHeight: '18px',
                              }}
                            >
                              情感：{VISIBILITY_SENTIMENT_LABELS[obs.brandSentiment]}
                            </span>
                          ) : null}
                        </Space>
                      </div>

                      {obs.error ? (
                        <Alert
                          type="error"
                          showIcon
                          message={obs.error}
                          style={{ marginBottom: 8 }}
                        />
                      ) : null}

                      {/* Brand Evidence Passage */}
                      {obs.brandPassage ? (
                        <div
                          style={{
                            padding: '8px 12px',
                            marginBottom: 8,
                            borderLeft: '3px solid #0d9488',
                            borderRadius: '0 6px 6px 0',
                            background: '#f0fdfa',
                            fontSize: 13,
                            color: '#134e4a',
                            wordBreak: 'break-word',
                          }}
                        >
                          <strong style={{ marginInlineEnd: 6 }}>命中证据片段：</strong>
                          {obs.brandPassage}
                        </div>
                      ) : null}

                      {/* Competitor Hits */}
                      {mentionedCompetitors.length > 0 ? (
                        <div style={{ marginBottom: 8, fontSize: 13 }}>
                          <Typography.Text type="secondary">同题命中竞品：</Typography.Text>
                          <Space size={[4, 4]} wrap style={{ marginInlineStart: 4 }}>
                            {mentionedCompetitors.map((comp) => (
                              <Tag key={comp.name} color="orange" style={{ marginInlineEnd: 0 }}>
                                {comp.name}
                                {comp.position !== null ? ` #${comp.position}` : ''}
                              </Tag>
                            ))}
                          </Space>
                        </div>
                      ) : null}

                      {/* Query Fan-Out */}
                      {obs.fanOutQueries.length > 0 ? (
                        <div style={{ marginBottom: 8, fontSize: 13 }}>
                          <Typography.Text type="secondary">搜索拆解词：</Typography.Text>
                          <Space size={[4, 4]} wrap style={{ marginInlineStart: 4 }}>
                            {obs.fanOutQueries.map((fq) => (
                              <Tag key={fq} color="purple" style={{ marginInlineEnd: 0 }}>
                                {fq}
                              </Tag>
                            ))}
                          </Space>
                        </div>
                      ) : null}

                      {/* Citations */}
                      {obs.citations.length > 0 ? (
                        <div style={{ marginBottom: 8 }}>
                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
                            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                              引用信源（{obs.citations.length}）：
                            </Typography.Text>
                            {obs.citations.map((cite) => (
                              <Tag
                                key={cite.id}
                                color={citationSourceBadgeColor(cite.sourceKind)}
                                style={{ marginInlineEnd: 0 }}
                              >
                                [{CITATION_SOURCE_LABELS[cite.sourceKind]}] {cite.domain}
                              </Tag>
                            ))}
                            <Button
                              type="link"
                              size="small"
                              aria-label={
                                citationsExpanded
                                  ? `收起引用链接-${obs.id}`
                                  : `展开引用链接-${obs.id}`
                              }
                              onClick={() =>
                                setExpandedCitationIds((curr) => ({
                                  ...curr,
                                  [obs.id]: !citationsExpanded,
                                }))
                              }
                            >
                              {citationsExpanded ? '收起引用详情' : '展开引用详情'}
                            </Button>
                          </div>

                          {citationsExpanded ? (
                            <div
                              style={{
                                marginTop: 6,
                                padding: 10,
                                borderRadius: 6,
                                background: '#f8fafc',
                                border: '1px solid #edf2f7',
                                display: 'grid',
                                gap: 6,
                              }}
                            >
                              {obs.citations.map((cite) => (
                                <div key={cite.id} style={{ fontSize: 12, wordBreak: 'break-all' }}>
                                  <Tag
                                    color={citationSourceBadgeColor(cite.sourceKind)}
                                    style={{ marginInlineEnd: 6 }}
                                  >
                                    #{cite.position} {CITATION_SOURCE_LABELS[cite.sourceKind]}
                                  </Tag>
                                  {cite.title ? (
                                    <strong style={{ marginInlineEnd: 6 }}>{cite.title}</strong>
                                  ) : null}
                                  <span style={{ color: '#475569' }}>{cite.url}</span>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {/* Collapsible Raw AI Answer */}
                      {obs.answerText ? (
                        <div>
                          <Button
                            size="small"
                            aria-label={
                              answerExpanded ? `收起原始回答-${obs.id}` : `展开原始回答-${obs.id}`
                            }
                            onClick={() =>
                              setExpandedAnswerIds((curr) => ({
                                ...curr,
                                [obs.id]: !answerExpanded,
                              }))
                            }
                          >
                            {answerExpanded ? '收起原始 AI 回答全文' : '展开原始 AI 回答全文'}
                          </Button>
                          {answerExpanded ? (
                            <pre
                              data-testid={`raw-answer-${obs.id}`}
                              style={{
                                marginTop: 8,
                                marginBottom: 0,
                                padding: 12,
                                borderRadius: 8,
                                background: '#f8fafc',
                                border: '1px solid #e6eaf0',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                fontSize: 13,
                                lineHeight: 1.65,
                                color: '#1e293b',
                                fontFamily: 'inherit',
                              }}
                            >
                              {obs.answerText}
                            </pre>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </Drawer>

      {/* ===================== Confirm Modals ===================== */}
      <Modal
        open={cancelTarget !== null}
        title="确认终止可见度监测任务"
        okText="确认终止并退还未用点数"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: controlLoading }}
        onOk={() => void handleConfirmCancelRun()}
        onCancel={() => {
          if (!controlLoading) setCancelTarget(null);
        }}
      >
        <p>
          确定终止监测任务「{cancelTarget?.name}
          」吗？尚未执行的检测项将标记为跳过，对应预冻点数将自动退回账户。
        </p>
      </Modal>

      <Modal
        open={deleteRunIds !== null && deleteRunIds.length > 0}
        title="确认删除监测任务记录"
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: controlLoading }}
        onOk={() => void handleConfirmDeleteRuns()}
        onCancel={() => {
          if (!controlLoading) setDeleteRunIds(null);
        }}
      >
        <p>确定删除已选中的 {deleteRunIds?.length ?? 0} 条已结束监测任务记录吗？此操作不可恢复。</p>
      </Modal>

      <Modal
        open={deleteProfileTarget !== null}
        title="确认删除品牌与竞品档案"
        okText="确认删除档案"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: controlLoading }}
        onOk={() => void handleConfirmDeleteProfile()}
        onCancel={() => {
          if (!controlLoading) setDeleteProfileTarget(null);
        }}
      >
        <p>
          确定删除监测档案「{deleteProfileTarget?.name}
          」吗？关联的历史监测任务与观测记录将一并清理。
        </p>
      </Modal>
    </section>
  );
}
