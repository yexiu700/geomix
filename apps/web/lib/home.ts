import type { ActionHomeResponse, GeoMarket, RetestMetricSnapshot } from '@geomix/shared';
import { authorizedV2Request } from './api';
import type { SessionStorageLike } from './session';

export type HomeClientOptions = {
  storage?: SessionStorageLike;
  signal?: AbortSignal;
};

export function fetchActionHome(
  brandId: string,
  market: GeoMarket,
  options?: HomeClientOptions,
): Promise<ActionHomeResponse> {
  const qs = new URLSearchParams({ market });
  return authorizedV2Request<ActionHomeResponse>(
    `/brands/${encodeURIComponent(brandId)}/home?${qs.toString()}`,
    {
      method: 'GET',
      storage: options?.storage,
      signal: options?.signal,
    },
  );
}

export type RetestDeltaSummary = {
  tone: 'cited' | 'info' | 'warning' | 'neutral';
  mentionLabel: string;
  positionLabel: string;
  citationLabel: string;
  sentimentLabel: string;
  compactBadge: string;
};

function formatPctValue(val: number): string {
  const rounded = Math.round(val * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

function formatPositionValue(pos: number | null): string {
  if (pos === null || !Number.isFinite(pos)) return '未上榜';
  const rounded = Math.round(pos * 10) / 10;
  return `#${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}`;
}

const SENTIMENT_CN: Record<string, string> = {
  positive: '正面',
  neutral: '中性',
  mixed: '褒贬参半',
  negative: '负面',
};

function formatSentimentValue(sentiment: string | null): string {
  if (!sentiment) return '—';
  return SENTIMENT_CN[sentiment] ?? sentiment;
}

export function formatRetestDeltaSummary(
  before: RetestMetricSnapshot | null,
  after: RetestMetricSnapshot | null,
): RetestDeltaSummary {
  if (!after) {
    if (!before) {
      return {
        tone: 'neutral',
        mentionLabel: '暂无基线',
        positionLabel: '未上榜',
        citationLabel: '待复测',
        sentimentLabel: '—',
        compactBadge: '已登记发布 · 待复测',
      };
    }
    return {
      tone: 'neutral',
      mentionLabel: `发布前 ${formatPctValue(before.mentionRate)}`,
      positionLabel: `发布前 ${formatPositionValue(before.avgPosition)}`,
      citationLabel: before.citationHit ? '发布前已引用' : '发布前未引用',
      sentimentLabel: formatSentimentValue(before.sentiment),
      compactBadge: `发布前 ${formatPctValue(before.mentionRate)} · 待复测`,
    };
  }

  const beforeMention = before ? formatPctValue(before.mentionRate) : '—';
  const afterMention = formatPctValue(after.mentionRate);
  const mentionDelta = before
    ? Math.round((after.mentionRate - before.mentionRate) * 10) / 10
    : null;
  const mentionDeltaText =
    mentionDelta !== null && mentionDelta !== 0
      ? ` (${mentionDelta > 0 ? '+' : ''}${mentionDelta}%)`
      : '';

  const beforePos = before ? formatPositionValue(before.avgPosition) : '—';
  const afterPos = formatPositionValue(after.avgPosition);

  const beforeCite = before ? (before.citationHit ? '已引用' : '未引用') : '—';
  const afterCite = after.citationHit ? '已进入引用' : '未引用';

  const beforeSent = before ? formatSentimentValue(before.sentiment) : '—';
  const afterSent = formatSentimentValue(after.sentiment);

  const improvedMention = before !== null && after.mentionRate > before.mentionRate;
  const improvedPos =
    after.avgPosition !== null &&
    (before === null || before.avgPosition === null || after.avgPosition < before.avgPosition);
  const improvedCite = after.citationHit && (!before || !before.citationHit);
  const regressed =
    before !== null && after.mentionRate < before.mentionRate && !improvedPos && !improvedCite;

  let tone: RetestDeltaSummary['tone'] = 'info';
  if (improvedMention || improvedPos || improvedCite || after.mentionRate >= 80) {
    tone = 'cited';
  } else if (regressed) {
    tone = 'warning';
  }

  return {
    tone,
    mentionLabel: `${beforeMention} → ${afterMention}${mentionDeltaText}`,
    positionLabel: `${beforePos} → ${afterPos}`,
    citationLabel: `${beforeCite} → ${afterCite}`,
    sentimentLabel: `${beforeSent} → ${afterSent}`,
    compactBadge: `发布前 ${beforeMention} → 发布后 ${afterMention}${after.citationHit ? ' · 已引用' : ''}`,
  };
}
