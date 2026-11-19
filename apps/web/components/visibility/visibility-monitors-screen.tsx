'use client';

import {
  TASK_STATUSES,
  VISIBILITY_TASK_STATUS_LABELS,
  isTaskStatus,
  type CrudExportFormat,
  type KeywordRecord,
  type VisibilityPrefillSources,
  type VisibilityProfileRecord,
  type VisibilityRunDetailRecord,
  type VisibilityRunListQuery,
  type VisibilityRunRecord,
} from '@geomix/shared';
import { Alert, Button, Drawer, Input, Modal, Space, Tabs, Typography } from 'antd';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PriceItem } from '../../lib/samples';
import { COMPACT_SELECT_STYLE } from '../../lib/select-styles';
import type { SessionStorageLike } from '../../lib/session';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import type { ShellAction } from '../../lib/tab-stack';
import { useTaskPolling } from '../../lib/use-task-polling';
import { useSyncTabTitle } from '../../lib/ux-foundation';
import { httpVisibilityGateway, type VisibilityGateway } from '../../lib/visibility';
import { CrudTable } from '../crud/crud-table';
import { SignalEmpty, SignalPill, SignalSkeleton } from '../geo/primitives';

const RunWorkspace = dynamic(() => import('../geo/run-workspace').then((m) => m.RunWorkspace));
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_VISIBILITY_PRICES_FALLBACK,
  HEADER_ROW_STYLE,
  buildRunsExportFile,
  defaultDownloadHandler,
  filterRunObservations,
  getConfirmDialogSpec,
  isControllableRunStatus,
  parseHrefParams,
  resolveMonitorsScreenTitle,
  resolveSessionStorage,
  resolveVisibilityUnitPoints,
  useDefaultProfileId,
  useTransientBanner,
  type ConfirmDialogState,
  type ObsFiltersState,
  type VisibilityExportFile,
} from './monitors-helpers';
import {
  ProfileEditorModal,
  VisibilityProfilesTab,
  type ProfileSavedMeta,
} from './profile-editor-modal';
import { RunCreateModal, buildMonitorsRunColumns } from './run-create-modal';

export { citationSourceBadgeColor, type VisibilityExportFile } from './monitors-helpers';

type MetaState = {
  profiles: VisibilityProfileRecord[];
  prefillSources: VisibilityPrefillSources;
  keywords: KeywordRecord[];
  prices: PriceItem[] | null;
  profilesLoaded: boolean;
};

type ProfileEditorTarget =
  | { session: number; mode: 'create' }
  | { session: number; mode: 'edit'; profile: VisibilityProfileRecord }
  | null;

type RunCreateTarget = { session: number; initialProfileId: string } | null;

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
  const effectiveStorage = useMemo(() => resolveSessionStorage(storage), [storage]);
  const client = useMemo(
    () => gateway ?? httpVisibilityGateway(effectiveStorage),
    [effectiveStorage, gateway],
  );
  const initialUrlParams = useMemo(() => parseHrefParams(href), [href]);

  const sectionRef = useRef<HTMLElement | null>(null);
  const profileFilterSelectRef = useRef<HTMLSelectElement | null>(null);
  const modalSessionRef = useRef(0);
  const detailRequestIdRef = useRef(0);

  const [activeTab, setActiveTab] = useState<'runs' | 'profiles'>('runs');
  const [meta, setMeta] = useState<MetaState>({
    profiles: [],
    prefillSources: { keywords: [], knowledgeBases: [] },
    keywords: [],
    prices: null,
    profilesLoaded: false,
  });
  const [query, setQuery] = useState<VisibilityRunListQuery>(() => ({
    page: 1,
    pageSize: 10,
    profileId: initialUrlParams.profileId,
    status: undefined,
    keyword: undefined,
  }));
  const [keywordDraft, setKeywordDraft] = useState('');
  const [runsPage, setRunsPage] = useState<{
    items: VisibilityRunRecord[];
    total: number;
    loading: boolean;
  }>({ items: [], total: 0, loading: true });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reloadTick, setReloadTick] = useState(0);

  const [profileEditorTarget, setProfileEditorTarget] = useState<ProfileEditorTarget>(null);
  const [runCreateTarget, setRunCreateTarget] = useState<RunCreateTarget>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(null);
  const [controlLoading, setControlLoading] = useState(false);

  const [drawerState, setDrawerState] = useState<{
    open: boolean;
    loading: boolean;
    run: VisibilityRunDetailRecord | null;
  }>({ open: false, loading: false, run: null });
  const [obsFilters, setObsFilters] = useState<ObsFiltersState>({
    engine: '',
    mention: 'all',
    sentiment: '',
  });

  const {
    effectiveDefaultProfileId,
    persistDefaultProfile,
    syncDefaultAfterProfileSave,
    clearDefaultIfRemoved,
  } = useDefaultProfileId(meta.profiles);

  const { banner, setBanner, clearTransientBanner } = useTransientBanner(sectionRef);
  const unitPoints = useMemo(() => resolveVisibilityUnitPoints(meta.prices), [meta.prices]);

  const loadMeta = useCallback(async () => {
    if (!featureEnabled) return;
    try {
      const [profileRes, kwList, priceList] = await Promise.all([
        client.listProfiles(),
        client.listKeywords().catch(() => []),
        client.listPrices().catch(() => DEFAULT_VISIBILITY_PRICES_FALLBACK),
      ]);
      setMeta((curr) => ({
        profiles: profileRes.items,
        prefillSources: profileRes.prefillSources ?? curr.prefillSources,
        keywords: kwList,
        prices: priceList,
        profilesLoaded: true,
      }));
    } catch (err) {
      setMeta((curr) => ({ ...curr, profilesLoaded: true }));
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : '加载监测档案失败',
      });
    }
  }, [client, featureEnabled, setBanner]);

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

  useEffect(() => {
    if (!featureEnabled) {
      setRunsPage((curr) => ({ ...curr, loading: false }));
      return undefined;
    }
    let cancelled = false;
    setRunsPage((curr) => ({ ...curr, loading: true }));
    void client
      .listRuns(query)
      .then((res) => {
        if (!cancelled) setRunsPage({ items: res.items, total: res.total, loading: false });
      })
      .catch((err) => {
        if (!cancelled) {
          setRunsPage((curr) => ({ ...curr, loading: false }));
          setBanner({
            type: 'error',
            text: err instanceof Error ? err.message : '读取监测任务列表失败',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, featureEnabled, query, reloadTick, setBanner]);

  const openDetailDrawer = useCallback(
    async (runId: string) => {
      const reqId = ++detailRequestIdRef.current;
      setDrawerState((curr) => ({ open: true, loading: true, run: curr.run }));
      setObsFilters({ engine: '', mention: 'all', sentiment: '' });
      try {
        const detail = await client.getRun(runId);
        if (detailRequestIdRef.current !== reqId) return;
        setDrawerState({ open: true, loading: false, run: detail });
      } catch (err) {
        if (detailRequestIdRef.current !== reqId) return;
        setBanner({
          type: 'error',
          text: err instanceof Error ? err.message : '加载诊断详情失败',
        });
        setDrawerState({ open: false, loading: false, run: null });
      }
    },
    [client, setBanner],
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

  const hasActiveRun = useMemo(() => {
    const listActive = runsPage.items.some((r) => r.status === 'QUEUED' || r.status === 'RUNNING');
    const drawerActive =
      drawerState.open &&
      drawerState.run !== null &&
      (drawerState.run.status === 'QUEUED' || drawerState.run.status === 'RUNNING');
    return listActive || drawerActive;
  }, [drawerState.open, drawerState.run, runsPage.items]);

  const detailRunId = drawerState.run?.id ?? null;

  useTaskPolling({
    enabled: featureEnabled && hasActiveRun,
    active,
    intervalMs: pollIntervalMs,
    onPoll: async () => {
      await Promise.all([
        client
          .listRuns(query)
          .then((res) => {
            setRunsPage((curr) => ({ ...curr, items: res.items, total: res.total }));
          })
          .catch(() => undefined),
        drawerState.open && detailRunId
          ? client
              .getRun(detailRunId)
              .then((fresh) => {
                setDrawerState((curr) =>
                  curr.open && curr.run?.id === detailRunId ? { ...curr, run: fresh } : curr,
                );
              })
              .catch(() => undefined)
          : Promise.resolve(),
      ]);
    },
  });

  function openCreateProfileModal() {
    if (readOnly) return;
    setProfileEditorTarget({ session: ++modalSessionRef.current, mode: 'create' });
    void loadMeta();
  }

  function openEditProfileModal(profile: VisibilityProfileRecord) {
    if (readOnly) return;
    setProfileEditorTarget({ session: ++modalSessionRef.current, mode: 'edit', profile });
    void loadMeta();
  }

  function openCreateRunModal(presetProfileId?: string) {
    if (readOnly) return;
    if (meta.profiles.length === 0) {
      setActiveTab('profiles');
      openCreateProfileModal();
      setBanner({
        type: 'info',
        text: '请先创建至少一个「品牌与竞品档案」，随后即可发起多引擎可见度监测',
      });
      return;
    }
    const targetProfileId = presetProfileId || query.profileId || effectiveDefaultProfileId;
    setRunCreateTarget({ session: ++modalSessionRef.current, initialProfileId: targetProfileId });
    void loadMeta();
  }

  function handleProfileSaved(saved: VisibilityProfileRecord, savedMeta: ProfileSavedMeta) {
    const previousProfiles = meta.profiles;
    setMeta((curr) => ({
      ...curr,
      profiles:
        savedMeta.mode === 'edit'
          ? curr.profiles.map((item) => (item.id === saved.id ? saved : item))
          : [saved, ...curr.profiles],
    }));
    setBanner({
      type: 'success',
      text:
        savedMeta.mode === 'edit'
          ? `已更新监测档案「${saved.name}」`
          : `已创建监测档案「${saved.name}」`,
    });
    syncDefaultAfterProfileSave({
      mode: savedMeta.mode,
      savedId: saved.id,
      isDefault: savedMeta.isDefault,
      previousProfiles,
    });
    invalidateFreshness('visibility-profiles');
  }

  async function applyRunTransition(
    action: () => Promise<VisibilityRunDetailRecord>,
    okMessage: (updated: VisibilityRunDetailRecord) => string,
    failFallback: string,
  ) {
    if (readOnly) return;
    try {
      const updated = await action();
      setRunsPage((curr) => ({
        ...curr,
        items: curr.items.map((r) => (r.id === updated.id ? updated : r)),
      }));
      setDrawerState((curr) => (curr.run?.id === updated.id ? { ...curr, run: updated } : curr));
      setBanner({ type: 'success', text: okMessage(updated) });
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : failFallback });
    }
  }

  const handlePauseRun = (row: VisibilityRunRecord) =>
    applyRunTransition(
      () => client.pauseRun(row.id),
      (u) => `已暂停监测任务「${u.name}」`,
      '暂停监测任务失败',
    );

  const handleResumeRun = (row: VisibilityRunRecord) =>
    applyRunTransition(
      () => client.resumeRun(row.id),
      (u) => `已继续运行监测任务「${u.name}」`,
      '继续监测任务失败',
    );

  async function handleConfirmAction() {
    if (!confirmDialog || readOnly) return;
    if (confirmDialog.kind === 'cancel-run') {
      setControlLoading(true);
      await applyRunTransition(
        () => client.cancelRun(confirmDialog.run.id),
        (u) => `已终止监测任务「${u.name}」，未执行检测项预冻点数已退回`,
        '终止监测任务失败',
      );
      setConfirmDialog(null);
      setControlLoading(false);
      return;
    }

    if (confirmDialog.kind === 'delete-runs') {
      const { ids } = confirmDialog;
      if (ids.length === 0) return;
      setControlLoading(true);
      try {
        const res = await client.bulkDeleteRuns(ids);
        setDrawerState((curr) =>
          curr.run && ids.includes(curr.run.id) ? { open: false, loading: false, run: null } : curr,
        );
        setSelectedIds((curr) => curr.filter((id) => !ids.includes(id)));
        setConfirmDialog(null);
        setBanner({ type: 'success', text: `已删除 ${res.deleted} 条监测任务记录` });
        setReloadTick((n) => n + 1);
        invalidateFreshness('visibility-runs', 'points');
        void loadMeta();
      } catch (err) {
        setBanner({ type: 'error', text: err instanceof Error ? err.message : '删除监测任务失败' });
        setConfirmDialog(null);
      } finally {
        setControlLoading(false);
      }
      return;
    }

    if (confirmDialog.kind === 'delete-profile') {
      const { id: removedId, name: removedName } = confirmDialog.profile;
      setControlLoading(true);
      try {
        await client.deleteProfile(removedId);
        setMeta((curr) => ({
          ...curr,
          profiles: curr.profiles.filter((p) => p.id !== removedId),
        }));
        clearDefaultIfRemoved(removedId);
        if (query.profileId === removedId) {
          setQuery((curr) => ({ ...curr, page: 1, profileId: undefined }));
        }
        setConfirmDialog(null);
        invalidateFreshness('visibility-profiles');
        setBanner({ type: 'success', text: `已删除监测档案「${removedName}」` });
      } catch (err) {
        setBanner({ type: 'error', text: err instanceof Error ? err.message : '删除监测档案失败' });
        setConfirmDialog(null);
      } finally {
        setControlLoading(false);
      }
    }
  }

  function handleExportRuns(format: CrudExportFormat) {
    downloadFile(buildRunsExportFile(runsPage.items, format));
  }

  function openOverviewForProfile(profileId?: string) {
    setDrawerState((curr) => ({ ...curr, open: false }));
    const targetHref = profileId
      ? `/visibility/overview?profileId=${encodeURIComponent(profileId)}`
      : '/visibility/overview';
    onDispatch?.({ type: 'open', href: targetHref, sourceId: tabId });
  }

  const resolvedTitle = useMemo(
    () =>
      resolveMonitorsScreenTitle({
        title,
        activeProfileId: query.profileId || initialUrlParams.profileId,
        runId: initialUrlParams.runId,
        profiles: meta.profiles,
        runs: runsPage.items,
        detailRun: drawerState.run,
      }),
    [
      drawerState.run,
      initialUrlParams.profileId,
      initialUrlParams.runId,
      meta.profiles,
      query.profileId,
      runsPage.items,
      title,
    ],
  );

  useSyncTabTitle(tabId, title, resolvedTitle, onDispatch);

  useEffect(() => {
    const el = profileFilterSelectRef.current;
    const desired = query.profileId ?? '';
    if (el && el.value !== desired) el.value = desired;
  }, [meta.profiles, meta.profilesLoaded, query.profileId]);

  const filteredObservations = useMemo(
    () => filterRunObservations(drawerState.run, obsFilters),
    [drawerState.run, obsFilters],
  );

  const columns = buildMonitorsRunColumns({
    readOnly,
    onOpenDetail: (runId) => void openDetailDrawer(runId),
    onOpenOverview: openOverviewForProfile,
    onPauseRun: (row) => void handlePauseRun(row),
    onResumeRun: (row) => void handleResumeRun(row),
    onRequestConfirm: setConfirmDialog,
  });

  if (!featureEnabled) {
    return (
      <section ref={sectionRef}>
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
    setQuery((curr) => ({ ...curr, page: 1, keyword: keywordDraft.trim() || undefined }));
  };

  const confirmSpec = getConfirmDialogSpec(confirmDialog);
  const detailRun = drawerState.run;

  const emptyStateNode = runsPage.loading ? (
    <SignalSkeleton variant="row" rows={5} />
  ) : meta.profiles.length === 0 ? (
    <SignalEmpty
      title="先建立品牌档案"
      description="尚未创建品牌监测档案，请先点击「新建品牌档案」配置主品牌与竞品后再发起监测"
      actionText={readOnly ? undefined : '新建品牌档案'}
      onAction={() => openCreateProfileModal()}
    />
  ) : query.profileId || query.status || query.keyword ? (
    <SignalEmpty title="没有符合筛选条件的任务" actionText="重置筛选" onAction={clearRunFilters} />
  ) : (
    <SignalEmpty
      title="还没有监测任务"
      description="选择档案、问题和引擎，系统会逐一向各 AI 引擎提问并记录是否提及你的品牌"
      actionText={readOnly ? undefined : '新建监测任务'}
      onAction={() => openCreateRunModal()}
    />
  );

  return (
    <section ref={sectionRef} style={{ minWidth: 0 }}>
      <div style={HEADER_ROW_STYLE}>
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
          clearTransientBanner();
        }}
        items={[
          {
            key: 'runs',
            label: `监测任务（${runsPage.total}）`,
            children: (
              <div style={{ minWidth: 0 }}>
                <div className="gm-filterbar">
                  <select
                    ref={profileFilterSelectRef}
                    aria-label="筛选监测档案"
                    style={{ ...COMPACT_SELECT_STYLE, width: 180 }}
                    value={query.profileId ?? ''}
                    onChange={(e) => {
                      setSelectedIds([]);
                      setQuery((curr) => ({
                        ...curr,
                        page: 1,
                        profileId: e.target.value || undefined,
                      }));
                    }}
                  >
                    <option value="">全部监测档案</option>
                    {query.profileId && !meta.profiles.some((p) => p.id === query.profileId) ? (
                      <option value={query.profileId}>
                        {!meta.profilesLoaded ? '正在加载监测档案…' : '当前监测档案'}
                      </option>
                    ) : null}
                    {meta.profiles.map((prof) => (
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
                    rows={runsPage.items}
                    columns={columns}
                    total={runsPage.total}
                    page={query.page}
                    pageSize={query.pageSize}
                    loading={runsPage.loading}
                    selectedIds={selectedIds}
                    searchOpen={false}
                    searchPlaceholder="搜索任务名、品牌或主词"
                    writeDisabled={readOnly}
                    showCreate={false}
                    showDensityToggle={false}
                    showSearch={false}
                    scroll={{ x: 'max-content' }}
                    emptyText={emptyStateNode as unknown as string}
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
                            const activeRows = runsPage.items.filter(
                              (r) =>
                                selectedIds.includes(r.id) && isControllableRunStatus(r.status),
                            );
                            setConfirmDialog(
                              activeRows.length > 0
                                ? { kind: 'blocked-delete', runs: activeRows }
                                : { kind: 'delete-runs', ids: selectedIds },
                            );
                          }
                    }
                  />
                </div>
              </div>
            ),
          },
          {
            key: 'profiles',
            label: `品牌与竞品档案（${meta.profiles.length}）`,
            children: (
              <VisibilityProfilesTab
                profiles={meta.profiles}
                effectiveDefaultProfileId={effectiveDefaultProfileId}
                readOnly={readOnly}
                onCreateProfile={() => openCreateProfileModal()}
                onEditProfile={(prof) => openEditProfileModal(prof)}
                onDeleteProfile={(prof) =>
                  setConfirmDialog({ kind: 'delete-profile', profile: prof })
                }
                onSetDefault={(prof) => {
                  persistDefaultProfile(prof.id);
                  setBanner({ type: 'success', text: `已将「${prof.name}」设为默认监测档案` });
                }}
                onStartRunForProfile={(profId) => openCreateRunModal(profId)}
                onOpenOverviewForProfile={(profId) => openOverviewForProfile(profId)}
              />
            ),
          },
        ]}
      />

      <ProfileEditorModal
        open={profileEditorTarget !== null}
        session={profileEditorTarget?.session ?? 0}
        mode={profileEditorTarget?.mode ?? 'create'}
        editingProfile={profileEditorTarget?.mode === 'edit' ? profileEditorTarget.profile : null}
        initialIsDefault={
          profileEditorTarget?.mode === 'edit'
            ? profileEditorTarget.profile.id === effectiveDefaultProfileId
            : meta.profiles.length === 0
        }
        isFirstProfile={meta.profiles.length === 0}
        prefillSources={meta.prefillSources}
        client={client}
        readOnly={readOnly}
        onRefreshMeta={() => void loadMeta()}
        onClose={() => setProfileEditorTarget(null)}
        onSaved={handleProfileSaved}
      />

      <RunCreateModal
        open={runCreateTarget !== null}
        session={runCreateTarget?.session ?? 0}
        initialProfileId={runCreateTarget?.initialProfileId ?? ''}
        profiles={meta.profiles}
        keywords={meta.keywords}
        unitPoints={unitPoints}
        client={client}
        readOnly={readOnly}
        onRefreshMeta={() => void loadMeta()}
        onClose={() => setRunCreateTarget(null)}
        onCreated={(created) => {
          setActiveTab('runs');
          setBanner({
            type: 'success',
            text: `已发起监测任务「${created.name}」，共 ${created.totalChecks} 次检测（预冻 ${created.frozenPoints ?? created.totalChecks * created.unitPrice} 点数）`,
          });
          setReloadTick((n) => n + 1);
          invalidateFreshness('visibility-runs', 'points');
          void loadMeta();
        }}
      />

      <Drawer
        open={drawerState.open}
        title={detailRun ? `可见度诊断明细 · ${detailRun.name}` : '可见度诊断明细'}
        width="min(1200px, 100vw)"
        styles={{ body: { padding: 0, background: 'var(--gm-bg-base)' } }}
        onClose={() => setDrawerState((curr) => ({ ...curr, open: false }))}
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
                <Button
                  size="small"
                  danger
                  onClick={() => setConfirmDialog({ kind: 'cancel-run', run: detailRun })}
                >
                  终止
                </Button>
              ) : null}
            </Space>
          ) : null
        }
      >
        {drawerState.open ? (
          <RunWorkspace
            run={detailRun}
            loading={drawerState.loading}
            profile={meta.profiles.find((p) => p.id === detailRun?.profileId)}
            obsEngineFilter={obsFilters.engine}
            onObsEngineFilterChange={(engine) => setObsFilters((curr) => ({ ...curr, engine }))}
            obsMentionFilter={obsFilters.mention}
            onObsMentionFilterChange={(mention) => setObsFilters((curr) => ({ ...curr, mention }))}
            obsSentimentFilter={obsFilters.sentiment}
            onObsSentimentFilterChange={(sentiment) =>
              setObsFilters((curr) => ({ ...curr, sentiment }))
            }
            filteredObservations={filteredObservations}
            onResetFilters={() => setObsFilters({ engine: '', mention: 'all', sentiment: '' })}
          />
        ) : null}
      </Drawer>

      <Modal
        key={confirmDialog?.kind ?? 'closed'}
        open={confirmDialog !== null}
        title={confirmSpec?.title}
        keyboard
        destroyOnHidden
        okText={confirmSpec?.okText}
        cancelText="取消"
        okButtonProps={{ danger: true, loading: controlLoading }}
        onOk={() => void handleConfirmAction()}
        onCancel={() => {
          if (!controlLoading) setConfirmDialog(null);
        }}
        footer={
          confirmDialog?.kind === 'blocked-delete'
            ? confirmDialog.runs.length === 1 && selectedIds.length === 1
              ? [
                  <Button key="cancel" aria-label="取消" onClick={() => setConfirmDialog(null)}>
                    取消
                  </Button>,
                  <Button
                    key="terminate"
                    type="primary"
                    danger
                    aria-label="立即终止该任务"
                    onClick={() => {
                      const target = confirmDialog.runs[0];
                      setConfirmDialog(target ? { kind: 'cancel-run', run: target } : null);
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
                    onClick={() => setConfirmDialog(null)}
                  >
                    知道了
                  </Button>,
                ]
            : undefined
        }
      >
        {confirmSpec ? <p>{confirmSpec.body}</p> : null}
      </Modal>
    </section>
  );
}
