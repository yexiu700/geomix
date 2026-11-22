'use client';

import {
  GEO_SCORE_DIMENSION_KEYS,
  type GeoArticleRecord,
  type GeoEvaluationResult,
  type GeoScoreDetail,
} from '@geomix/shared';
import { Button, Tag } from 'antd';
import type { JSX } from 'react';

export type StudioGeoEvaluatorProps = {
  article: GeoArticleRecord | null;
  evaluation: GeoEvaluationResult | null;
  evaluating: boolean;
  supplementingTerm: string | null;
  readOnly: boolean;
  streaming: boolean;
  onRefreshEvaluate: () => Promise<void>;
  onSupplementFanOut: (term: string) => Promise<void>;
};

function readScoreDetail(
  article: GeoArticleRecord | null,
  evaluation: GeoEvaluationResult | null,
): GeoScoreDetail | null {
  if (evaluation?.geoScoreDetail) return evaluation.geoScoreDetail;
  const raw = article?.geoScoreDetail;
  if (!raw || typeof raw !== 'object' || !('dimensions' in raw)) return null;
  const dims = (raw as { dimensions?: unknown }).dimensions;
  if (!dims || typeof dims !== 'object') return null;
  return raw as unknown as GeoScoreDetail;
}

export function StudioGeoEvaluator({
  article,
  evaluation,
  evaluating,
  supplementingTerm,
  readOnly,
  streaming,
  onRefreshEvaluate,
  onSupplementFanOut,
}: StudioGeoEvaluatorProps): JSX.Element {
  const detail = readScoreDetail(article, evaluation);
  const coveredFanOuts = detail?.coveredFanOuts ?? [];
  const missingFanOuts = evaluation?.uncoveredFanOuts ?? detail?.missingFanOuts ?? [];

  const hints: Array<{ key: string; label: string; hint: string }> = [];
  if (detail) {
    for (const key of GEO_SCORE_DIMENSION_KEYS) {
      const dim = detail.dimensions[key];
      if (dim && !dim.passed && dim.hints.length > 0) {
        hints.push({ key, label: dim.label, hint: dim.hints[0]! });
      }
    }
  }

  return (
    <div className="gm-studio-eval-slot" data-testid="studio-geo-evaluator">
      <div className="gm-studio-eval-actions">
        <Button
          size="small"
          data-testid="geo-evaluate-refresh-btn"
          loading={evaluating}
          disabled={!article || streaming || readOnly}
          onClick={() => void onRefreshEvaluate()}
        >
          实时刷新体检
        </Button>
        <span className="gm-studio-eval-free-note">免费诊断</span>
      </div>

      {hints.length > 0 ? (
        <ul className="gm-studio-eval-hints" aria-label="GEO 提分建议">
          {hints.map((item) => (
            <li key={item.key} className="gm-studio-eval-hint-item">
              <strong>{item.label}：</strong>
              <span>{item.hint}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {coveredFanOuts.length > 0 || missingFanOuts.length > 0 ? (
        <div className="gm-studio-fanout-box" data-testid="studio-fanout-coverage">
          <span className="gm-studio-section-label">
            Fan-Out 拆解词覆盖（{coveredFanOuts.length} /{' '}
            {coveredFanOuts.length + missingFanOuts.length}）
          </span>

          {coveredFanOuts.length > 0 ? (
            <div className="gm-studio-chip-group">
              {coveredFanOuts.map((term) => (
                <Tag
                  key={term}
                  color="green"
                  style={{
                    margin: 0,
                    maxWidth: '100%',
                    whiteSpace: 'normal',
                    overflowWrap: 'anywhere',
                  }}
                >
                  ✓ {term}
                </Tag>
              ))}
            </div>
          ) : null}

          {missingFanOuts.length > 0 ? (
            <div className="gm-studio-fanout-list">
              {missingFanOuts.map((term) => (
                <div key={term} className="gm-studio-fanout-row">
                  <span className="gm-studio-fanout-term">{term}</span>
                  <Button
                    size="small"
                    type="link"
                    style={{ padding: '0 4px', height: 'auto', flexShrink: 0 }}
                    data-testid="fanout-supplement-btn"
                    aria-label={`一键补写小节-${term}`}
                    loading={supplementingTerm === term}
                    disabled={
                      !article ||
                      readOnly ||
                      streaming ||
                      (Boolean(supplementingTerm) && supplementingTerm !== term)
                    }
                    onClick={() => void onSupplementFanOut(term)}
                  >
                    一键补写小节
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
