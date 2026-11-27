'use client';

import {
  NEAR_MISS_TIERS,
  formatShanghaiDateTime,
  isSafeDistributionHttpUrl,
  type CreateNearMissBoostBriefInput,
  type GeoMarket,
  type NearMissItemDto,
  type NearMissListResponse,
  type NearMissTier,
} from '@geomix/shared';
import { Alert, Button, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { truncateMiddle } from '../../lib/design-tokens';
import { NEAR_MISS_TIER_SHORT } from '../../lib/short-labels';
import {
  EngineChipList,
  SignalError,
  SignalSkeleton,
  SourceKindChip,
  TruncText,
} from '../geo/primitives';
import { EmptyState, Explain, RowActions, Section, StatusBadge, type StatusTone } from '../ui';

export type NearMissOwnershipFilter = 'ALL' | 'OWNED' | 'THIRD_PARTY';

export type VisibilityNearMissPanelProps = {
  data: NearMissListResponse | null;
  loading: boolean;
  error: string | null;
  tierFilter: NearMissTier | undefined;
  onTierFilterChange: (tier: NearMissTier | undefined) => void;
  ownershipFilter: NearMissOwnershipFilter;
  onOwnershipFilterChange: (next: NearMissOwnershipFilter) => void;
  onResetFilters?: () => void;
  onRetry: () => void;
  readOnly: boolean;
  boostingItemId: string | null;
  onBoostItem: (item: NearMissItemDto) => void;
  defaultExpanded?: boolean;
};

const TIER_TONE_MAP: Record<NearMissTier, StatusTone> = {
  OPENED_NOT_CITED: 'danger',
  RETRIEVED_NOT_CITED: 'warning',
  CRAWLED_NOT_CITED: 'active',
  MENTIONED_NOT_OWNED: 'neutral',
};

const OWNERSHIP_OPTIONS: ReadonlyArray<{ value: NearMissOwnershipFilter; label: string }> = [
  { value: 'ALL', label: '全部' },
  { value: 'OWNED', label: '自有' },
  { value: 'THIRD_PARTY', label: '第三方' },
];

function normalizeBoostPromptCandidate(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 300).trim();
}

/**
 * Derive a schema-safe POST /briefs/from-near-miss payload from a NearMissItemDto.
 * Strictly aligned with createNearMissBoostBriefSchema:
 * - targetPrompt length in [2, 300] after whitespace normalization & trim
 * - sourceUrl validated by isSafeDistributionHttpUrl (http/https, <=2048, no credentials/whitespace)
 * - sourceTitle trimmed <=200 chars, observationIds trimmed <=64 chars & <=50 items
 */
export function buildNearMissBoostInput(
  item: NearMissItemDto,
  market: GeoMarket,
): CreateNearMissBoostBriefInput {
  const firstPrompt = item.prompts
    .map((p) => normalizeBoostPromptCandidate(p))
    .find((p) => p.length >= 2);
  const titleCandidate = item.title?.trim() ?? '';
  const titlePrompt = normalizeBoostPromptCandidate(titleCandidate);
  const domainCandidate = (item.domain ?? '').replace(/\s+/g, ' ').trim();
  const domainPrompt = domainCandidate
    ? normalizeBoostPromptCandidate(`${domainCandidate} 补强优化`)
    : '';
  const normalizedPrompt =
    firstPrompt ||
    (titlePrompt.length >= 2 ? titlePrompt : '') ||
    (domainPrompt.length >= 2 ? domainPrompt : '');

  const safePrompt = normalizedPrompt.length >= 2 ? normalizedPrompt : '高潜页面引用补强';
  const trimmedUrl = item.url?.trim() ?? '';
  const safeUrl = trimmedUrl && isSafeDistributionHttpUrl(trimmedUrl) ? trimmedUrl : undefined;
  const safeTitle = titleCandidate.slice(0, 200).trim() || undefined;
  const validObsIds = item.observationIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && id.length <= 64)
    .slice(0, 50);

  return {
    market,
    tier: item.tier,
    targetPrompt: safePrompt,
    ...(safeUrl ? { sourceUrl: safeUrl } : {}),
    ...(safeTitle ? { sourceTitle: safeTitle } : {}),
    ...(validObsIds.length > 0 ? { observationIds: validObsIds } : {}),
  };
}

function createEmptyTierCounts(): Record<NearMissTier, number> {
  return {
    OPENED_NOT_CITED: 0,
    RETRIEVED_NOT_CITED: 0,
    CRAWLED_NOT_CITED: 0,
    MENTIONED_NOT_OWNED: 0,
  };
}

export function VisibilityNearMissPanel({
  data,
  loading,
  error,
  tierFilter,
  onTierFilterChange,
  ownershipFilter,
  onOwnershipFilterChange,
  onResetFilters,
  onRetry,
  readOnly,
  boostingItemId,
  onBoostItem,
  defaultExpanded = false,
}: VisibilityNearMissPanelProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const { visibleItems, displayTierCounts, totalCount } = useMemo(() => {
    const rawItems = data?.items ?? [];

    if (ownershipFilter === 'THIRD_PARTY') {
      const nonOwned = rawItems.filter((item) => !item.isOwned);
      const counts = createEmptyTierCounts();
      for (const item of nonOwned) {
        counts[item.tier] = (counts[item.tier] ?? 0) + 1;
      }
      const filtered = tierFilter ? nonOwned.filter((item) => item.tier === tierFilter) : nonOwned;
      return {
        visibleItems: filtered,
        displayTierCounts: counts,
        totalCount: nonOwned.length,
      };
    }

    const ownershipFiltered =
      ownershipFilter === 'OWNED' ? rawItems.filter((item) => item.isOwned) : rawItems;

    const serverCounts = data?.tierCounts;
    const counts = createEmptyTierCounts();
    if (serverCounts) {
      for (const tier of NEAR_MISS_TIERS) {
        const val = serverCounts[tier];
        counts[tier] = typeof val === 'number' && Number.isFinite(val) ? val : 0;
      }
    } else {
      for (const item of ownershipFiltered) {
        counts[item.tier] = (counts[item.tier] ?? 0) + 1;
      }
    }

    const total = NEAR_MISS_TIERS.reduce((sum, tier) => sum + counts[tier], 0);
    const filtered = tierFilter
      ? ownershipFiltered.filter((item) => item.tier === tierFilter)
      : ownershipFiltered;

    return {
      visibleItems: filtered,
      displayTierCounts: counts,
      totalCount: total,
    };
  }, [data, ownershipFilter, tierFilter]);

  const columns: ColumnsType<NearMissItemDto> = useMemo(
    () => [
      {
        title: '分层',
        key: 'tier',
        width: 152,
        render: (_v, row) => {
          const score = Number.isFinite(row.opportunityScore)
            ? Math.round(row.opportunityScore)
            : 0;
          const opened = Number.isFinite(row.openedCount) ? row.openedCount : 0;
          const retrieved = Number.isFinite(row.retrievedCount) ? row.retrievedCount : 0;
          return (
            <div className="gm-nm-tier-cell">
              <div>
                <StatusBadge
                  tone={TIER_TONE_MAP[row.tier]}
                  label={NEAR_MISS_TIER_SHORT[row.tier]}
                />
              </div>
              <div className="gm-nm-score-meta">
                <span className="gm-num gm-nm-score-val">机会分 {score}</span>
                {opened > 0 ? <span className="gm-num">点开 {opened} 次</span> : null}
                {retrieved > 0 ? <span className="gm-num">召回 {retrieved} 次</span> : null}
              </div>
            </div>
          );
        },
      },
      {
        title: '候选页',
        key: 'page',
        ellipsis: true,
        render: (_v, row) => {
          const trimmedUrl = row.url?.trim() ?? '';
          const safeUrl = trimmedUrl && isSafeDistributionHttpUrl(trimmedUrl) ? trimmedUrl : null;
          const heading = row.title?.trim() || row.domain?.trim() || row.prompts[0] || '待补强页面';
          const primaryPrompt = row.prompts[0]?.trim() || null;
          return (
            <div className="gm-vis-cite-cell gm-nm-page-cell">
              <div className="gm-clamp-1 gm-vis-cite-title" title={heading}>
                {heading}
              </div>
              {safeUrl ? (
                <a
                  href={safeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gm-mono gm-vis-cite-link"
                  title={safeUrl}
                >
                  {truncateMiddle(safeUrl, 52)}
                </a>
              ) : row.url ? (
                <span className="gm-mono gm-vis-cite-link-muted">
                  {truncateMiddle(row.url, 52)}
                </span>
              ) : null}
              {primaryPrompt ? (
                <div className="gm-nm-prompt">
                  <TruncText text={`关联问题：${primaryPrompt}`} lines={1} />
                </div>
              ) : null}
              {row.snippet ? (
                <div className="gm-nm-snippet">
                  <TruncText text={row.snippet} lines={1} />
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        title: '归属',
        key: 'sourceKind',
        width: 108,
        render: (_v, row) => (
          <div className="gm-nm-source-cell">
            <SourceKindChip kind={row.sourceKind} />
            <StatusBadge
              tone={row.isOwned ? 'success' : 'neutral'}
              label={row.isOwned ? '自有官网' : '第三方'}
            />
          </div>
        ),
      },
      {
        title: '引擎',
        key: 'engines',
        width: 124,
        render: (_v, row) => (
          <div className="gm-nm-engine-cell">
            {row.engines.length > 0 ? (
              <EngineChipList engines={row.engines} max={2} />
            ) : (
              <span className="gm-nm-muted">—</span>
            )}
            <span className="gm-num gm-nm-time">{formatShanghaiDateTime(row.lastSeenAt)}</span>
          </div>
        ),
      },
      {
        title: '操作',
        key: 'actions',
        width: 120,
        render: (_v, row) => (
          <RowActions
            primary={{
              key: 'boost',
              label: '补强',
              testId: `near-miss-boost-btn-${row.id}`,
              disabled: readOnly || boostingItemId !== null,
              loading: boostingItemId === row.id,
              onClick: () => onBoostItem(row),
            }}
          />
        ),
      },
    ],
    [boostingItemId, onBoostItem, readOnly],
  );

  const hasActiveFilters = Boolean(tierFilter) || ownershipFilter !== 'ALL';

  const handleReset = () => {
    if (onResetFilters) {
      onResetFilters();
    } else {
      onTierFilterChange(undefined);
      onOwnershipFilterChange('ALL');
    }
  };

  return (
    <Section
      variant="card"
      aria-label="差一步被引用（Near-Miss）"
      data-testid="visibility-near-miss-panel"
      title="候补机会"
      actions={
        <div className="gm-nm-ownership-group" role="group" aria-label="按归属筛选 Near-Miss 机会">
          {expanded ? (
            <>
              {OWNERSHIP_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`near-miss-ownership-${opt.value}`}
                  className={`gm-source-pill-btn${
                    ownershipFilter === opt.value ? ' gm-source-pill-btn-active' : ''
                  }`}
                  onClick={() => onOwnershipFilterChange(opt.value)}
                >
                  <span>{opt.label}</span>
                </button>
              ))}
              <Explain text="按 4 层双信号挖掘已进入 AI 候选池或可抓取但尚未进入正式引文的高潜页面，一键生成补强意见卡。" />
              <Button
                size="small"
                type="text"
                autoInsertSpace={false}
                data-testid="near-miss-collapse-toggle"
                aria-expanded={true}
                onClick={() => setExpanded(false)}
              >
                收起
              </Button>
            </>
          ) : (
            <>
              <span className="gm-num gm-vis-count-muted">{totalCount} 条</span>
              <Explain text="差一步被引用（Near-Miss）高潜页面机会，展开后可按 4 层信号筛选并一键生成补强意见。" />
              <Button
                size="small"
                type="text"
                autoInsertSpace={false}
                data-testid="near-miss-collapse-toggle"
                aria-expanded={false}
                onClick={() => setExpanded(true)}
              >
                展开
              </Button>
            </>
          )}
        </div>
      }
    >
      {expanded ? (
        <>
          {/* 4-tier filter pills */}
          <div className="gm-vis-source-pills" role="group" aria-label="按 Near-Miss 分层筛选">
            <button
              type="button"
              data-testid="near-miss-tier-ALL"
              className={`gm-source-pill-btn${!tierFilter ? ' gm-source-pill-btn-active' : ''}`}
              onClick={() => onTierFilterChange(undefined)}
            >
              <span>全部</span>
              <span className="gm-num">{totalCount}</span>
            </button>
            {NEAR_MISS_TIERS.map((tier) => (
              <button
                key={tier}
                type="button"
                data-testid={`near-miss-tier-${tier}`}
                className={`gm-source-pill-btn${
                  tierFilter === tier ? ' gm-source-pill-btn-active' : ''
                }`}
                onClick={() => onTierFilterChange(tierFilter === tier ? undefined : tier)}
              >
                <StatusBadge tone={TIER_TONE_MAP[tier]} label={NEAR_MISS_TIER_SHORT[tier]} />
                <span className="gm-num">{displayTierCounts[tier]}</span>
              </button>
            ))}
          </div>

          {/* Day-1 fallback hint when raw retrieval signals are not yet captured */}
          {data && data.hasRawRetrievalSignals === false ? (
            <Alert
              type="info"
              showIcon
              className="gm-nm-fallback-alert"
              data-testid="near-miss-fallback-hint"
              message={
                <span className="gm-vis-alert-row">
                  <span>暂缺原生信号</span>
                  <Explain text="当前窗口暂未捕获原生检索候选信号（Tier 1 / Tier 2）。运行支持联网检索候选回传的引擎后，将自动点亮「点开未引」与「召回未引」；下方 Tier 3A 与 Tier 3B 机会已可立即补强。" />
                </span>
              }
            />
          ) : null}

          {error ? (
            <SignalError message={error} onRetry={onRetry} />
          ) : loading && !data ? (
            <SignalSkeleton variant="row" rows={4} />
          ) : visibleItems.length === 0 ? (
            <EmptyState
              size="compact"
              title="暂无机会"
              description={
                hasActiveFilters
                  ? '当前筛选条件下暂无命中项，可切换其他分层或归属条件查看。'
                  : '完成 AI 可见度监测或发布并完成抓取体检后，系统将自动识别差一步被引用的高潜页面。'
              }
              action={
                hasActiveFilters ? (
                  <Button size="small" onClick={handleReset}>
                    重置筛选
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="gm-near-miss-table-wrap">
              <Table<NearMissItemDto>
                rowKey="id"
                size="small"
                tableLayout="fixed"
                loading={loading}
                columns={columns}
                dataSource={visibleItems}
                pagination={{ pageSize: 8, hideOnSinglePage: true }}
              />
            </div>
          )}
        </>
      ) : null}
    </Section>
  );
}
