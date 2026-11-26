'use client';

import type {
  BrandMarketRecord,
  BrandProductLineDto,
  GeoMarket,
  TaskStatusName,
  VisibilityEngineAvailabilityItem,
  VisibilityEngineKey,
  VisibilityObservationRecord,
  VisibilityRunDetailRecord,
  VisibilityRunRecord,
} from '@geomix/shared';
import {
  TASK_STATUSES,
  VISIBILITY_DEFAULT_UNIT_POINTS,
  VISIBILITY_TASK_STATUS_LABELS,
  formatShanghaiDateTime,
  readProductLineMarketSeedPrompts,
  sanitizeEntityTitleSegment,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Input, Space, Table, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { JSX, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { formatPct } from '../../lib/design-tokens';
import { filterEnginesForMarket, parsePromptLines } from '../../lib/visibility';
import { EngineChipList, SignalError, SignalSkeleton, TruncText } from '../geo/primitives';
import { RunWorkspace } from '../geo/run-workspace';
import { EmptyState, RowActions, Section, StatusBadge, type RowActionItem } from '../ui';

export type VisibilityRunsTabProps = {
  activeMarket: GeoMarket;
  activeBrandMarket: BrandMarketRecord | null;
  activeProductLine?: BrandProductLineDto | null;
  readOnly: boolean;
  // Create run form
  runName: string;
  onRunNameChange: (val: string) => void;
  promptsText: string;
  onPromptsTextChange: (val: string) => void;
  engines: readonly VisibilityEngineAvailabilityItem[];
  enginesLoading: boolean;
  enginesError: string | null;
  onRetryEngines: () => void;
  checkedEngines: readonly VisibilityEngineKey[];
  onCheckedEnginesChange: (next: VisibilityEngineKey[]) => void;
  submitting: boolean;
  submitError: string | null;
  onSubmitRun: () => void;
  // Runs list
  runs: readonly VisibilityRunRecord[];
  runsTotal: number;
  runsPage: number;
  runsPageSize: number;
  runsLoading: boolean;
  runsError: string | null;
  statusFilter: TaskStatusName | '';
  keywordFilter: string;
  onStatusFilterChange: (next: TaskStatusName | '') => void;
  onKeywordFilterChange: (next: string) => void;
  onPageChange: (page: number) => void;
  onRefreshRuns: () => void;
  // Selected run + actions
  activeRunId: string | null;
  activeRunDetail: VisibilityRunDetailRecord | null;
  runDetailLoading: boolean;
  runDetailError: string | null;
  onSelectRun: (runId: string) => void;
  onPauseRun: (run: VisibilityRunRecord) => void;
  onResumeRun: (run: VisibilityRunRecord) => void;
  onCancelRun: (run: VisibilityRunRecord) => void;
  onDeleteRun: (run: VisibilityRunRecord) => void;
  actionLoadingRunId: string | null;
  // Observation filters
  obsEngineFilter: string;
  onObsEngineFilterChange: (val: string) => void;
  obsMentionFilter: 'all' | 'mentioned' | 'unmentioned';
  onObsMentionFilterChange: (val: 'all' | 'mentioned' | 'unmentioned') => void;
  obsSentimentFilter: string;
  onObsSentimentFilterChange: (val: string) => void;
  onResetObsFilters: () => void;
  /** Optional M3 action slot for observation cards (e.g. answer-brief-btn). */
  renderObservationAction?: (obs: VisibilityObservationRecord) => ReactNode;
};

export function VisibilityRunsTab(props: VisibilityRunsTabProps): JSX.Element {
  const {
    activeMarket,
    activeBrandMarket,
    activeProductLine = null,
    readOnly,
    runName,
    onRunNameChange,
    promptsText,
    onPromptsTextChange,
    engines,
    enginesLoading,
    enginesError,
    onRetryEngines,
    checkedEngines,
    onCheckedEnginesChange,
    submitting,
    submitError,
    onSubmitRun,
    runs,
    runsTotal,
    runsPage,
    runsPageSize,
    runsLoading,
    runsError,
    statusFilter,
    keywordFilter,
    onStatusFilterChange,
    onKeywordFilterChange,
    onPageChange,
    onRefreshRuns,
    activeRunId,
    activeRunDetail,
    runDetailLoading,
    runDetailError,
    onSelectRun,
    onPauseRun,
    onResumeRun,
    onCancelRun,
    onDeleteRun,
    actionLoadingRunId,
    obsEngineFilter,
    onObsEngineFilterChange,
    obsMentionFilter,
    onObsMentionFilterChange,
    obsSentimentFilter,
    onObsSentimentFilterChange,
    onResetObsFilters,
    renderObservationAction,
  } = props;

  const marketEngines = useMemo(
    () => filterEnginesForMarket(engines, activeMarket),
    [engines, activeMarket],
  );
  const onlineEngineKeys = useMemo(
    () => marketEngines.filter((e) => e.available).map((e) => e.key),
    [marketEngines],
  );
  const validCheckedEngines = useMemo(() => {
    const onlineSet = new Set<VisibilityEngineKey>(onlineEngineKeys);
    return checkedEngines.filter((k) => onlineSet.has(k));
  }, [checkedEngines, onlineEngineKeys]);

  const parsedPrompts = useMemo(() => parsePromptLines(promptsText), [promptsText]);
  const promptCount = parsedPrompts.length;
  const checkedCount = validCheckedEngines.length;
  const unitPrice = VISIBILITY_DEFAULT_UNIT_POINTS;
  const estimatedPoints = promptCount * checkedCount * unitPrice;

  const lineSeedPrompts = useMemo(
    () =>
      activeProductLine
        ? readProductLineMarketSeedPrompts(activeProductLine.seedPromptsJson, activeMarket)
        : [],
    [activeProductLine, activeMarket],
  );
  const seedPrompts =
    lineSeedPrompts.length > 0 ? lineSeedPrompts : (activeBrandMarket?.seedPrompts ?? []);
  const SEED_PROMPT_COLLAPSE_LIMIT = 6;
  const [seedsExpanded, setSeedsExpanded] = useState(false);

  useEffect(() => {
    setSeedsExpanded(false);
  }, [activeBrandMarket?.id, activeProductLine?.id, activeMarket]);

  const visibleSeedPrompts =
    seedsExpanded || seedPrompts.length <= SEED_PROMPT_COLLAPSE_LIMIT
      ? seedPrompts
      : seedPrompts.slice(0, SEED_PROMPT_COLLAPSE_LIMIT);
  const hasCollapsedSeeds = seedPrompts.length > SEED_PROMPT_COLLAPSE_LIMIT;

  const handleToggleSeedPrompt = (seed: string) => {
    const existing = parsePromptLines(promptsText);
    const exists = existing.some((line) => line.toLowerCase() === seed.toLowerCase());
    if (exists) {
      const next = existing.filter((line) => line.toLowerCase() !== seed.toLowerCase());
      onPromptsTextChange(next.join('\n'));
    } else {
      onPromptsTextChange([...existing, seed].join('\n'));
    }
  };

  const handleFillAllSeeds = () => {
    if (seedPrompts.length === 0) return;
    const merged = parsePromptLines([promptsText, ...seedPrompts].filter(Boolean).join('\n'));
    onPromptsTextChange(merged.join('\n'));
  };

  const handleToggleEngine = (key: VisibilityEngineKey, available: boolean) => {
    if (!available || readOnly || submitting) return;
    if (validCheckedEngines.includes(key)) {
      onCheckedEnginesChange(validCheckedEngines.filter((k) => k !== key));
    } else {
      onCheckedEnginesChange([...validCheckedEngines, key]);
    }
  };

  const filteredObservations = useMemo(() => {
    const all = activeRunDetail?.observations ?? [];
    return all.filter((obs) => {
      if (obsEngineFilter && obs.engine !== obsEngineFilter) return false;
      if (obsMentionFilter === 'mentioned' && !obs.brandMentioned) return false;
      if (obsMentionFilter === 'unmentioned' && obs.brandMentioned) return false;
      if (obsSentimentFilter && obs.brandSentiment !== obsSentimentFilter) return false;
      return true;
    });
  }, [activeRunDetail?.observations, obsEngineFilter, obsMentionFilter, obsSentimentFilter]);

  const columns: ColumnsType<VisibilityRunRecord> = useMemo(
    () => [
      {
        title: '任务名称',
        dataIndex: 'name',
        key: 'name',
        width: 148,
        ellipsis: true,
        render: (_val, row) => {
          const safeTitle = sanitizeEntityTitleSegment(row.name, '监测任务');
          const isSelected = activeRunId === row.id;
          return (
            <div className="gm-vis-run-name-cell">
              <button
                type="button"
                className={`gm-vis-run-link${isSelected ? ' gm-vis-run-link-active' : ''}`}
                onClick={() => onSelectRun(row.id)}
              >
                <TruncText text={safeTitle} lines={1} />
              </button>
              {row.triggerType === 'RETEST' ? <StatusBadge tone="active" label="复测" /> : null}
            </div>
          );
        },
      },
      {
        title: '状态',
        dataIndex: 'status',
        key: 'status',
        width: 82,
        render: (status: TaskStatusName) => (
          <StatusBadge status={status} label={VISIBILITY_TASK_STATUS_LABELS[status] ?? status} />
        ),
      },
      {
        title: '引擎',
        dataIndex: 'engines',
        key: 'engines',
        width: 108,
        render: (engs: VisibilityEngineKey[]) => <EngineChipList engines={engs} max={2} />,
      },
      {
        title: '进度',
        key: 'progress',
        width: 58,
        render: (_v, row) => (
          <span className="gm-num">
            {row.doneCount}/{row.totalChecks}
          </span>
        ),
      },
      {
        title: '提及率',
        dataIndex: 'visibilityPct',
        key: 'visibilityPct',
        width: 64,
        render: (pct: number | null) => <span className="gm-num">{formatPct(pct)}</span>,
      },
      {
        title: '点数',
        key: 'points',
        width: 68,
        render: (_v, row) => (
          <span className="gm-num">
            {row.settledPoints ?? 0}/{row.frozenPoints ?? row.totalChecks * row.unitPrice}
          </span>
        ),
      },
      {
        title: '创建时间',
        dataIndex: 'createdAt',
        key: 'createdAt',
        width: 96,
        render: (iso: string) => (
          <span className="gm-num gm-vis-cell-time">{formatShanghaiDateTime(iso)}</span>
        ),
      },
      {
        title: '操作',
        key: 'actions',
        width: 164,
        render: (_v, row) => {
          const busy = actionLoadingRunId === row.id;
          const isActive =
            row.status === 'QUEUED' || row.status === 'RUNNING' || row.status === 'PAUSED';
          const secondary: RowActionItem[] = [];
          if (!readOnly && (row.status === 'QUEUED' || row.status === 'RUNNING')) {
            secondary.push({
              key: 'pause',
              label: '暂停',
              loading: busy,
              onClick: () => onPauseRun(row),
            });
          }
          if (!readOnly && row.status === 'PAUSED') {
            secondary.push({
              key: 'resume',
              label: '继续',
              loading: busy,
              onClick: () => onResumeRun(row),
            });
          }
          if (!readOnly && isActive) {
            secondary.push({
              key: 'cancel',
              label: '终止',
              danger: true,
              loading: busy,
              onClick: () => onCancelRun(row),
            });
          }
          if (!readOnly && !isActive) {
            secondary.push({
              key: 'delete',
              label: '删除',
              danger: true,
              loading: busy,
              onClick: () => onDeleteRun(row),
            });
          }

          return (
            <RowActions
              primary={{
                key: 'view',
                label: '查看',
                onClick: () => onSelectRun(row.id),
              }}
              secondary={secondary}
            />
          );
        },
      },
    ],
    [
      activeRunId,
      actionLoadingRunId,
      onCancelRun,
      onDeleteRun,
      onPauseRun,
      onResumeRun,
      onSelectRun,
      readOnly,
    ],
  );

  return (
    <div className="gm-vis-tab-stack">
      {/* 1. Create Monitor Run Panel */}
      <Section
        variant="card"
        className="gm-vis-create-panel"
        title="发起新一轮 AI 可见度监测"
        description={`当前市场：${activeMarket === 'CN' ? '中国国内（4 引擎）' : '海外市场（5 引擎）'} · 默认仅勾选已上线健康引擎`}
        actions={
          seedPrompts.length > 0 ? (
            <Button size="small" disabled={readOnly || submitting} onClick={handleFillAllSeeds}>
              一键填入全部种子问题（{seedPrompts.length}）
            </Button>
          ) : undefined
        }
      >
        <div className="gm-vis-form-row">
          <label className="gm-vis-field-label" htmlFor="vis-run-name-input">
            任务名称（选填）
          </label>
          <Input
            id="vis-run-name-input"
            value={runName}
            disabled={readOnly || submitting}
            maxLength={80}
            placeholder="例如：2026年Q4核心选购问句监测（留空自动生成）"
            onChange={(e) => onRunNameChange(e.target.value)}
          />
        </div>

        {seedPrompts.length > 0 ? (
          <div className="gm-vis-seed-bar">
            <div className="gm-vis-seed-head">
              <span className="gm-vis-seed-label">品牌高频种子问句：</span>
              {hasCollapsedSeeds ? (
                <button
                  type="button"
                  data-testid="vis-seed-toggle-btn"
                  className="gm-vis-seed-toggle"
                  onClick={() => setSeedsExpanded((prev) => !prev)}
                >
                  {seedsExpanded ? '收起' : `展开全部（${seedPrompts.length}）`}
                </button>
              ) : null}
            </div>
            <div className="gm-vis-seed-chips">
              {visibleSeedPrompts.map((seed) => {
                const selected = parsedPrompts.some(
                  (line) => line.toLowerCase() === seed.toLowerCase(),
                );
                return (
                  <button
                    key={seed}
                    type="button"
                    disabled={readOnly || submitting}
                    className={`gm-vis-seed-chip${selected ? ' gm-vis-seed-chip-active' : ''}`}
                    onClick={() => handleToggleSeedPrompt(seed)}
                  >
                    {selected ? '✓ ' : '+ '}
                    {seed}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="gm-vis-form-row">
          <div className="gm-vis-label-row">
            <label className="gm-vis-field-label" htmlFor="vis-prompts-textarea">
              监测问题列表（每行 1 条，至少 2 个字）
            </label>
            <span className="gm-vis-prompt-count gm-num">已识别 {promptCount} 条有效问题</span>
          </div>
          <Input.TextArea
            id="vis-prompts-textarea"
            aria-label="监测问题列表"
            rows={4}
            value={promptsText}
            disabled={readOnly || submitting}
            placeholder={
              activeMarket === 'CN'
                ? '每行输入 1 条中文监测问题，至少 2 个字…'
                : 'Enter one English monitoring prompt per line…'
            }
            onChange={(e) => onPromptsTextChange(e.target.value)}
          />
        </div>

        {/* Market-Isolated Engine Checklist */}
        <div className="gm-vis-form-row">
          <div className="gm-vis-label-row">
            <span className="gm-vis-field-label">
              选择 AI 引擎（已选 <span className="gm-num">{checkedCount}</span> / 在线{' '}
              <span className="gm-num">{onlineEngineKeys.length}</span> / 共{' '}
              <span className="gm-num">{marketEngines.length}</span>）
            </span>
            <Space size={8}>
              <Button
                size="small"
                type="link"
                disabled={readOnly || submitting || onlineEngineKeys.length === 0}
                onClick={() => onCheckedEnginesChange([...onlineEngineKeys])}
              >
                全选已上线引擎
              </Button>
              <Button
                size="small"
                type="link"
                disabled={readOnly || submitting || checkedCount === 0}
                onClick={() => onCheckedEnginesChange([])}
              >
                清空选择
              </Button>
            </Space>
          </div>

          {enginesError ? (
            <SignalError message={enginesError} onRetry={onRetryEngines} />
          ) : enginesLoading && marketEngines.length === 0 ? (
            <SignalSkeleton variant="block" height={96} />
          ) : (
            <div className="gm-vis-engine-grid">
              {marketEngines.map((eng) => {
                const isChecked = eng.available && validCheckedEngines.includes(eng.key);
                const cardClass = [
                  'gm-engine-card',
                  isChecked ? 'gm-engine-card-checked' : '',
                  !eng.available ? 'gm-engine-card-offline' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                const card = (
                  <label
                    key={eng.key}
                    data-testid={`engine-option-${eng.key}`}
                    data-engine-status={eng.available ? 'online' : 'offline'}
                    className={cardClass}
                  >
                    <Checkbox
                      checked={isChecked}
                      disabled={!eng.available || readOnly || submitting}
                      onChange={() => handleToggleEngine(eng.key, eng.available)}
                    />
                    <span className="gm-vis-engine-label">{eng.label}</span>
                    {!eng.available ? <span className="gm-vis-offline-badge">暂未上线</span> : null}
                  </label>
                );

                return !eng.available ? (
                  <Tooltip key={eng.key} title="该引擎暂未上线，默认不勾选且不消耗点数">
                    {card}
                  </Tooltip>
                ) : (
                  card
                );
              })}
            </div>
          )}
        </div>

        {submitError ? (
          <Alert type="error" showIcon message={submitError} className="gm-vis-alert" />
        ) : null}

        <div className="gm-vis-submit-bar">
          <div className="gm-vis-cost-hint">
            预计预冻 <strong className="gm-num">{estimatedPoints}</strong> 点（
            <span className="gm-num">{promptCount}</span> 问 ×{' '}
            <span className="gm-num">{checkedCount}</span> 引擎 ×{' '}
            <span className="gm-num">{unitPrice}</span> 点/次；超时或未上线项自动全额退还）
          </div>
          <Button
            type="primary"
            loading={submitting}
            disabled={readOnly || promptCount === 0 || checkedCount === 0}
            onClick={onSubmitRun}
          >
            发起监测（{estimatedPoints} 点）
          </Button>
        </div>
      </Section>

      {/* 2. Runs List Table (Zero Overflow at 1440x900 & 1280x800) */}
      <Section
        variant="card"
        title="监测任务记录"
        actions={
          <div className="gm-vis-runs-filters">
            <select
              aria-label="按状态筛选监测任务"
              className="gm-vis-native-select"
              value={statusFilter}
              onChange={(e) => onStatusFilterChange(e.target.value as TaskStatusName | '')}
            >
              <option value="">全部状态</option>
              {TASK_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {VISIBILITY_TASK_STATUS_LABELS[st]}
                </option>
              ))}
            </select>
            <Input.Search
              allowClear
              size="small"
              className="gm-vis-search-input"
              placeholder="按任务名称筛选"
              value={keywordFilter}
              onChange={(e) => onKeywordFilterChange(e.target.value)}
              onSearch={onKeywordFilterChange}
            />
            <Button size="small" onClick={onRefreshRuns}>
              刷新
            </Button>
          </div>
        }
      >
        {runsError ? (
          <SignalError message={runsError} onRetry={onRefreshRuns} />
        ) : runsLoading && runs.length === 0 ? (
          <SignalSkeleton variant="row" rows={5} />
        ) : runs.length === 0 ? (
          <EmptyState
            size="compact"
            title="当前市场暂无监测任务"
            description="在上方输入监测问题并勾选已上线引擎，即可发起首次 AI 可见度监测"
          />
        ) : (
          <div className="gm-vis-table-wrap">
            <Table<VisibilityRunRecord>
              rowKey="id"
              size="small"
              tableLayout="fixed"
              loading={runsLoading}
              columns={columns}
              dataSource={[...runs]}
              rowClassName={(row) => (row.id === activeRunId ? 'gm-vis-row-selected' : '')}
              pagination={{
                current: runsPage,
                pageSize: runsPageSize,
                total: runsTotal,
                showSizeChanger: false,
                onChange: onPageChange,
              }}
            />
          </div>
        )}
      </Section>

      {/* 3. Selected Run Workspace & Answer Lens */}
      {activeRunId ? (
        <Section variant="card" className="gm-vis-detail-panel">
          {runDetailError && !activeRunDetail ? (
            <div className="gm-vis-detail-error">
              <SignalError message={runDetailError} onRetry={() => onSelectRun(activeRunId)} />
            </div>
          ) : (
            <RunWorkspace
              run={activeRunDetail}
              loading={runDetailLoading}
              brandMarket={activeBrandMarket}
              renderObservationAction={renderObservationAction}
              obsEngineFilter={obsEngineFilter}
              onObsEngineFilterChange={onObsEngineFilterChange}
              obsMentionFilter={obsMentionFilter}
              onObsMentionFilterChange={onObsMentionFilterChange}
              obsSentimentFilter={obsSentimentFilter}
              onObsSentimentFilterChange={onObsSentimentFilterChange}
              filteredObservations={filteredObservations}
              onResetFilters={onResetObsFilters}
            />
          )}
        </Section>
      ) : null}
    </div>
  );
}
