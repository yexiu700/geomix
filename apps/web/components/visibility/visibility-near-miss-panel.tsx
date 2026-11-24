'use client';

import {
  NEAR_MISS_TIERS,
  NEAR_MISS_TIER_LABELS,
  formatShanghaiDateTime,
  isSafeDistributionHttpUrl,
  type CreateNearMissBoostBriefInput,
  type GeoMarket,
  type NearMissItemDto,
  type NearMissListResponse,
  type NearMissTier,
} from '@geomix/shared';
import { Alert, Button, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { JSX } from 'react';
import { useMemo } from 'react';
import { GM, truncateMiddle } from '../../lib/design-tokens';
import {
  EngineChipList,
  SignalEmpty,
  SignalError,
  SignalPill,
  SignalSkeleton,
  SourceKindChip,
  TruncText,
  type SignalTone,
} from '../geo/primitives';

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
};

const TIER_TONE_MAP: Record<NearMissTier, SignalTone> = {
  OPENED_NOT_CITED: 'danger',
  RETRIEVED_NOT_CITED: 'warning',
  CRAWLED_NOT_CITED: 'info',
  MENTIONED_NOT_OWNED: 'competitor',
};

const OWNERSHIP_OPTIONS: ReadonlyArray<{ value: NearMissOwnershipFilter; label: string }> = [
  { value: 'ALL', label: '全部信源' },
  { value: 'OWNED', label: '自有官网' },
  { value: 'THIRD_PARTY', label: '第三方信源' },
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
}: VisibilityNearMissPanelProps): JSX.Element {
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
        title: '分层与机会分',
        key: 'tier',
        width: 148,
        render: (_v, row) => {
          const score = Number.isFinite(row.opportunityScore)
            ? Math.round(row.opportunityScore)
            : 0;
          const opened = Number.isFinite(row.openedCount) ? row.openedCount : 0;
          const retrieved = Number.isFinite(row.retrievedCount) ? row.retrievedCount : 0;
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <div>
                <SignalPill tone={TIER_TONE_MAP[row.tier]}>
                  {NEAR_MISS_TIER_LABELS[row.tier]}
                </SignalPill>
              </div>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: GM.fg.f2,
                }}
              >
                <span className="gm-num" style={{ color: GM.phosphor, fontWeight: 600 }}>
                  机会分 {score}
                </span>
                {opened > 0 ? <span className="gm-num">点开 {opened} 次</span> : null}
                {retrieved > 0 ? <span className="gm-num">召回 {retrieved} 次</span> : null}
              </div>
            </div>
          );
        },
      },
      {
        title: '候选页面与目标问题',
        key: 'page',
        ellipsis: true,
        render: (_v, row) => {
          const trimmedUrl = row.url?.trim() ?? '';
          const safeUrl = trimmedUrl && isSafeDistributionHttpUrl(trimmedUrl) ? trimmedUrl : null;
          const heading = row.title?.trim() || row.domain?.trim() || row.prompts[0] || '待补强页面';
          const primaryPrompt = row.prompts[0]?.trim() || null;
          return (
            <div className="gm-vis-cite-cell" style={{ gap: 4 }}>
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
                <div style={{ fontSize: 12, color: GM.fg.f2 }}>
                  <TruncText text={`关联问题：${primaryPrompt}`} lines={1} />
                </div>
              ) : null}
              {row.snippet ? (
                <div style={{ fontSize: 11.5, color: GM.fg.f3 }}>
                  <TruncText text={row.snippet} lines={1} />
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        title: '信源归属',
        key: 'sourceKind',
        width: 92,
        render: (_v, row) => (
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}
          >
            <SourceKindChip kind={row.sourceKind} />
            <Tag
              color={row.isOwned ? 'cyan' : 'default'}
              style={{ margin: 0, fontSize: 11, lineHeight: '18px' }}
            >
              {row.isOwned ? '自有官网' : '第三方信源'}
            </Tag>
          </div>
        ),
      },
      {
        title: '涉及引擎与最近出现',
        key: 'engines',
        width: 120,
        render: (_v, row) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            {row.engines.length > 0 ? (
              <EngineChipList engines={row.engines} max={2} />
            ) : (
              <span style={{ color: GM.fg.f3, fontSize: 12 }}>—</span>
            )}
            <span className="gm-num" style={{ fontSize: 11.5, color: GM.fg.f3 }}>
              {formatShanghaiDateTime(row.lastSeenAt)}
            </span>
          </div>
        ),
      },
      {
        title: '补强动作',
        key: 'actions',
        width: 144,
        render: (_v, row) => (
          <Button
            size="small"
            type="primary"
            data-testid={`near-miss-boost-btn-${row.id}`}
            disabled={readOnly || boostingItemId !== null}
            loading={boostingItemId === row.id}
            style={{ whiteSpace: 'nowrap' }}
            onClick={() => onBoostItem(row)}
          >
            一键生成补强意见卡
          </Button>
        ),
      },
    ],
    [boostingItemId, onBoostItem, readOnly],
  );

  return (
    <section
      className="gm-panel"
      aria-label="差一步被引用（Near-Miss）"
      data-testid="visibility-near-miss-panel"
      style={{ minWidth: 0 }}
    >
      <div className="gm-vis-panel-head">
        <div>
          <div className="gm-vis-panel-title">差一步被引用（Near-Miss）</div>
          <div className="gm-vis-panel-sub">
            按 4 层双信号挖掘已进入 AI
            候选池或已可抓取但尚未进入正式引文的高潜页面，一键生成补强意见卡直达写作台
          </div>
        </div>

        <div
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}
          role="group"
          aria-label="按归属筛选 Near-Miss 机会"
        >
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
        </div>
      </div>

      {/* 4-tier filter pills */}
      <div
        className="gm-vis-source-pills"
        role="group"
        aria-label="按 Near-Miss 分层筛选"
        style={{ marginBottom: 12 }}
      >
        <button
          type="button"
          data-testid="near-miss-tier-ALL"
          className={`gm-source-pill-btn${!tierFilter ? ' gm-source-pill-btn-active' : ''}`}
          onClick={() => onTierFilterChange(undefined)}
        >
          <span>全部分层</span>
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
            <SignalPill tone={TIER_TONE_MAP[tier]}>{NEAR_MISS_TIER_LABELS[tier]}</SignalPill>
            <span className="gm-num">{displayTierCounts[tier]}</span>
          </button>
        ))}
      </div>

      {/* Day-1 fallback hint when raw retrieval signals are not yet captured */}
      {data && data.hasRawRetrievalSignals === false ? (
        <Alert
          type="info"
          showIcon
          data-testid="near-miss-fallback-hint"
          style={{ marginBottom: 12 }}
          message="当前窗口暂未捕获原生检索候选信号（Tier 1 / Tier 2）"
          description="运行支持联网检索候选回传的引擎后，将自动点亮「AI 点开未引用」与「AI 召回未引用」；下方 Tier 3A（可抓取未进引文）与 Tier 3B（提及未引官网）机会已可立即补强。"
        />
      ) : null}

      {error ? (
        <SignalError message={error} onRetry={onRetry} />
      ) : loading && !data ? (
        <SignalSkeleton variant="row" rows={4} />
      ) : visibleItems.length === 0 ? (
        <SignalEmpty
          title="暂无差一步被引用机会"
          description={
            tierFilter || ownershipFilter !== 'ALL'
              ? '当前筛选条件下暂无命中项，可切换其他分层或归属条件查看。'
              : '完成 AI 可见度监测或发布并完成抓取体检后，系统将自动识别差一步被引用的高潜页面。'
          }
          actionText={tierFilter || ownershipFilter !== 'ALL' ? '重置 Near-Miss 筛选' : undefined}
          onAction={
            tierFilter || ownershipFilter !== 'ALL'
              ? () => {
                  if (onResetFilters) {
                    onResetFilters();
                  } else {
                    onTierFilterChange(undefined);
                    onOwnershipFilterChange('ALL');
                  }
                }
              : undefined
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
    </section>
  );
}
