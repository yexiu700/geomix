'use client';

import {
  VISIBILITY_BRAND_NAME_MAX,
  VISIBILITY_DEFAULT_UNIT_POINTS,
  VISIBILITY_ENGINE_LABELS,
  VISIBILITY_MAX_COMPETITORS,
  VISIBILITY_PROFILE_NAME_MAX,
  VISIBILITY_RUN_NAME_MAX,
  VISIBILITY_TASK_STATUS_LABELS,
  formatShanghaiDateTime,
  normalizeVisibilityDomain,
  toXlsx,
  type CitationSourceKind,
  type CrudExportFormat,
  type QuestionRecord,
  type TaskStatusName,
  type VisibilityCompetitor,
  type VisibilityEngineKey,
  type VisibilityObservationRecord,
  type VisibilityPrefillSources,
  type VisibilityProfileRecord,
  type VisibilityRunDetailRecord,
  type VisibilityRunRecord,
} from '@geomix/shared';
import type { CSSProperties, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PriceItem } from '../../lib/samples';
import type { SessionStorageLike } from '../../lib/session';
import { sanitizeEntityTitleSegment, triggerBlobDownload } from '../../lib/ux-foundation';

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_PROFILE_STORAGE_KEY = 'geomix:visibility:default-profile-id';

export const DEFAULT_VISIBILITY_PRICES_FALLBACK: PriceItem[] = [
  {
    action: 'visibility_check',
    unitPoints: VISIBILITY_DEFAULT_UNIT_POINTS,
    enabled: true,
    label: 'AI可见性监测',
  },
];

export type DefaultProfileStorageLike = Pick<
  SessionStorageLike,
  'getItem' | 'setItem' | 'removeItem'
>;

export type CompetitorDraftRow = {
  key: string;
  name: string;
  aliasesText: string;
  domainsText: string;
};

export type ProfileDraft = {
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

export type ProfileModalState = {
  initial: ProfileDraft;
  draft: ProfileDraft;
  minimized: boolean;
  maximized: boolean;
};

export type RunCreateDraft = {
  profileId: string;
  name: string;
  keywordId: string;
  questionIds: string[];
  customPromptsText: string;
  engines: VisibilityEngineKey[];
};

export type RunModalState = {
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

export type MonitorsBanner = {
  type: 'success' | 'error' | 'info' | 'warning';
  text: string;
};

export type ObsMentionFilter = 'all' | 'mentioned' | 'unmentioned';

export type ObsFiltersState = {
  engine: string;
  mention: ObsMentionFilter;
  sentiment: string;
};

export type ConfirmDialogState =
  | { kind: 'cancel-run'; run: VisibilityRunRecord }
  | { kind: 'blocked-delete'; runs: VisibilityRunRecord[] }
  | { kind: 'delete-runs'; ids: string[] }
  | { kind: 'delete-profile'; profile: VisibilityProfileRecord }
  | null;

export const HEADER_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 16,
};
export const PROGRESS_TRACK_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  height: 4,
  borderRadius: 2,
  overflow: 'hidden',
  background: 'rgba(255,255,255,0.06)',
  gap: 1,
  marginTop: 6,
};
export const PCT_TRACK_STYLE: CSSProperties = {
  width: 40,
  height: 4,
  borderRadius: 2,
  background: 'rgba(255,255,255,0.06)',
  overflow: 'hidden',
  flex: 'none',
};
export const ERROR_DOT_STYLE: CSSProperties = {
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
};
export const PROFILE_GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))',
  gap: 12,
};

export function buildProfileCardStyle(isDefault: boolean): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: 12,
    padding: 16,
    border: isDefault ? '1px solid var(--gm-phosphor-a40)' : '1px solid var(--gm-line-1)',
    borderRadius: 8,
    background: isDefault ? 'var(--gm-bg-elevated)' : 'var(--gm-bg-surface)',
    boxShadow: isDefault ? 'var(--gm-glow-active)' : undefined,
    minWidth: 0,
  };
}

function resolveDefaultProfileStorage(
  storage?: DefaultProfileStorageLike | null,
): DefaultProfileStorageLike | undefined {
  if (storage === null) return undefined;
  if (storage) return storage;
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  return undefined;
}

export function useDefaultProfileId(
  profiles: VisibilityProfileRecord[],
  storage?: DefaultProfileStorageLike | null,
): {
  defaultProfileId: string;
  effectiveDefaultProfileId: string;
  persistDefaultProfile: (id: string) => void;
  syncDefaultAfterProfileSave: (params: {
    mode: 'create' | 'edit';
    savedId: string;
    isDefault: boolean;
    previousProfiles: VisibilityProfileRecord[];
  }) => void;
  clearDefaultIfRemoved: (removedId: string) => void;
} {
  const storageRef = useRef(storage);
  storageRef.current = storage;

  const [defaultProfileId, setDefaultProfileId] = useState<string>(() => {
    try {
      return resolveDefaultProfileStorage(storage)?.getItem(DEFAULT_PROFILE_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });

  const effectiveDefaultProfileId = useMemo(() => {
    if (defaultProfileId && profiles.some((p) => p.id === defaultProfileId)) {
      return defaultProfileId;
    }
    return profiles[0]?.id ?? '';
  }, [defaultProfileId, profiles]);

  const persistDefaultProfile = useCallback((id: string) => {
    setDefaultProfileId(id);
    try {
      const target = resolveDefaultProfileStorage(storageRef.current);
      if (!target) return;
      if (id) target.setItem(DEFAULT_PROFILE_STORAGE_KEY, id);
      else target.removeItem(DEFAULT_PROFILE_STORAGE_KEY);
    } catch {
      // Ignore storage quota or security errors while keeping in-memory selection updated.
    }
  }, []);

  const syncDefaultAfterProfileSave = useCallback(
    ({
      mode,
      savedId,
      isDefault,
      previousProfiles,
    }: {
      mode: 'create' | 'edit';
      savedId: string;
      isDefault: boolean;
      previousProfiles: VisibilityProfileRecord[];
    }) => {
      const previousDefaultId =
        defaultProfileId && previousProfiles.some((p) => p.id === defaultProfileId)
          ? defaultProfileId
          : (previousProfiles[0]?.id ?? '');

      if (mode === 'edit') {
        if (isDefault) {
          persistDefaultProfile(savedId);
        } else if (defaultProfileId === savedId && previousProfiles.length > 1) {
          const fallback = previousProfiles.find((item) => item.id !== savedId);
          if (fallback) persistDefaultProfile(fallback.id);
        }
        return;
      }

      if (isDefault || previousProfiles.length === 0) {
        persistDefaultProfile(savedId);
      } else if (previousDefaultId && previousDefaultId !== defaultProfileId) {
        // Lock the existing fallback default profile in storage so prepending the new profile never steals default status (#192)
        persistDefaultProfile(previousDefaultId);
      }
    },
    [defaultProfileId, persistDefaultProfile],
  );

  const clearDefaultIfRemoved = useCallback(
    (removedId: string) => {
      if (defaultProfileId === removedId) {
        persistDefaultProfile('');
      }
    },
    [defaultProfileId, persistDefaultProfile],
  );

  return {
    defaultProfileId,
    effectiveDefaultProfileId,
    persistDefaultProfile,
    syncDefaultAfterProfileSave,
    clearDefaultIfRemoved,
  };
}

export function useTransientBanner(sectionRef: RefObject<HTMLElement | null>) {
  const [banner, setBanner] = useState<MonitorsBanner | null>(null);

  const clearTransientBanner = useCallback(() => {
    setBanner((curr) => (curr && (curr.type === 'success' || curr.type === 'info') ? null : curr));
  }, []);

  useEffect(() => {
    if (!banner || (banner.type !== 'success' && banner.type !== 'info')) return undefined;
    const timer = window.setTimeout(() => {
      setBanner((curr) => (curr === banner ? null : curr));
    }, 6_000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  useEffect(() => {
    const pageEl = sectionRef.current?.closest('.gm-page');
    if (!pageEl || typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => {
      if (pageEl.hasAttribute('hidden')) {
        clearTransientBanner();
      }
    });
    observer.observe(pageEl, { attributes: true, attributeFilter: ['hidden'] });
    return () => observer.disconnect();
  }, [clearTransientBanner, sectionRef]);

  return { banner, setBanner, clearTransientBanner };
}

export function resolveSessionStorage(storage?: SessionStorageLike): SessionStorageLike {
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
}

export function resolveVisibilityUnitPoints(prices: PriceItem[] | null): number {
  const found = prices?.find((item) => item.action === 'visibility_check' && item.enabled);
  return found?.unitPoints ?? VISIBILITY_DEFAULT_UNIT_POINTS;
}

export function parseHrefParams(href?: string): { profileId?: string; runId?: string } {
  if (!href) return {};
  const qIndex = href.indexOf('?');
  if (qIndex < 0) return {};
  const params = new URLSearchParams(href.slice(qIndex + 1));
  const profileId = params.get('profileId')?.trim() || undefined;
  const runId = params.get('runId')?.trim() || undefined;
  return { profileId, runId };
}

export function resolveMonitorsScreenTitle({
  title,
  activeProfileId,
  runId,
  profiles,
  runs,
  detailRun,
}: {
  title: string;
  activeProfileId?: string;
  runId?: string;
  profiles: VisibilityProfileRecord[];
  runs: VisibilityRunRecord[];
  detailRun: VisibilityRunDetailRecord | null;
}): string {
  const sepIdx = title.indexOf(' · ');
  const baseTitle = sepIdx > 0 ? title.slice(0, sepIdx) : title || 'AI可见度诊断';
  const matchedProfile = activeProfileId
    ? profiles.find((p) => p.id === activeProfileId)
    : undefined;
  const matchedRunName = runId
    ? detailRun?.id === runId
      ? detailRun.name
      : runs.find((r) => r.id === runId)?.name
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
  if (runId) {
    if (matchedRunName) {
      parts.push(matchedRunName);
    } else {
      const safeRun = sanitizeEntityTitleSegment(runId, '当前诊断任务');
      parts.push(safeRun === '当前诊断任务' ? '当前诊断任务' : `任务 ${safeRun}`);
    }
  }
  return parts.length > 0 ? `${baseTitle} · ${parts.join(' · ')}` : baseTitle;
}

export function filterRunObservations(
  detailRun: VisibilityRunDetailRecord | null,
  filters: ObsFiltersState,
): VisibilityObservationRecord[] {
  if (!detailRun) return [];
  return detailRun.observations.filter((obs) => {
    if (filters.engine && obs.engine !== filters.engine) return false;
    if (filters.mention === 'mentioned' && !obs.brandMentioned) return false;
    if (filters.mention === 'unmentioned' && obs.brandMentioned) return false;
    if (filters.sentiment && obs.brandSentiment !== filters.sentiment) return false;
    return true;
  });
}

function splitDeduped(raw: string, sep: RegExp): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(sep)) {
    const cleaned = part.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

export function splitTagList(raw: string): string[] {
  return splitDeduped(raw, /[\n,，;；]+/);
}

export function splitPromptLines(raw: string): string[] {
  return splitDeduped(raw, /\r?\n/);
}

export function formatTime(iso: string | null | undefined): string {
  return formatShanghaiDateTime(iso);
}

const CITATION_BADGE_COLORS: Record<CitationSourceKind, string> = {
  OWNED: 'blue',
  COMPETITOR: 'orange',
  AUTHORITY: 'cyan',
  SOCIAL: 'purple',
  OTHER: 'default',
};

export function citationSourceBadgeColor(kind: CitationSourceKind): string {
  return CITATION_BADGE_COLORS[kind] ?? 'default';
}

export function isControllableRunStatus(status: TaskStatusName): boolean {
  return status === 'QUEUED' || status === 'RUNNING' || status === 'PAUSED';
}

export function computeRunProgressPercents(
  row: Pick<VisibilityRunRecord, 'totalChecks' | 'doneCount' | 'failCount' | 'skipCount'>,
): { donePct: number; failPct: number; skipPct: number } {
  const { totalChecks } = row;
  if (totalChecks <= 0) {
    return { donePct: 0, failPct: 0, skipPct: 0 };
  }
  const donePct = Math.min(100, Math.max(0, (row.doneCount / totalChecks) * 100));
  const failPct = Math.min(100 - donePct, Math.max(0, (row.failCount / totalChecks) * 100));
  const skipPct = Math.min(
    100 - donePct - failPct,
    Math.max(0, ((row.skipCount ?? 0) / totalChecks) * 100),
  );
  return { donePct, failPct, skipPct };
}

export function clampVisibilityPct(pct: number | null | undefined): number {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

export function buildEmptyProfileDraft(isDefault: boolean): ProfileDraft {
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

export function buildEditProfileDraft(
  profile: VisibilityProfileRecord,
  isDefault: boolean,
): ProfileDraft {
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

export function buildDefaultRunDraft(
  defaultProfileId: string,
  defaultKeywordId = '',
): RunCreateDraft {
  return {
    profileId: defaultProfileId,
    name: '',
    keywordId: defaultKeywordId,
    questionIds: [],
    customPromptsText: '',
    engines: ['deepseek', 'doubao', 'tongyi', 'yuanbao'],
  };
}

function mergeAliasTerms(existing: string[], incoming: string[], primaryBrand: string): string[] {
  const primaryKey = primaryBrand.trim().toLowerCase();
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const raw of [...existing, ...incoming]) {
    const term = raw.replace(/\s+/g, ' ').trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (key === primaryKey || seen.has(key)) continue;
    seen.add(key);
    merged.push(term);
  }
  return merged;
}

export function applyKeywordPrefillToDraft(
  draft: ProfileDraft,
  keywordId: string,
  keywords: VisibilityPrefillSources['keywords'],
): ProfileDraft {
  if (!keywordId) {
    return { ...draft, importFromKeywordId: '' };
  }
  const kw = keywords.find((item) => item.id === keywordId);
  if (!kw) return draft;
  const cleanBrands = kw.brands.map((b) => b.trim()).filter(Boolean);
  const primaryBrand = draft.brandName.trim() || cleanBrands[0] || kw.main;
  const existingAliases = splitTagList(draft.brandAliasesText);
  const mergedAliases = mergeAliasTerms(existingAliases, cleanBrands, primaryBrand);
  return {
    ...draft,
    importFromKeywordId: keywordId,
    name: draft.name.trim() || `${primaryBrand}品牌监测档案`,
    brandName: primaryBrand,
    brandAliasesText: mergedAliases.join(', '),
  };
}

function nonEmptyTerms(values: Array<string | null | undefined>): string[] {
  return values.map((v) => v?.trim() ?? '').filter(Boolean);
}

export function applyKbPrefillToDraft(
  draft: ProfileDraft,
  kbId: string,
  knowledgeBases: VisibilityPrefillSources['knowledgeBases'],
): ProfileDraft {
  if (!kbId) return { ...draft, importFromKbId: '' };
  const kb = knowledgeBases.find((item) => item.id === kbId);
  if (!kb) return draft;
  const candidates = nonEmptyTerms([kb.brandShort, kb.companyName, kb.name]);
  const primaryBrand = draft.brandName.trim() || candidates[0] || '';
  const mergedAliases = mergeAliasTerms(
    splitTagList(draft.brandAliasesText),
    nonEmptyTerms([kb.brandShort, kb.companyName]),
    primaryBrand,
  );
  return {
    ...draft,
    importFromKbId: kbId,
    name: draft.name.trim() || `${primaryBrand || kb.name}监测档案`,
    brandName: primaryBrand,
    brandAliasesText: mergedAliases.join(', '),
  };
}

export function validateProfileName(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return '请填写档案名称';
  if (trimmed.length > VISIBILITY_PROFILE_NAME_MAX) {
    return `档案名称不能超过 ${VISIBILITY_PROFILE_NAME_MAX} 个字符`;
  }
  return undefined;
}

export function validateProfileBrandName(
  draft: Pick<ProfileDraft, 'mode' | 'brandName' | 'importFromKeywordId' | 'importFromKbId'>,
): string | undefined {
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

export function normalizeProfileDomainsAndCompetitors(
  draft: Pick<ProfileDraft, 'ownedDomainsText' | 'competitors'>,
):
  | { ok: true; ownedDomains: string[]; competitors: VisibilityCompetitor[] }
  | { ok: false; error: string } {
  const ownedDomains: string[] = [];
  for (const rawDom of splitTagList(draft.ownedDomainsText)) {
    const normalized = normalizeVisibilityDomain(rawDom);
    if (!normalized) {
      return {
        ok: false,
        error: `自有域名格式不正确：${rawDom}（示例：geomix.cn 或 docs.geomix.cn）`,
      };
    }
    if (!ownedDomains.includes(normalized)) ownedDomains.push(normalized);
  }
  if (draft.competitors.length > VISIBILITY_MAX_COMPETITORS) {
    return { ok: false, error: `最多配置 ${VISIBILITY_MAX_COMPETITORS} 个监测竞品` };
  }
  const competitors: VisibilityCompetitor[] = [];
  for (let i = 0; i < draft.competitors.length; i += 1) {
    const row = draft.competitors[i]!;
    const compName = row.name.trim();
    if (!compName) {
      return { ok: false, error: `请填写第 ${i + 1} 个竞品的品牌名称，或移除空行` };
    }
    const compDomains: string[] = [];
    for (const rawDom of splitTagList(row.domainsText)) {
      const normalized = normalizeVisibilityDomain(rawDom);
      if (!normalized) {
        return { ok: false, error: `竞品「${compName}」的域名格式不正确：${rawDom}` };
      }
      if (!compDomains.includes(normalized)) compDomains.push(normalized);
    }
    competitors.push({
      name: compName,
      aliases: splitTagList(row.aliasesText),
      domains: compDomains,
    });
  }
  return { ok: true, ownedDomains, competitors };
}

export function validateRunDraftForSubmit(
  draft: RunCreateDraft,
): { ok: true; customPrompts: string[] } | { ok: false; error: string } {
  if (!draft.profileId) return { ok: false, error: '请选择监测档案' };
  if (draft.name.trim().length > VISIBILITY_RUN_NAME_MAX) {
    return { ok: false, error: `任务名称不能超过 ${VISIBILITY_RUN_NAME_MAX} 个字符` };
  }
  if (draft.engines.length === 0) {
    return { ok: false, error: '请至少选择一个目标 AI 监测引擎' };
  }
  const customPrompts = splitPromptLines(draft.customPromptsText);
  const tooShort = customPrompts.find((p) => p.length < 2);
  if (tooShort) {
    return { ok: false, error: `自定义监测问题至少需要 2 个字：「${tooShort}」` };
  }
  if (draft.questionIds.length === 0 && customPrompts.length === 0) {
    return { ok: false, error: '请至少勾选一条已有问题或输入一条自定义监测问题' };
  }
  return { ok: true, customPrompts };
}

export function countUniqueRunPrompts(
  draft: Pick<RunCreateDraft, 'questionIds' | 'customPromptsText'>,
  keywordQuestions: QuestionRecord[],
): number {
  const seen = new Set<string>();
  for (const qId of draft.questionIds) {
    const q = keywordQuestions.find((item) => item.id === qId);
    const key = (q?.text ?? qId).replace(/\s+/g, ' ').trim().toLowerCase();
    if (key) seen.add(key);
  }
  for (const line of splitPromptLines(draft.customPromptsText)) {
    seen.add(line.toLowerCase());
  }
  return seen.size;
}

export function defaultDownloadHandler(file: VisibilityExportFile): void {
  triggerBlobDownload(file);
}

function escapeCsvCell(val: string): string {
  if (/[",\r\n]/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

const RUNS_EXPORT_HEADERS = [
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

export function buildRunsExportTable(rows: VisibilityRunRecord[]): {
  headers: string[];
  rows: string[][];
} {
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
  return { headers: [...RUNS_EXPORT_HEADERS], rows: tableRows };
}

export function buildRunsExportBytes(rows: VisibilityRunRecord[]): Uint8Array {
  const table = buildRunsExportTable(rows);
  const lines = [
    table.headers.join(','),
    ...table.rows.map((cells) => cells.map(escapeCsvCell).join(',')),
  ];
  return new TextEncoder().encode(`\uFEFF${lines.join('\r\n')}`);
}

export function buildRunsExportFile(
  rows: VisibilityRunRecord[],
  format: CrudExportFormat,
): VisibilityExportFile {
  if (format === 'xlsx') {
    const table = buildRunsExportTable(rows);
    return {
      filename: 'geomix-visibility-runs.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: toXlsx(table.headers, table.rows),
    };
  }
  return {
    filename: 'geomix-visibility-runs.csv',
    mime: 'text/csv;charset=utf-8',
    body: buildRunsExportBytes(rows),
  };
}

export function getConfirmDialogSpec(
  dialog: ConfirmDialogState,
): { title: string; body: string; okText?: string } | null {
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'cancel-run':
      return {
        title: '确认终止可见度监测任务',
        okText: '确认终止并退还未用点数',
        body: `确定终止监测任务「${dialog.run.name}」吗？尚未执行的检测项将标记为跳过，对应预冻点数将自动退回账户。`,
      };
    case 'blocked-delete':
      return {
        title: '无法删除进行中的监测任务',
        body: `已选中的任务中包含 ${dialog.runs.length} 条尚未结束的监测任务（排队中 / 运行中 / 已暂停），禁止直接删除。请先点击「终止」（尚未执行的检测项预冻点数将自动退回账户），待任务结束后再删除记录。`,
      };
    case 'delete-runs':
      return {
        title: '确认删除监测任务记录',
        okText: '确认删除',
        body: `确定删除已选中的 ${dialog.ids.length} 条已结束监测任务记录吗？此操作不可恢复。`,
      };
    case 'delete-profile':
      return {
        title: '确认删除品牌与竞品档案',
        okText: '确认删除档案',
        body: `确定删除监测档案「${dialog.profile.name}」吗？关联的历史监测任务与观测记录将一并清理。`,
      };
  }
}
