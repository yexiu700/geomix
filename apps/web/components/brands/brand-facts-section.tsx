'use client';

import {
  BRAND_FACT_CARD_MAX,
  BRAND_FACT_FULL_INJECT_MAX,
  BRAND_FACT_SLOT_LABELS,
  BRAND_TRUTH_CHECKBOX_LABEL,
  formatShanghaiDateTime,
  requiresBrandFactVectorIndex,
  type BrandFactRecord,
  type BrandFactSlot,
  type BrandFactsResponse,
  type BrandMarketRecord,
  type BrandProductLineDto,
  type BrandRecord,
  type ExtractedBrandFactDraft,
  type FactIndexStatus,
  type FactSourceType,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Input, Select } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { extractBrandFacts, saveBrandFacts, type ExtractBrandFactsRequest } from '../../lib/brands';
import { BRAND_FACT_SLOT_SHORT, FACT_INDEX_STATUS_SHORT } from '../../lib/short-labels';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalError, SignalSkeleton } from '../geo/primitives';
import { CostChip, Explain, Section, StatusBadge } from '../ui';
import { BrandFactsExtractModal, type ExtractSourceMode } from './brand-facts-extract-modal';
import {
  CORE_FACT_SLOTS,
  FACT_SLOT_PLACEHOLDERS,
  FACT_SOURCE_LABELS,
  computeTotalFactChars,
  validateFactUploadFile,
} from './brand-form-helpers';
import { BrandTruthTermsModal } from './brand-truth-terms-modal';

type SlotDraft = {
  id?: string;
  slot: BrandFactSlot;
  productLineId: string | null;
  title: string;
  content: string;
  sourceType: FactSourceType;
  sourceUrl: string | null;
  indexStatus: FactIndexStatus;
  updatedAt: string | null;
};

const GENERAL_SCOPE_VALUE = '__BRAND_GENERAL__';

export type BrandFactsSectionProps = {
  brand: BrandRecord;
  activeBrandMarket: BrandMarketRecord | null;
  productLines?: readonly BrandProductLineDto[];
  facts: readonly BrandFactRecord[];
  loading: boolean;
  error: string | null;
  truthSignedAt: string | null;
  readOnly: boolean;
  demotePrimary?: boolean;
  onRetry: () => void;
  onFactsSaved: (response: BrandFactsResponse) => void;
};

function buildInitialDrafts(
  facts: readonly BrandFactRecord[],
  scopeId: string | null,
): Record<BrandFactSlot, SlotDraft> {
  const map = {} as Record<BrandFactSlot, SlotDraft>;
  const slots: readonly BrandFactSlot[] = [...CORE_FACT_SLOTS, 'EXTRA_DOC'];
  for (const slot of slots) {
    const matched = facts.find(
      (item) => item.slot === slot && (item.productLineId ?? null) === scopeId,
    );
    map[slot] = matched
      ? {
          id: matched.id,
          slot,
          productLineId: matched.productLineId ?? null,
          title: matched.title || BRAND_FACT_SLOT_LABELS[slot],
          content: matched.content,
          sourceType: matched.sourceType,
          sourceUrl: matched.sourceUrl,
          indexStatus: matched.indexStatus,
          updatedAt: matched.updatedAt,
        }
      : {
          slot,
          productLineId: scopeId,
          title: BRAND_FACT_SLOT_LABELS[slot],
          content: '',
          sourceType: 'MANUAL',
          sourceUrl: null,
          indexStatus: 'NONE',
          updatedAt: null,
        };
  }
  return map;
}

export function BrandFactsSection({
  brand,
  activeBrandMarket,
  productLines = [],
  facts,
  loading,
  error,
  truthSignedAt,
  readOnly,
  demotePrimary = false,
  onRetry,
  onFactsSaved,
}: BrandFactsSectionProps) {
  const feedback = useUxFeedback();
  const [selectedScopeId, setSelectedScopeId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<BrandFactSlot, SlotDraft>>(() =>
    buildInitialDrafts(facts, null),
  );
  const [extraDocOpen, setExtraDocOpen] = useState(false);
  const [truthAgreed, setTruthAgreed] = useState(Boolean(truthSignedAt));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [termsOpen, setTermsOpen] = useState(false);

  // AI Extract modal state
  const [extractModalOpen, setExtractModalOpen] = useState(false);
  const [extractMode, setExtractMode] = useState<ExtractSourceMode>('URL_EXTRACT');
  const [extractUrl, setExtractUrl] = useState('');
  const [extractText, setExtractText] = useState('');
  const [extractFile, setExtractFile] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractResult, setExtractResult] = useState<{
    sourceType: FactSourceType;
    sourceUrl: string | null;
    facts: ExtractedBrandFactDraft[];
    warnings?: string[];
  } | null>(null);
  const [applyMode, setApplyMode] = useState<'replace' | 'append'>('replace');

  const hasProductLines = productLines.length > 0;
  const lineNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const line of productLines) {
      map.set(line.id, line.name);
    }
    return map;
  }, [productLines]);

  const effectiveScopeId =
    selectedScopeId && lineNameById.has(selectedScopeId) ? selectedScopeId : null;

  useEffect(() => {
    if (selectedScopeId && !lineNameById.has(selectedScopeId)) {
      setSelectedScopeId(null);
    }
  }, [selectedScopeId, lineNameById]);

  useEffect(() => {
    setSelectedScopeId(null);
  }, [brand.id]);

  const factsSignature = facts
    .map((f) => `${f.id}:${f.productLineId ?? ''}:${f.updatedAt}:${f.indexStatus}`)
    .join('|');

  useEffect(() => {
    const next = buildInitialDrafts(facts, effectiveScopeId);
    setDrafts(next);
    if (next.EXTRA_DOC.content.trim().length > 0) {
      setExtraDocOpen(true);
    }
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand.id, effectiveScopeId, factsSignature]);

  useEffect(() => {
    setTruthAgreed(Boolean(truthSignedAt));
  }, [brand.id, truthSignedAt]);

  const openExtractModal = () => {
    setExtractError(null);
    setExtractResult(null);
    setExtractFile(null);
    setExtractText('');
    const firstDomain = activeBrandMarket?.ownedDomains[0];
    setExtractUrl(firstDomain ? `https://${firstDomain}` : '');
    setExtractMode('URL_EXTRACT');
    setApplyMode('replace');
    setExtractModalOpen(true);
  };

  const allSlots: readonly BrandFactSlot[] = [...CORE_FACT_SLOTS, 'EXTRA_DOC'];
  const totalChars = computeTotalFactChars(allSlots.map((slot) => drafts[slot]));
  const anyIndexing = allSlots.some((slot) => drafts[slot].indexStatus === 'INDEXING');
  const anyReady = allSlots.some((slot) => drafts[slot].indexStatus === 'READY');
  const anyFailed = allSlots.some((slot) => drafts[slot].indexStatus === 'FAILED');
  const needsVectorIndex =
    requiresBrandFactVectorIndex(totalChars) ||
    allSlots.some((slot) => requiresBrandFactVectorIndex(drafts[slot].content.length));

  const updateSlotField = (
    slot: BrandFactSlot,
    patch: Partial<
      Pick<SlotDraft, 'title' | 'content' | 'sourceType' | 'sourceUrl' | 'productLineId'>
    >,
  ) => {
    setDrafts((prev) => ({
      ...prev,
      [slot]: { ...prev[slot], ...patch },
    }));
  };

  const handleSaveFacts = async () => {
    setSaveError(null);
    if (!truthAgreed) {
      setSaveError('请先勾选真实性与合规承诺后再保存');
      return;
    }

    const candidates = allSlots
      .map((slot) => drafts[slot])
      .filter(
        (item) =>
          (item.slot !== 'EXTRA_DOC' &&
            (item.content.trim().length > 0 || Boolean(item.id) || !hasProductLines)) ||
          (item.slot === 'EXTRA_DOC' && (item.content.trim().length > 0 || Boolean(item.id))),
      );

    // Prevent accidental duplicate (slot, productLineId) collision when reassigning a card to another scope
    for (const item of candidates) {
      const targetScope = item.productLineId ?? null;
      if (targetScope !== effectiveScopeId) {
        const collision = facts.find(
          (existing) =>
            existing.slot === item.slot &&
            (existing.productLineId ?? null) === targetScope &&
            existing.id !== item.id,
        );
        if (collision) {
          const scopeLabel = targetScope
            ? (lineNameById.get(targetScope) ?? '目标产品线')
            : '品牌通用';
          setSaveError(
            `「${scopeLabel}」下已存在「${BRAND_FACT_SLOT_LABELS[item.slot]}」事实卡，请切换到对应范围直接编辑。`,
          );
          return;
        }
      }
    }

    const payloadFacts = candidates.map((item) => ({
      ...(item.id ? { id: item.id } : {}),
      slot: item.slot,
      title: item.title.trim() || BRAND_FACT_SLOT_LABELS[item.slot],
      content: item.content.trim(),
      sourceType: item.sourceType,
      sourceUrl: item.sourceUrl,
      ...(hasProductLines || item.productLineId !== null
        ? { productLineId: item.productLineId ?? null }
        : {}),
    }));

    if (payloadFacts.every((item) => item.content.length === 0)) {
      setSaveError('请至少填写一张事实卡内容后再保存');
      return;
    }

    setSaving(true);
    try {
      const saved = await saveBrandFacts(
        brand.id,
        {
          facts: payloadFacts,
          truthAgreed: true,
        },
        { storage: window.sessionStorage },
      );
      onFactsSaved(saved);
      feedback.notifySuccess('已保存品牌事实卡');
    } catch (reason: unknown) {
      const msg = reason instanceof Error && reason.message ? reason.message : '保存品牌事实卡失败';
      setSaveError(msg);
      feedback.notifyError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleRunExtract = async () => {
    setExtractError(null);

    let request: ExtractBrandFactsRequest;
    if (extractMode === 'URL_EXTRACT') {
      const url = extractUrl.trim();
      if (!url) {
        setExtractError('请填写有效的官网或产品详情页链接');
        return;
      }
      request = { sourceType: 'URL_EXTRACT', url };
    } else if (extractMode === 'MANUAL') {
      const rawText = extractText.trim();
      if (rawText.length < 10) {
        setExtractError('请至少粘贴 10 个字以上的产品资料');
        return;
      }
      request = { sourceType: 'MANUAL', rawText };
    } else {
      if (!extractFile) {
        setExtractError('请选择要上传的 TXT、MD 或 PDF 文档');
        return;
      }
      const checked = validateFactUploadFile(extractFile);
      if (!checked.ok) {
        setExtractError(checked.message);
        return;
      }
      request = { file: extractFile, sourceType: 'DOC_UPLOAD' };
    }

    setExtracting(true);
    try {
      const res = await extractBrandFacts(brand.id, request, {
        storage: window.sessionStorage,
      });
      setExtractResult({
        sourceType: res.sourceType,
        sourceUrl: res.sourceUrl,
        facts: res.facts,
        warnings: res.warnings,
      });
    } catch (reason: unknown) {
      const status =
        typeof reason === 'object' && reason !== null && 'status' in reason
          ? Number((reason as { status?: unknown }).status)
          : 0;
      if (status === 429) {
        setExtractError('提炼请求过于频繁，请稍后再试');
      } else {
        setExtractError(
          reason instanceof Error && reason.message
            ? reason.message
            : 'AI 事实提炼失败，请稍后重试',
        );
      }
    } finally {
      setExtracting(false);
    }
  };

  const handleApplyExtracted = () => {
    if (!extractResult) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const item of extractResult.facts) {
        const existing = next[item.slot];
        const incoming = item.content.trim();
        const mergedContent =
          applyMode === 'append' && existing.content.trim().length > 0 && incoming
            ? `${existing.content.trim()}\n\n${incoming}`.slice(0, BRAND_FACT_CARD_MAX)
            : incoming;
        next[item.slot] = {
          ...existing,
          title: item.title.trim() || existing.title || BRAND_FACT_SLOT_LABELS[item.slot],
          content: mergedContent,
          sourceType: extractResult.sourceType,
          sourceUrl: extractResult.sourceUrl,
        };
      }
      return next;
    });
    setExtractModalOpen(false);
    feedback.notifySuccess('已将 AI 提炼结果填入 4 块事实卡，核对并勾选合规承诺后点击保存');
  };

  return (
    <Section
      id="brand-section-facts"
      variant="plain"
      aria-label="品牌事实卡"
      title={
        <span className="gm-brand-section-title-row">
          <span>事实卡</span>
          <StatusBadge
            tone={needsVectorIndex ? 'active' : 'neutral'}
            label={`总计 ${totalChars} 字`}
          />
          {anyIndexing ? (
            <StatusBadge status="INDEXING" label={FACT_INDEX_STATUS_SHORT.INDEXING} />
          ) : anyFailed ? (
            <StatusBadge status="FAILED" label={FACT_INDEX_STATUS_SHORT.FAILED} />
          ) : needsVectorIndex && anyReady ? (
            <StatusBadge tone="success" label={FACT_INDEX_STATUS_SHORT.READY} />
          ) : (
            <StatusBadge tone="success" label={FACT_INDEX_STATUS_SHORT.NONE} />
          )}
        </span>
      }
      description={`维护一份中文核心事实，切至海外市场写作时自动跨语种注入，无需手动翻译；总字数超过 ${BRAND_FACT_FULL_INJECT_MAX.toLocaleString()} 字时系统自动后台建立检索索引。`}
      actions={
        <div className="gm-brand-subcard-head-actions">
          <CostChip points={0} />
          <Button
            type="default"
            data-testid="fact-ai-extract-btn"
            disabled={readOnly || loading}
            className="gm-brand-btn-nowrap"
            onClick={openExtractModal}
          >
            AI 提炼
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="gm-brand-facts-grid" aria-busy="true">
          {CORE_FACT_SLOTS.map((slot) => (
            <SignalSkeleton key={slot} variant="block" height={176} />
          ))}
        </div>
      ) : error ? (
        <SignalError message={error} onRetry={onRetry} />
      ) : (
        <>
          {hasProductLines ? (
            <div className="gm-brand-fact-scope-bar" data-testid="brand-facts-scope-selector">
              <div
                className="gm-brand-mode-tabs gm-brand-fact-scope-tabs"
                role="tablist"
                aria-label="事实卡归属范围切换"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveScopeId === null}
                  data-testid="fact-scope-tab-general"
                  className={
                    effectiveScopeId === null ? 'gm-brand-mode-btn is-active' : 'gm-brand-mode-btn'
                  }
                  onClick={() => setSelectedScopeId(null)}
                >
                  品牌通用
                </button>
                {productLines.map((line) => {
                  const lineFactCount = facts.filter(
                    (f) => f.productLineId === line.id && f.content.trim().length > 0,
                  ).length;
                  return (
                    <button
                      key={line.id}
                      type="button"
                      role="tab"
                      aria-selected={effectiveScopeId === line.id}
                      data-testid={`fact-scope-tab-${line.id}`}
                      className={
                        effectiveScopeId === line.id
                          ? 'gm-brand-mode-btn is-active'
                          : 'gm-brand-mode-btn'
                      }
                      onClick={() => setSelectedScopeId(line.id)}
                    >
                      <span>{line.name}</span>
                      {lineFactCount > 0 ? (
                        <span className="gm-brand-fact-scope-count gm-num">({lineFactCount})</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {facts.some(
                (f) =>
                  (f.productLineId ?? null) !== effectiveScopeId && f.content.trim().length > 0,
              ) ? (
                <div
                  className="gm-brand-fact-other-scopes"
                  data-testid="brand-facts-other-scopes-summary"
                >
                  <span className="gm-brand-fact-other-label">其他归属已存事实卡：</span>
                  {facts
                    .filter(
                      (f) =>
                        (f.productLineId ?? null) !== effectiveScopeId &&
                        f.content.trim().length > 0,
                    )
                    .map((item) => {
                      const scopeName = item.productLineId
                        ? (lineNameById.get(item.productLineId) ?? '指定产品线')
                        : '品牌通用';
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className="gm-brand-fact-other-chip"
                          onClick={() => setSelectedScopeId(item.productLineId ?? null)}
                        >
                          <StatusBadge
                            tone={item.productLineId ? 'active' : 'neutral'}
                            size="sm"
                            label={scopeName}
                          />
                          <span>{item.title || BRAND_FACT_SLOT_LABELS[item.slot]}</span>
                        </button>
                      );
                    })}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="gm-brand-facts-grid">
            {CORE_FACT_SLOTS.map((slot) => {
              const card = drafts[slot];
              const charLen = card.content.length;
              const cardScopeLabel = card.productLineId
                ? (lineNameById.get(card.productLineId) ?? '指定产品线')
                : '品牌通用';
              return (
                <div key={slot} className="gm-brand-fact-card" data-testid={`fact-slot-${slot}`}>
                  <div className="gm-brand-fact-card-head">
                    <div className="gm-brand-fact-title-wrap">
                      <strong>{BRAND_FACT_SLOT_SHORT[slot]}</strong>
                      <StatusBadge tone="neutral" label={FACT_SOURCE_LABELS[card.sourceType]} />
                      {hasProductLines ? (
                        <StatusBadge
                          tone={card.productLineId ? 'active' : 'neutral'}
                          label={cardScopeLabel}
                        />
                      ) : null}
                    </div>
                    <div className="gm-brand-fact-meta">
                      <span className={charLen > 2000 ? 'gm-brand-char-warn' : undefined}>
                        {charLen} 字
                      </span>
                      <span>
                        {card.updatedAt ? formatShanghaiDateTime(card.updatedAt) : '未保存'}
                      </span>
                    </div>
                  </div>

                  {hasProductLines ? (
                    <div className="gm-brand-fact-card-scope-row">
                      <span className="gm-brand-fact-card-scope-label">归属：</span>
                      <Select<string>
                        size="small"
                        aria-label={`${BRAND_FACT_SLOT_LABELS[slot]}归属范围`}
                        data-testid={`fact-scope-select-${slot}`}
                        className="gm-brand-fact-scope-select"
                        disabled={readOnly || saving}
                        value={card.productLineId ?? GENERAL_SCOPE_VALUE}
                        options={[
                          { value: GENERAL_SCOPE_VALUE, label: '品牌通用' },
                          ...productLines.map((line) => ({
                            value: line.id,
                            label: line.name,
                          })),
                        ]}
                        onChange={(val) =>
                          updateSlotField(slot, {
                            productLineId: val === GENERAL_SCOPE_VALUE ? null : val,
                          })
                        }
                      />
                    </div>
                  ) : null}

                  <Input
                    size="small"
                    aria-label={`${BRAND_FACT_SLOT_LABELS[slot]}标题`}
                    value={card.title}
                    maxLength={120}
                    disabled={readOnly || saving}
                    className="gm-brand-fact-title-input"
                    onChange={(event) => updateSlotField(slot, { title: event.target.value })}
                  />

                  <Input.TextArea
                    aria-label={BRAND_FACT_SLOT_LABELS[slot]}
                    value={card.content}
                    maxLength={BRAND_FACT_CARD_MAX}
                    autoSize={{ minRows: 5, maxRows: 12 }}
                    disabled={readOnly || saving}
                    placeholder={FACT_SLOT_PLACEHOLDERS[slot]}
                    onChange={(event) => updateSlotField(slot, { content: event.target.value })}
                  />
                </div>
              );
            })}
          </div>

          {/* Collapsible Optional EXTRA_DOC */}
          <div className="gm-brand-extra-doc">
            <div className="gm-brand-extra-doc-head">
              <div className="gm-brand-advanced-toggle-row">
                <button
                  type="button"
                  className="gm-brand-extra-doc-toggle"
                  aria-expanded={extraDocOpen}
                  onClick={() => setExtraDocOpen((open) => !open)}
                >
                  <span>{extraDocOpen ? '▾' : '▸'} 长文档</span>
                </button>
                <Explain
                  text={`可选补充长文档（最高 ${BRAND_FACT_CARD_MAX.toLocaleString()} 字），适合粘贴产品规格书、白皮书或长篇 FAQ；总字数超过 6,000 字时系统将在后台自动建立检索索引。`}
                />
              </div>
              <span className="gm-brand-extra-doc-meta">
                <span>{drafts.EXTRA_DOC.content.length} 字</span>
                <StatusBadge
                  status={drafts.EXTRA_DOC.indexStatus}
                  label={FACT_INDEX_STATUS_SHORT[drafts.EXTRA_DOC.indexStatus]}
                />
              </span>
            </div>

            {extraDocOpen ? (
              <div className="gm-brand-extra-doc-body" data-testid="fact-slot-EXTRA_DOC">
                <Input.TextArea
                  aria-label="补充长文档"
                  value={drafts.EXTRA_DOC.content}
                  maxLength={BRAND_FACT_CARD_MAX}
                  autoSize={{ minRows: 5, maxRows: 12 }}
                  disabled={readOnly || saving}
                  placeholder="粘贴完整产品手册、技术白皮书或客户常见问题说明..."
                  onChange={(event) =>
                    updateSlotField('EXTRA_DOC', { content: event.target.value })
                  }
                />
              </div>
            ) : null}
          </div>

          {/* Lightweight single-checkbox compliance attestation */}
          <div className="gm-brand-facts-footer">
            <div className="gm-brand-truth-bar">
              <Checkbox
                data-testid="brand-facts-truth-checkbox"
                checked={truthAgreed}
                disabled={readOnly || saving}
                onChange={(event) => {
                  setTruthAgreed(event.target.checked);
                  if (event.target.checked) setSaveError(null);
                }}
              >
                确认属实
              </Checkbox>
              <Explain text={BRAND_TRUTH_CHECKBOX_LABEL} />
              <Button
                type="link"
                size="small"
                autoInsertSpace={false}
                onClick={() => setTermsOpen(true)}
              >
                协议
              </Button>
              {truthSignedAt ? (
                <span className="gm-brand-truth-signed">
                  已签署 · {formatShanghaiDateTime(truthSignedAt)}
                </span>
              ) : null}
            </div>

            <Button
              type={demotePrimary ? 'default' : 'primary'}
              autoInsertSpace={false}
              data-testid="brand-facts-save-btn"
              loading={saving}
              disabled={readOnly}
              className="gm-brand-btn-nowrap"
              onClick={() => void handleSaveFacts()}
            >
              保存
            </Button>
          </div>

          {saveError ? (
            <Alert type="warning" showIcon message={saveError} className="gm-brand-mt-sm" />
          ) : null}
        </>
      )}

      <BrandTruthTermsModal open={termsOpen} onClose={() => setTermsOpen(false)} />

      <BrandFactsExtractModal
        open={extractModalOpen}
        extractMode={extractMode}
        extractUrl={extractUrl}
        extractText={extractText}
        extractFile={extractFile}
        extracting={extracting}
        extractError={extractError}
        extractResult={extractResult}
        applyMode={applyMode}
        onCancel={() => setExtractModalOpen(false)}
        onModeChange={(mode) => {
          setExtractMode(mode);
          setExtractError(null);
        }}
        onUrlChange={setExtractUrl}
        onTextChange={setExtractText}
        onFileChange={(file) => {
          setExtractFile(file);
          setExtractError(null);
        }}
        onApplyModeChange={setApplyMode}
        onRunExtract={() => void handleRunExtract()}
        onApplyExtracted={handleApplyExtracted}
      />
    </Section>
  );
}
