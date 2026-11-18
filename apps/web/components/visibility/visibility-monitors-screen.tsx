'use client';

import {
  DOMESTIC_VISIBILITY_ENGINE_KEYS,
  TASK_STATUSES,
  VISIBILITY_BRAND_NAME_MAX,
  VISIBILITY_DEFAULT_UNIT_POINTS,
  VISIBILITY_ENGINES,
  VISIBILITY_ENGINE_LABELS,
  VISIBILITY_MAX_COMPETITORS,
  VISIBILITY_PROFILE_NAME_MAX,
  VISIBILITY_RUN_NAME_MAX,
  VISIBILITY_TASK_STATUS_LABELS,
  formatShanghaiDateTime,
  isTaskStatus,
  normalizeVisibilityDomain,
  quoteVisibilityRunPoints,
  toXlsx,
  type CitationSourceKind,
  type CrudExportFormat,
  type KeywordRecord,
  type QuestionRecord,
  type TaskStatusName,
  type VisibilityCompetitor,
  type VisibilityEngineKey,
  type VisibilityPrefillSources,
  type VisibilityProfileRecord,
  type VisibilityRunDetailRecord,
  type VisibilityRunListQuery,
  type VisibilityRunRecord,
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
  Tooltip,
  Typography,
} from 'antd';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GM, formatPct } from '../../lib/design-tokens';
import { CrudModal } from '../crud/crud-modal';
import { CrudTable, type CrudColumn } from '../crud/crud-table';
import {
  EngineChipList,
  SignalEmpty,
  SignalPill,
  SignalSkeleton,
  StatusPill,
  TruncText,
} from '../geo/primitives';
import { RunWorkspace } from '../geo/run-workspace';
import type { PriceItem } from '../../lib/samples';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';
import {
  sanitizeEntityTitleSegment,
  triggerBlobDownload,
  useSyncTabTitle,
} from '../../lib/ux-foundation';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
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
  border: '1px solid var(--gm-line-2)',
  backgroundColor: 'var(--gm-bg-elevated)',
  fontSize: 13,
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
  return formatShanghaiDateTime(iso);
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

function defaultDownloadHandler(file: VisibilityExportFile): void {
  triggerBlobDownload(file);
}

function escapeCsvCell(val: string): string {
  if (/[",\r\n]/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function buildRunsExportTable(rows: VisibilityRunRecord[]): {
  headers: string[];
  rows: string[][];
} {
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
  const tableRows = rows.map((r) => [
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
    VISIBILITY_TASK_STATUS_LABELS[r.status],
    formatTime(r.createdAt),
  ]);
  return { headers, rows: tableRows };
}

function buildRunsExportBytes(rows: VisibilityRunRecord[]): Uint8Array {
  const table = buildRunsExportTable(rows);
  const lines = [
    table.headers.join(','),
    ...table.rows.map((cells) => cells.map(escapeCsvCell).join(',')),
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

function validateProfileName(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return '请填写档案名称';
  if (trimmed.length > VISIBILITY_PROFILE_NAME_MAX) {
    return `档案名称不能超过 ${VISIBILITY_PROFILE_NAME_MAX} 个字符`;
  }
  return undefined;
}

function validateProfileBrandName(draft: ProfileDraft): string | undefined {
  const trimmed = draft.brandName.trim();
  if (
    !trimmed &&
    !(draft.mode === 'create' && (draft.importFromKeywordId || draft.importFromKbId))
  ) {
    return '请填写主品牌名称';
  }
  if (trimmed.length > VISIBILITY_BRAND_NAME_MAX) {
    return `主品牌名称不能超过 ${VISIBILITY_BRAND_NAME_MAX} 个字符`;
  }
  return undefined;
}

export function VisibilityMonitorsScreen({
  title,
  tabId,
  href,
  active = true,
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
  active?: boolean;
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
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const profileFilterSelectRef = useRef<HTMLSelectElement | null>(null);

  const [runs, setRuns] = useState<VisibilityRunRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reloadTick, setReloadTick] = useState(0);

  const sectionRef = useRef<HTMLElement | null>(null);

  const [banner, setBanner] = useState<{
    type: 'success' | 'error' | 'info' | 'warning';
    text: string;
  } | null>(null);

  // Profile Create/Edit Modal
  const [profileModal, setProfileModal] = useState<ProfileModalState | null>(null);
  const [profileModalError, setProfileModalError] = useState<string | null>(null);
  const [profileFieldErrors, setProfileFieldErrors] = useState<{
    name?: string;
    brandName?: string;
  }>({});
  const [profileTouched, setProfileTouched] = useState<{
    name?: boolean;
    brandName?: boolean;
  }>({});
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
  const [blockedDeleteRuns, setBlockedDeleteRuns] = useState<VisibilityRunRecord[] | null>(null);
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
      setProfilesLoaded(true);
      if (profileRes.prefillSources) {
        setPrefillSources(profileRes.prefillSources);
      }
      setKeywords(kwList);
      setPrices(priceList);
    } catch (err) {
      setProfilesLoaded(true);
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '加载监测档案失败',
      });
    }
  }, [client, featureEnabled]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  useTabFreshness({
    active,
    domains: ['keywords', 'knowledge', 'visibility-profiles', 'visibility-runs', 'points'],
    onRefresh: () => {
      void loadMeta();
      setReloadTick((n) => n + 1);
    },
  });

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

  // Auto-dismiss transient success/info banners and clear them when switching Shell tabs (#192)
  useEffect(() => {
    if (!banner || (banner.type !== 'success' && banner.type !== 'info')) return undefined;
    const timer = window.setTimeout(() => {
      setBanner((curr) => (curr === banner ? null : curr));
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  useEffect(() => {
    const pageEl = sectionRef.current?.closest('.gm-page');
    if (!pageEl || typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => {
      if (pageEl.hasAttribute('hidden')) {
        setBanner((curr) =>
          curr && (curr.type === 'success' || curr.type === 'info') ? null : curr,
        );
      }
    });
    observer.observe(pageEl, { attributes: true, attributeFilter: ['hidden'] });
    return () => observer.disconnect();
  }, []);

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
    setProfileFieldErrors({});
    setProfileTouched({});
    setProfileModal({
      initial,
      draft: initial,
      minimized: false,
      maximized: false,
    });
    void loadMeta();
  }

  function openEditProfileModal(profile: VisibilityProfileRecord) {
    if (readOnly) return;
    const initial = buildEditProfileDraft(profile, profile.id === effectiveDefaultProfileId);
    setProfileModalError(null);
    setProfileFieldErrors({});
    setProfileTouched({});
    setProfileModal({
      initial,
      draft: initial,
      minimized: false,
      maximized: false,
    });
    void loadMeta();
  }

  function applyKeywordPrefill(keywordId: string) {
    setProfileModal((curr) => {
      if (!curr) return curr;
      if (!keywordId) {
        const nextDraft = { ...curr.draft, importFromKeywordId: '' };
        setProfileFieldErrors((prev) => ({
          ...prev,
          ...(profileTouched.brandName ? { brandName: validateProfileBrandName(nextDraft) } : {}),
        }));
        return {
          ...curr,
          draft: nextDraft,
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
      const nextDraft: ProfileDraft = {
        ...curr.draft,
        importFromKeywordId: keywordId,
        name: curr.draft.name.trim() || `${primaryBrand}品牌监测档案`,
        brandName: primaryBrand,
        brandAliasesText: mergedAliases.join(', '),
      };
      setProfileFieldErrors({
        name: validateProfileName(nextDraft.name),
        brandName: validateProfileBrandName(nextDraft),
      });
      return {
        ...curr,
        draft: nextDraft,
      };
    });
  }

  function applyKbPrefill(kbId: string) {
    setProfileModal((curr) => {
      if (!curr) return curr;
      if (!kbId) {
        const nextDraft = { ...curr.draft, importFromKbId: '' };
        setProfileFieldErrors((prev) => ({
          ...prev,
          ...(profileTouched.brandName ? { brandName: validateProfileBrandName(nextDraft) } : {}),
        }));
        return {
          ...curr,
          draft: nextDraft,
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
      const nextDraft: ProfileDraft = {
        ...curr.draft,
        importFromKbId: kbId,
        name: curr.draft.name.trim() || `${primaryBrand || kb.name}监测档案`,
        brandName: primaryBrand,
        brandAliasesText: mergedAliases.join(', '),
      };
      setProfileFieldErrors({
        name: validateProfileName(nextDraft.name),
        brandName: validateProfileBrandName(nextDraft),
      });
      return {
        ...curr,
        draft: nextDraft,
      };
    });
  }

  async function handleSaveProfile() {
    if (!profileModal || readOnly) return;
    const { draft } = profileModal;
    setProfileModalError(null);
    setProfileTouched({ name: true, brandName: true });

    const nameError = validateProfileName(draft.name);
    const brandError = validateProfileBrandName(draft);
    if (nameError || brandError) {
      setProfileFieldErrors({
        ...(nameError ? { name: nameError } : {}),
        ...(brandError ? { brandName: brandError } : {}),
      });
      if (nameError) {
        setProfileModalError(nameError);
        return;
      }
      if (brandError) {
        setProfileModalError(
          draft.mode === 'create' &&
            (prefillSources.keywords.length > 0 || prefillSources.knowledgeBases.length > 0)
            ? '请填写主品牌名称，或选择关键词/企业知识库快捷导入'
            : brandError,
        );
        return;
      }
    }
    setProfileFieldErrors({});

    const name = draft.name.trim();
    const brandName = draft.brandName.trim();

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
    const previousDefaultId = effectiveDefaultProfileId;
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
        if (draft.isDefault) {
          persistDefaultProfile(saved.id);
        } else if (defaultProfileId === saved.id && profiles.length > 1) {
          const fallback = profiles.find((item) => item.id !== saved.id);
          if (fallback) persistDefaultProfile(fallback.id);
        }
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
        if (draft.isDefault || profiles.length === 0) {
          persistDefaultProfile(saved.id);
        } else if (previousDefaultId && previousDefaultId !== defaultProfileId) {
          // Lock the existing default profile in storage so prepending the new profile never steals default status (#192)
          persistDefaultProfile(previousDefaultId);
        }
      }

      invalidateFreshness('visibility-profiles');
      setProfileModal(null);
      setProfileFieldErrors({});
      setProfileTouched({});
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
      invalidateFreshness('visibility-profiles');
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
    void loadMeta();
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
      invalidateFreshness('visibility-runs', 'points');
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
      invalidateFreshness('visibility-runs', 'points');
      void loadMeta();
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : '删除监测任务失败' });
      setDeleteRunIds(null);
    } finally {
      setControlLoading(false);
    }
  }

  function handleExportRuns(format: CrudExportFormat) {
    if (format === 'xlsx') {
      const table = buildRunsExportTable(runs);
      const xlsxBytes = toXlsx(table.headers, table.rows);
      downloadFile({
        filename: 'geomix-visibility-runs.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body: xlsxBytes,
      });
      return;
    }
    const bytes = buildRunsExportBytes(runs);
    downloadFile({
      filename: 'geomix-visibility-runs.csv',
      mime: 'text/csv;charset=utf-8',
      body: bytes,
    });
  }

  function openOverviewForProfile(profileId?: string) {
    setDrawerOpen(false);
    const targetHref = profileId
      ? `/visibility/overview?profileId=${encodeURIComponent(profileId)}`
      : '/visibility/overview';
    onDispatch?.({ type: 'open', href: targetHref, sourceId: tabId });
  }

  const baseTitle = useMemo(() => {
    const sepIdx = title.indexOf(' · ');
    return sepIdx > 0 ? title.slice(0, sepIdx) : title || 'AI可见度诊断';
  }, [title]);

  const resolvedTitle = useMemo(() => {
    const activeProfileId = query.profileId || initialUrlParams.profileId;
    const matchedProfile = activeProfileId
      ? profiles.find((p) => p.id === activeProfileId)
      : undefined;
    const matchedRunName = initialUrlParams.runId
      ? detailRun?.id === initialUrlParams.runId
        ? detailRun.name
        : runs.find((r) => r.id === initialUrlParams.runId)?.name
      : undefined;
    const parts: string[] = [];
    if (activeProfileId) {
      if (matchedProfile) {
        parts.push(matchedProfile.name);
      } else {
        const safeSegment = sanitizeEntityTitleSegment(activeProfileId, '当前监测档案');
        parts.push(safeSegment === '当前监测档案' ? '当前监测档案' : `档案 ${safeSegment}`);
      }
    }
    if (initialUrlParams.runId) {
      if (matchedRunName) {
        parts.push(matchedRunName);
      } else {
        const safeRun = sanitizeEntityTitleSegment(initialUrlParams.runId, '当前诊断任务');
        parts.push(safeRun === '当前诊断任务' ? '当前诊断任务' : `任务 ${safeRun}`);
      }
    }
    if (parts.length > 0) {
      return `${baseTitle} · ${parts.join(' · ')}`;
    }
    return baseTitle;
  }, [
    baseTitle,
    detailRun,
    initialUrlParams.profileId,
    initialUrlParams.runId,
    profiles,
    query.profileId,
    runs,
  ]);

  useSyncTabTitle(tabId, title, resolvedTitle, onDispatch);

  useEffect(() => {
    const el = profileFilterSelectRef.current;
    const desired = query.profileId ?? '';
    if (el && el.value !== desired) {
      el.value = desired;
    }
  }, [profiles, profilesLoaded, query.profileId]);

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
      width: 220,
      hideable: false,
      render: (row) => (
        <button
          type="button"
          className="gm-monitors-name-btn"
          onClick={() => void openDetailDrawer(row.id)}
        >
          <TruncText text={row.name} lines={1} />
        </button>
      ),
    },
    {
      key: 'profile',
      title: '监测档案 / 主品牌',
      width: 200,
      render: (row) => (
        <div
          data-testid={`run-profile-cell-${row.id}`}
          style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 168 }}
        >
          <span className="gm-clamp-1" style={{ fontSize: 13, color: 'var(--gm-fg-1)' }}>
            {row.profileName}
          </span>
          <span className="gm-clamp-1" style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
            {row.brandName}
          </span>
        </div>
      ),
    },
    {
      key: 'keywordMain',
      title: '关联主词',
      width: 140,
      render: (row) => (
        <span
          data-testid={`run-keyword-cell-${row.id}`}
          className="gm-clamp-1"
          style={{
            display: 'inline-block',
            minWidth: 112,
            color: row.keywordMain ? 'var(--gm-fg-2)' : 'var(--gm-fg-3)',
          }}
        >
          {row.keywordMain ?? '—'}
        </span>
      ),
    },
    {
      key: 'engines',
      title: '监测引擎',
      width: 210,
      render: (row) => <EngineChipList engines={row.engines} max={3} />,
    },
    {
      key: 'progress',
      title: '检测进度',
      width: 140,
      render: (row) => {
        const totalChecks = row.totalChecks;
        const donePct =
          totalChecks > 0 ? Math.min(100, Math.max(0, (row.doneCount / totalChecks) * 100)) : 0;
        const failPct =
          totalChecks > 0
            ? Math.min(100 - donePct, Math.max(0, (row.failCount / totalChecks) * 100))
            : 0;
        const skipPct =
          totalChecks > 0
            ? Math.min(
                100 - donePct - failPct,
                Math.max(0, ((row.skipCount ?? 0) / totalChecks) * 100),
              )
            : 0;
        return (
          <div style={{ width: 140 }}>
            <span className="gm-num" style={{ fontSize: 12, color: 'var(--gm-fg-1)' }}>
              {row.doneCount}/{totalChecks}
            </span>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 4,
                borderRadius: 2,
                overflow: 'hidden',
                background: 'rgba(255,255,255,0.06)',
                gap: 1,
                marginTop: 6,
              }}
            >
              {totalChecks > 0 ? (
                <>
                  {donePct > 0 ? (
                    <div
                      style={{
                        width: `${donePct}%`,
                        height: '100%',
                        background: GM.sig.cited,
                      }}
                    />
                  ) : null}
                  {row.status === 'RUNNING' ? <div className="gm-progress-pulse" /> : null}
                  {failPct > 0 ? (
                    <div
                      style={{
                        width: `${failPct}%`,
                        height: '100%',
                        background: GM.status.danger,
                      }}
                    />
                  ) : null}
                  {skipPct > 0 ? (
                    <div
                      style={{
                        width: `${skipPct}%`,
                        height: '100%',
                        background: GM.fg.f4,
                      }}
                    />
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        );
      },
    },
    {
      key: 'visibilityPct',
      title: '品牌提及率',
      width: 130,
      render: (row) => {
        const pct = row.visibilityPct;
        const barWidth =
          pct === null || pct === undefined || !Number.isFinite(pct)
            ? 0
            : Math.min(100, Math.max(0, pct));
        return (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 8,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 40,
                height: 4,
                borderRadius: 2,
                background: 'rgba(255,255,255,0.06)',
                overflow: 'hidden',
                flex: 'none',
              }}
            >
              <span
                style={{
                  display: 'block',
                  width: `${barWidth}%`,
                  height: '100%',
                  background: GM.sig.cited,
                }}
              />
            </span>
            <span
              className="gm-num"
              style={{
                color: pct === null || pct === undefined ? 'var(--gm-fg-3)' : 'var(--gm-fg-1)',
              }}
            >
              {formatPct(pct)}
            </span>
          </div>
        );
      },
    },
    {
      key: 'points',
      title: '预冻 / 结算点数',
      width: 140,
      render: (row) => {
        const frozen = row.frozenPoints ?? 0;
        const settled = row.settledPoints ?? 0;
        const released = row.releasedPoints ?? 0;
        return (
          <Tooltip title={`已退回 ${released} 点`}>
            <div
              className="gm-num"
              style={{ textAlign: 'right', fontSize: 13, whiteSpace: 'nowrap', minWidth: 112 }}
            >
              <div style={{ color: 'var(--gm-fg-1)' }}>预冻 {frozen} 点</div>
              <div style={{ color: 'var(--gm-fg-3)', fontSize: 12 }}>已结 {settled} 点</div>
            </div>
          </Tooltip>
        );
      },
    },
    {
      key: 'status',
      title: '状态',
      width: 116,
      render: (row) => (
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
        >
          <StatusPill kind="task" status={row.status} />
          {row.lastError ? (
            <Tooltip title={row.lastError} styles={{ root: { maxWidth: 360 } }}>
              <span
                role="img"
                aria-label="任务异常详情"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: 'rgba(240,96,93,0.16)',
                  color: 'var(--gm-danger)',
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: 1,
                  cursor: 'help',
                  flex: 'none',
                }}
              >
                !
              </span>
            </Tooltip>
          ) : null}
        </span>
      ),
    },
    {
      key: 'createdAt',
      title: '创建时间',
      width: 156,
      render: (row) => (
        <span
          className="gm-num"
          style={{
            display: 'inline-block',
            fontSize: 12,
            color: 'var(--gm-fg-3)',
            whiteSpace: 'nowrap',
          }}
        >
          {formatTime(row.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      width: 240,
      hideable: false,
      render: (row) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 210 }}>
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
        </div>
      ),
    },
  ];

  if (!featureEnabled) {
    return (
      <section>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          {resolvedTitle}
        </Typography.Title>
        <Alert
          type="info"
          showIcon
          message="当前站点尚未开启 AI 可见度诊断功能，如需启用请联系管理员开启 FEATURE_VISIBILITY。"
        />
      </section>
    );
  }

  const clearRunFilters = () => {
    setKeywordDraft('');
    setSelectedIds([]);
    setQuery((curr) => ({
      ...curr,
      page: 1,
      profileId: undefined,
      status: undefined,
      keyword: undefined,
    }));
    if (tabId && href && href.includes('?')) {
      onDispatch?.({ type: 'navigate', id: tabId, href: '/visibility/monitors' });
    }
  };

  const submitRunSearch = () => {
    setSelectedIds([]);
    setQuery((curr) => ({
      ...curr,
      page: 1,
      keyword: keywordDraft.trim() || undefined,
    }));
  };

  return (
    <section ref={sectionRef} style={{ minWidth: 0 }}>
      {/* Top Header */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <Typography.Title
            level={3}
            style={{ margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600 }}
          >
            {resolvedTitle}
          </Typography.Title>
          <div style={{ fontSize: 12, lineHeight: '18px', color: 'var(--gm-fg-3)', marginTop: 4 }}>
            跨国内 8
            大主流模型与海外搜索引擎，批量诊断企业品牌提及率、推荐顺位、情感倾向与权威引用信源
          </div>
        </div>
        <Space wrap>
          <SignalPill tone="warning">
            AI可见性监测 · <span className="gm-num">{unitPoints}</span> 点数/次
          </SignalPill>
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
        onChange={(key) => {
          setActiveTab(key === 'profiles' ? 'profiles' : 'runs');
          setBanner((curr) =>
            curr && (curr.type === 'success' || curr.type === 'info') ? null : curr,
          );
        }}
        items={[
          {
            key: 'runs',
            label: `监测任务（${total}）`,
            children: (
              <div style={{ minWidth: 0 }}>
                {/* Unified Filter Bar */}
                <div className="gm-filterbar">
                  <select
                    ref={profileFilterSelectRef}
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
                    {query.profileId && !profiles.some((p) => p.id === query.profileId) ? (
                      <option value={query.profileId}>
                        {!profilesLoaded ? '正在加载监测档案…' : '当前监测档案'}
                      </option>
                    ) : null}
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
                        {VISIBILITY_TASK_STATUS_LABELS[st]}
                      </option>
                    ))}
                  </select>

                  <Input
                    aria-label="搜索监测任务"
                    placeholder="搜索任务名、品牌或主词"
                    value={keywordDraft}
                    style={{ width: 220, maxWidth: '100%' }}
                    onChange={(e) => setKeywordDraft(e.target.value)}
                    onPressEnter={submitRunSearch}
                  />

                  <Button type="primary" aria-label="查询监测任务" onClick={submitRunSearch}>
                    查询
                  </Button>

                  <Button aria-label="重置任务筛选" onClick={clearRunFilters}>
                    重置筛选
                  </Button>

                  {hasActiveRun ? (
                    <span style={{ marginInlineStart: 'auto' }}>
                      <SignalPill tone="info">运行中每 5 秒自动同步进度</SignalPill>
                    </span>
                  ) : null}
                </div>

                <div className="gm-monitors-table-wrap">
                  <CrudTable
                    rows={runs}
                    columns={columns}
                    total={total}
                    page={query.page}
                    pageSize={query.pageSize}
                    loading={loading}
                    selectedIds={selectedIds}
                    searchOpen={false}
                    searchPlaceholder="搜索任务名、品牌或主词"
                    writeDisabled={readOnly}
                    showCreate={false}
                    showDensityToggle={false}
                    showSearch={false}
                    scroll={{ x: 'max-content' }}
                    emptyText={
                      (loading ? (
                        <SignalSkeleton variant="row" rows={5} />
                      ) : profiles.length === 0 ? (
                        <SignalEmpty
                          title="先建立品牌档案"
                          description="尚未创建品牌监测档案，请先点击「新建品牌档案」配置主品牌与竞品后再发起监测"
                          actionText={readOnly ? undefined : '新建品牌档案'}
                          onAction={() => openCreateProfileModal()}
                        />
                      ) : query.profileId || query.status || query.keyword ? (
                        <SignalEmpty
                          title="没有符合筛选条件的任务"
                          actionText="重置筛选"
                          onAction={clearRunFilters}
                        />
                      ) : (
                        <SignalEmpty
                          title="还没有监测任务"
                          description="选择档案、问题和引擎，系统会逐一向各 AI 引擎提问并记录是否提及你的品牌"
                          actionText={readOnly ? undefined : '新建监测任务'}
                          onAction={() => openCreateRunModal()}
                        />
                      )) as unknown as string
                    }
                    search={{
                      keyword: query.keyword ?? '',
                      enabled: undefined,
                      sort: 'createdAt',
                      order: 'desc',
                    }}
                    onSearchOpenChange={() => undefined}
                    onSearch={() => undefined}
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
                    onDelete={
                      readOnly
                        ? undefined
                        : () => {
                            const selectedRows = runs.filter((r) => selectedIds.includes(r.id));
                            const activeRows = selectedRows.filter((r) =>
                              isControllableRunStatus(r.status),
                            );
                            if (activeRows.length > 0) {
                              setBlockedDeleteRuns(activeRows);
                              return;
                            }
                            setDeleteRunIds(selectedIds);
                          }
                    }
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
                  <div className="gm-panel">
                    <SignalEmpty
                      title="暂无品牌与竞品监测档案"
                      description="您可以直接录入主品牌与官网域名，或从已有「关键词 / 企业知识库」一键预填品牌词。"
                      actionText={readOnly ? undefined : '立即创建首个品牌档案'}
                      onAction={() => openCreateProfileModal()}
                    />
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))',
                      gap: 12,
                    }}
                  >
                    {profiles.map((prof) => {
                      const isDefault = prof.id === effectiveDefaultProfileId;
                      const shownCompetitors = prof.competitors.slice(0, 3);
                      const hiddenCompetitors = prof.competitors.slice(3);
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
                            border: isDefault
                              ? '1px solid var(--gm-phosphor-a40)'
                              : '1px solid var(--gm-line-1)',
                            borderRadius: 8,
                            background: isDefault
                              ? 'var(--gm-bg-elevated)'
                              : 'var(--gm-bg-surface)',
                            boxShadow: isDefault ? 'var(--gm-glow-active)' : undefined,
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
                              <Typography.Text
                                strong
                                style={{ fontSize: 16, color: 'var(--gm-fg-1)' }}
                              >
                                {prof.name}
                              </Typography.Text>
                              <Space size={4} wrap>
                                {isDefault ? <SignalPill tone="cited">默认档案</SignalPill> : null}
                                <SignalPill tone="neutral">
                                  <span className="gm-num">{prof.runCount ?? 0}</span> 次任务
                                </SignalPill>
                              </Space>
                            </div>

                            <div
                              style={{
                                marginBottom: 8,
                                fontSize: 13,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                              }}
                            >
                              <span style={{ color: 'var(--gm-fg-3)' }}>主品牌：</span>
                              <SignalPill tone="info">{prof.brandName}</SignalPill>
                            </div>

                            <div style={{ marginBottom: 8, fontSize: 13 }}>
                              <span style={{ color: 'var(--gm-fg-3)' }}>品牌别名：</span>
                              {prof.brandAliases.length > 0 ? (
                                <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
                                  {prof.brandAliases.map((alias) => (
                                    <span key={alias} className="gm-engine-chip">
                                      {alias}
                                    </span>
                                  ))}
                                </Space>
                              ) : (
                                <span style={{ color: 'var(--gm-fg-3)' }}>未设置别名</span>
                              )}
                            </div>

                            <div style={{ marginBottom: 8, fontSize: 13 }}>
                              <span style={{ color: 'var(--gm-fg-3)' }}>自有官网域名：</span>
                              {prof.ownedDomains.length > 0 ? (
                                <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
                                  {prof.ownedDomains.map((dom) => (
                                    <span key={dom} className="gm-engine-chip">
                                      <TruncText text={dom} mono middle />
                                    </span>
                                  ))}
                                </Space>
                              ) : (
                                <span style={{ color: 'var(--gm-fg-3)' }}>未配置域名</span>
                              )}
                            </div>

                            <div style={{ fontSize: 13 }}>
                              <span style={{ color: 'var(--gm-fg-3)' }}>
                                监测竞品（{prof.competitors.length}/{VISIBILITY_MAX_COMPETITORS}
                                ）：
                              </span>
                              {prof.competitors.length > 0 ? (
                                <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
                                  {shownCompetitors.map((comp) => (
                                    <SignalPill key={comp.name} tone="competitor">
                                      {comp.name}
                                    </SignalPill>
                                  ))}
                                  {hiddenCompetitors.length > 0 ? (
                                    <Tooltip
                                      title={hiddenCompetitors.map((c) => c.name).join('、')}
                                    >
                                      <span className="gm-engine-more gm-num">
                                        +{hiddenCompetitors.length}
                                      </span>
                                    </Tooltip>
                                  ) : null}
                                </Space>
                              ) : (
                                <span style={{ color: 'var(--gm-fg-3)' }}>未添加竞品</span>
                              )}
                            </div>
                          </div>

                          <div
                            className="gm-profile-card-actions"
                            data-testid={`profile-card-actions-${prof.id}`}
                          >
                            <div className="gm-profile-card-actions-row">
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
                            </div>
                            <div className="gm-profile-card-actions-row">
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
        onRestore={() => {
          setProfileModal((curr) => (curr ? { ...curr, minimized: false } : curr));
          void loadMeta();
        }}
        onMaximize={() =>
          setProfileModal((curr) => (curr ? { ...curr, maximized: !curr.maximized } : curr))
        }
        onClose={() => {
          if (profileSubmitting) return;
          setProfileModal(null);
          setProfileModalError(null);
          setProfileFieldErrors({});
          setProfileTouched({});
        }}
        onReset={() => {
          setProfileModalError(null);
          setProfileFieldErrors({});
          setProfileTouched({});
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
          <div className="gm-profile-modal-body">
            {profileModal.draft.mode === 'create' &&
            (prefillSources.keywords.length > 0 || prefillSources.knowledgeBases.length > 0) ? (
              <div
                style={{
                  padding: 12,
                  marginBottom: 14,
                  borderRadius: 8,
                  border: '1px solid var(--gm-line-2)',
                  background: 'var(--gm-bg-surface)',
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
                      <span style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
                        从训练主词导入品牌词
                      </span>
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
                      <span style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
                        从企业知识库导入品牌词
                      </span>
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

            <div style={{ marginBottom: 12 }}>
              <label style={{ marginBottom: 0 }}>
                <span>
                  <span className="gm-required-mark" style={{ color: 'var(--gm-danger)' }}>
                    *{' '}
                  </span>
                  档案名称
                </span>
                <Input
                  aria-label="档案名称"
                  aria-invalid={Boolean(profileFieldErrors.name) || undefined}
                  status={profileFieldErrors.name ? 'error' : undefined}
                  placeholder="例如：星图办公硬件-便携显示器监测档案"
                  maxLength={VISIBILITY_PROFILE_NAME_MAX}
                  value={profileModal.draft.name}
                  onBlur={(e) => {
                    const msg = validateProfileName(e.target.value);
                    setProfileTouched((curr) => ({ ...curr, name: true }));
                    setProfileFieldErrors((curr) => ({ ...curr, name: msg }));
                  }}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setProfileModal((curr) =>
                      curr ? { ...curr, draft: { ...curr.draft, name: nextVal } } : curr,
                    );
                    if (profileTouched.name || profileFieldErrors.name || profileModalError) {
                      const msg = validateProfileName(nextVal);
                      setProfileFieldErrors((curr) => ({ ...curr, name: msg }));
                      if (!msg && profileModalError === '请填写档案名称') {
                        setProfileModalError(null);
                      }
                    }
                  }}
                />
              </label>
              {profileFieldErrors.name ? (
                <p
                  className="gm-form-error"
                  data-testid="profile-name-error"
                  role="alert"
                  style={{ margin: '4px 0 0', fontSize: 12 }}
                >
                  {profileFieldErrors.name}
                </p>
              ) : null}
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ marginBottom: 0 }}>
                <span>
                  <span className="gm-required-mark" style={{ color: 'var(--gm-danger)' }}>
                    *{' '}
                  </span>
                  主品牌名称
                </span>
                <Input
                  aria-label="主品牌名称"
                  aria-invalid={Boolean(profileFieldErrors.brandName) || undefined}
                  status={profileFieldErrors.brandName ? 'error' : undefined}
                  placeholder="例如：星图显示"
                  maxLength={VISIBILITY_BRAND_NAME_MAX}
                  value={profileModal.draft.brandName}
                  onBlur={() => {
                    setProfileTouched((curr) => ({ ...curr, brandName: true }));
                    setProfileFieldErrors((curr) => ({
                      ...curr,
                      brandName: validateProfileBrandName(profileModal.draft),
                    }));
                  }}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    const nextDraft = { ...profileModal.draft, brandName: nextVal };
                    setProfileModal((curr) => (curr ? { ...curr, draft: nextDraft } : curr));
                    if (
                      profileTouched.brandName ||
                      profileFieldErrors.brandName ||
                      profileModalError
                    ) {
                      const msg = validateProfileBrandName(nextDraft);
                      setProfileFieldErrors((curr) => ({ ...curr, brandName: msg }));
                      if (
                        !msg &&
                        profileModalError &&
                        profileModalError.startsWith('请填写主品牌名称')
                      ) {
                        setProfileModalError(null);
                      }
                    }
                  }}
                />
              </label>
              {profileFieldErrors.brandName ? (
                <p
                  className="gm-form-error"
                  data-testid="profile-brand-error"
                  role="alert"
                  style={{ margin: '4px 0 0', fontSize: 12 }}
                >
                  {profileFieldErrors.brandName}
                </p>
              ) : null}
            </div>

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
                    <span key={tag} className="gm-engine-chip">
                      {tag}
                    </span>
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
                        border: '1px solid var(--gm-line-1)',
                        background: 'var(--gm-bg-surface)',
                      }}
                    >
                      <div className="gm-competitor-grid">
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
                        <Button
                          size="small"
                          type="text"
                          danger
                          aria-label={`移除竞品-${idx + 1}`}
                          style={{
                            width: 32,
                            height: 32,
                            padding: 0,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
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
                          ×
                        </Button>
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
              <span>
                {profileModal.draft.mode === 'create' && profiles.length === 0
                  ? '设为默认监测档案（当前为首个档案，创建后将自动设为默认）'
                  : '设为默认监测档案（进入数据看板与新建监测时默认选中）'}
              </span>
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
        onRestore={() => {
          setRunModal((curr) => (curr ? { ...curr, minimized: false } : curr));
          void loadMeta();
        }}
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
          <div className="gm-run-modal-body">
            <Alert
              type="info"
              showIcon
              className="gm-num"
              style={{ marginBottom: 14 }}
              message={`共 ${runPromptCount} 个问题 × ${runEngineCount} 个引擎 = ${runTotalChecks} 次检测，预计冻结 ${runTotalPoints} 点数（单价 ${unitPoints} 点/次，失败或终止未执行项自动退回）`}
            />

            <label>
              <span>
                <span className="gm-required-mark" style={{ color: 'var(--gm-danger)' }}>
                  *{' '}
                </span>
                选择监测档案
              </span>
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
                  border: '1px solid var(--gm-line-1)',
                  background: 'var(--gm-bg-surface)',
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
                            <span style={{ marginInlineStart: 6 }}>
                              <SignalPill tone="cited">已收录</SignalPill>
                            </span>
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
                style={{ maxHeight: 160, overflow: 'auto' }}
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
                  <span className="gm-required-mark" style={{ color: 'var(--gm-danger)' }}>
                    *{' '}
                  </span>
                  目标 AI 引擎（已选 {runModal.draft.engines.length} 个）
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
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  padding: 12,
                  borderRadius: 8,
                  border: '1px solid var(--gm-line-1)',
                  background: 'var(--gm-bg-surface)',
                }}
              >
                {[
                  {
                    groupLabel: '国内主流引擎',
                    items: VISIBILITY_ENGINES.filter((eng) => eng.domestic),
                  },
                  {
                    groupLabel: '海外搜索引擎',
                    items: VISIBILITY_ENGINES.filter((eng) => !eng.domestic),
                  },
                ].map((group) => (
                  <div key={group.groupLabel}>
                    <div
                      style={{
                        fontSize: 11,
                        lineHeight: '16px',
                        fontWeight: 500,
                        letterSpacing: '0.06em',
                        color: 'var(--gm-fg-3)',
                        marginBottom: 6,
                      }}
                    >
                      {group.groupLabel}
                    </div>
                    <div className="gm-engine-grid">
                      {group.items.map((eng) => {
                        const checked = runModal.draft.engines.includes(eng.key);
                        return (
                          <div
                            key={eng.key}
                            className={
                              checked ? 'gm-engine-card gm-engine-card-checked' : 'gm-engine-card'
                            }
                          >
                            <Checkbox
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
                            </Checkbox>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </CrudModal>

      {/* ===================== Diagnostic Detail Drawer ===================== */}
      <Drawer
        open={drawerOpen}
        title={detailRun ? `可见度诊断明细 · ${detailRun.name}` : '可见度诊断明细'}
        width="min(1200px, 100vw)"
        styles={{ body: { padding: 0, background: 'var(--gm-bg-base)' } }}
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
        <RunWorkspace
          run={detailRun}
          loading={detailLoading}
          profile={profiles.find((p) => p.id === detailRun?.profileId)}
          obsEngineFilter={obsEngineFilter}
          onObsEngineFilterChange={setObsEngineFilter}
          obsMentionFilter={obsMentionFilter}
          onObsMentionFilterChange={setObsMentionFilter}
          obsSentimentFilter={obsSentimentFilter}
          onObsSentimentFilterChange={setObsSentimentFilter}
          filteredObservations={filteredObservations}
          onResetFilters={() => {
            setObsEngineFilter('');
            setObsMentionFilter('all');
            setObsSentimentFilter('');
          }}
        />
      </Drawer>

      {/* ===================== Confirm Modals ===================== */}
      <Modal
        open={cancelTarget !== null}
        title="确认终止可见度监测任务"
        keyboard
        destroyOnHidden
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
        open={blockedDeleteRuns !== null && blockedDeleteRuns.length > 0}
        title="无法删除进行中的监测任务"
        keyboard
        destroyOnHidden
        onCancel={() => setBlockedDeleteRuns(null)}
        footer={
          blockedDeleteRuns && blockedDeleteRuns.length === 1 && selectedIds.length === 1
            ? [
                <Button key="cancel" aria-label="取消" onClick={() => setBlockedDeleteRuns(null)}>
                  取消
                </Button>,
                <Button
                  key="terminate"
                  type="primary"
                  danger
                  aria-label="立即终止该任务"
                  onClick={() => {
                    const target = blockedDeleteRuns[0];
                    setBlockedDeleteRuns(null);
                    if (target) setCancelTarget(target);
                  }}
                >
                  立即终止该任务
                </Button>,
              ]
            : [
                <Button
                  key="ack"
                  type="primary"
                  aria-label="知道了"
                  onClick={() => setBlockedDeleteRuns(null)}
                >
                  知道了
                </Button>,
              ]
        }
      >
        <p>
          已选中的任务中包含 {blockedDeleteRuns?.length ?? 0} 条尚未结束的监测任务（排队中 / 运行中
          /
          已暂停），禁止直接删除。请先点击「终止」（尚未执行的检测项预冻点数将自动退回账户），待任务结束后再删除记录。
        </p>
      </Modal>

      <Modal
        open={deleteRunIds !== null && deleteRunIds.length > 0}
        title="确认删除监测任务记录"
        keyboard
        destroyOnHidden
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
        keyboard
        destroyOnHidden
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
