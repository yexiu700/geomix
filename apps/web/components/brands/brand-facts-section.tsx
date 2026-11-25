'use client';

import {
  BRAND_FACT_CARD_MAX,
  BRAND_FACT_FULL_INJECT_MAX,
  BRAND_FACT_SLOT_LABELS,
  BRAND_TRUTH_AGREEMENT_PARAGRAPHS,
  BRAND_TRUTH_AGREEMENT_TITLE,
  BRAND_TRUTH_CHECKBOX_LABEL,
  FACT_INDEX_STATUS_LABELS,
  formatShanghaiDateTime,
  requiresBrandFactVectorIndex,
  type BrandFactRecord,
  type BrandFactSlot,
  type BrandFactsResponse,
  type BrandMarketRecord,
  type BrandRecord,
  type ExtractedBrandFactDraft,
  type FactIndexStatus,
  type FactSourceType,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Input, Modal, Radio, Space } from 'antd';
import { useEffect, useState } from 'react';
import { extractBrandFacts, saveBrandFacts, type ExtractBrandFactsRequest } from '../../lib/brands';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalError, SignalSkeleton } from '../geo/primitives';
import { Section, StatusBadge } from '../ui';
import {
  CORE_FACT_SLOTS,
  FACT_EXTRACT_ACCEPT,
  FACT_SLOT_PLACEHOLDERS,
  FACT_SOURCE_LABELS,
  computeTotalFactChars,
  validateFactUploadFile,
} from './brand-form-helpers';

type SlotDraft = {
  id?: string;
  slot: BrandFactSlot;
  title: string;
  content: string;
  sourceType: FactSourceType;
  sourceUrl: string | null;
  indexStatus: FactIndexStatus;
  updatedAt: string | null;
};

type ExtractSourceMode = 'URL_EXTRACT' | 'MANUAL' | 'DOC_UPLOAD';

export type BrandFactsSectionProps = {
  brand: BrandRecord;
  activeBrandMarket: BrandMarketRecord | null;
  facts: readonly BrandFactRecord[];
  loading: boolean;
  error: string | null;
  truthSignedAt: string | null;
  readOnly: boolean;
  onRetry: () => void;
  onFactsSaved: (response: BrandFactsResponse) => void;
};

function buildInitialDrafts(facts: readonly BrandFactRecord[]): Record<BrandFactSlot, SlotDraft> {
  const map = {} as Record<BrandFactSlot, SlotDraft>;
  const slots: readonly BrandFactSlot[] = [...CORE_FACT_SLOTS, 'EXTRA_DOC'];
  for (const slot of slots) {
    const matched = facts.find((item) => item.slot === slot);
    map[slot] = matched
      ? {
          id: matched.id,
          slot,
          title: matched.title || BRAND_FACT_SLOT_LABELS[slot],
          content: matched.content,
          sourceType: matched.sourceType,
          sourceUrl: matched.sourceUrl,
          indexStatus: matched.indexStatus,
          updatedAt: matched.updatedAt,
        }
      : {
          slot,
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
  facts,
  loading,
  error,
  truthSignedAt,
  readOnly,
  onRetry,
  onFactsSaved,
}: BrandFactsSectionProps) {
  const feedback = useUxFeedback();
  const [drafts, setDrafts] = useState<Record<BrandFactSlot, SlotDraft>>(() =>
    buildInitialDrafts(facts),
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

  const factsSignature = facts.map((f) => `${f.id}:${f.updatedAt}:${f.indexStatus}`).join('|');

  useEffect(() => {
    const next = buildInitialDrafts(facts);
    setDrafts(next);
    if (next.EXTRA_DOC.content.trim().length > 0) {
      setExtraDocOpen(true);
    }
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand.id, factsSignature]);

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
    patch: Partial<Pick<SlotDraft, 'title' | 'content' | 'sourceType' | 'sourceUrl'>>,
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

    const payloadFacts = allSlots
      .map((slot) => drafts[slot])
      .filter(
        (item) => item.slot !== 'EXTRA_DOC' || item.content.trim().length > 0 || Boolean(item.id),
      )
      .map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        slot: item.slot,
        title: item.title.trim() || BRAND_FACT_SLOT_LABELS[item.slot],
        content: item.content.trim(),
        sourceType: item.sourceType,
        sourceUrl: item.sourceUrl,
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
          <span>品牌事实卡</span>
          <StatusBadge tone="neutral" label="免费标配 · 双市场共享" />
          <StatusBadge
            tone={needsVectorIndex ? 'active' : 'neutral'}
            label={`总计 ${totalChars} 字`}
          />
          {anyIndexing ? (
            <StatusBadge status="INDEXING" label={FACT_INDEX_STATUS_LABELS.INDEXING} />
          ) : anyFailed ? (
            <StatusBadge status="FAILED" label={FACT_INDEX_STATUS_LABELS.FAILED} />
          ) : needsVectorIndex && anyReady ? (
            <StatusBadge tone="success" label={FACT_INDEX_STATUS_LABELS.READY} />
          ) : (
            <StatusBadge tone="success" label={FACT_INDEX_STATUS_LABELS.NONE} />
          )}
        </span>
      }
      description={`维护一份中文核心事实，切至海外市场写作时自动跨语种注入，无需手动翻译；总字数超过 ${BRAND_FACT_FULL_INJECT_MAX.toLocaleString()} 字时系统自动后台建立检索索引。`}
      actions={
        <Button
          type="default"
          data-testid="fact-ai-extract-btn"
          disabled={readOnly || loading}
          className="gm-brand-btn-nowrap"
          onClick={openExtractModal}
        >
          AI 自动提炼 4 块事实卡（免费）
        </Button>
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
          <div className="gm-brand-facts-grid">
            {CORE_FACT_SLOTS.map((slot) => {
              const card = drafts[slot];
              const charLen = card.content.length;
              return (
                <div key={slot} className="gm-brand-fact-card" data-testid={`fact-slot-${slot}`}>
                  <div className="gm-brand-fact-card-head">
                    <div className="gm-brand-fact-title-wrap">
                      <strong>{BRAND_FACT_SLOT_LABELS[slot]}</strong>
                      <StatusBadge tone="neutral" label={FACT_SOURCE_LABELS[card.sourceType]} />
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
            <button
              type="button"
              className="gm-brand-extra-doc-toggle"
              aria-expanded={extraDocOpen}
              onClick={() => setExtraDocOpen((open) => !open)}
            >
              <span>
                {extraDocOpen ? '▾' : '▸'} 补充长文档区（可选，最高{' '}
                {BRAND_FACT_CARD_MAX.toLocaleString()} 字）
              </span>
              <span className="gm-brand-extra-doc-meta">
                <span>{drafts.EXTRA_DOC.content.length} 字</span>
                <StatusBadge
                  status={drafts.EXTRA_DOC.indexStatus}
                  label={FACT_INDEX_STATUS_LABELS[drafts.EXTRA_DOC.indexStatus]}
                />
              </span>
            </button>

            {extraDocOpen ? (
              <div className="gm-brand-extra-doc-body" data-testid="fact-slot-EXTRA_DOC">
                <p className="gm-brand-section-desc gm-brand-mb-sm">
                  适合粘贴完整产品规格书、白皮书或长篇 FAQ；总字数超过 6,000
                  字时系统将在后台自动建立检索索引，无需手动配置。
                </p>
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
                checked={truthAgreed}
                disabled={readOnly || saving}
                onChange={(event) => {
                  setTruthAgreed(event.target.checked);
                  if (event.target.checked) setSaveError(null);
                }}
              >
                {BRAND_TRUTH_CHECKBOX_LABEL}
              </Checkbox>
              <Button type="link" size="small" onClick={() => setTermsOpen(true)}>
                查看承诺协议全文
              </Button>
              {truthSignedAt ? (
                <span className="gm-brand-truth-signed">
                  已签署 · {formatShanghaiDateTime(truthSignedAt)}
                </span>
              ) : null}
            </div>

            <Button
              type="default"
              loading={saving}
              disabled={readOnly}
              className="gm-brand-btn-nowrap"
              onClick={() => void handleSaveFacts()}
            >
              保存品牌事实卡
            </Button>
          </div>

          {saveError ? (
            <Alert type="warning" showIcon message={saveError} className="gm-brand-mt-sm" />
          ) : null}
        </>
      )}

      {/* Terms Preview Modal */}
      <Modal
        open={termsOpen}
        title={BRAND_TRUTH_AGREEMENT_TITLE}
        onCancel={() => setTermsOpen(false)}
        footer={[
          <Button key="ok" type="primary" onClick={() => setTermsOpen(false)}>
            知道了
          </Button>,
        ]}
      >
        <Space direction="vertical" size={10} className="gm-brand-terms-list">
          {BRAND_TRUTH_AGREEMENT_PARAGRAPHS.map((para, idx) => (
            <p key={idx} className="gm-brand-terms-para">
              {para}
            </p>
          ))}
        </Space>
      </Modal>

      {/* AI Extract Modal */}
      <Modal
        open={extractModalOpen}
        title="AI 自动提炼 4 块品牌事实卡（免费）"
        width={640}
        onCancel={() => {
          if (!extracting) setExtractModalOpen(false);
        }}
        keyboard={!extracting}
        maskClosable={!extracting}
        destroyOnHidden
        footer={null}
      >
        <div className="gm-brand-extract-step">
          <div className="gm-brand-mode-tabs" role="tablist" aria-label="选择事实资料来源">
            {(
              [
                ['URL_EXTRACT', '官网链接'],
                ['MANUAL', '粘贴资料'],
                ['DOC_UPLOAD', '上传文档'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={extractMode === mode}
                className={
                  extractMode === mode ? 'gm-brand-mode-btn is-active' : 'gm-brand-mode-btn'
                }
                onClick={() => {
                  setExtractMode(mode);
                  setExtractError(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {extractMode === 'URL_EXTRACT' ? (
            <Input
              aria-label="官网链接"
              value={extractUrl}
              disabled={extracting}
              placeholder="https://example.com/product"
              onChange={(event) => setExtractUrl(event.target.value)}
            />
          ) : extractMode === 'MANUAL' ? (
            <Input.TextArea
              aria-label="粘贴产品资料"
              rows={5}
              value={extractText}
              disabled={extracting}
              placeholder="粘贴官网介绍、产品规格书、评测参数或客户案例文本（至少 10 字）"
              onChange={(event) => setExtractText(event.target.value)}
            />
          ) : (
            <div className="gm-brand-file-picker">
              <input
                type="file"
                accept={FACT_EXTRACT_ACCEPT}
                aria-label="上传品牌资料文档"
                disabled={extracting}
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setExtractFile(file);
                  setExtractError(null);
                }}
              />
              {extractFile ? (
                <span className="gm-brand-file-name">已选文件：{extractFile.name}</span>
              ) : null}
            </div>
          )}

          {extractError ? (
            <Alert type="error" showIcon message={extractError} className="gm-brand-mt-sm" />
          ) : null}

          {extractResult ? (
            <div className="gm-brand-draft-list">
              {extractResult.warnings && extractResult.warnings.length > 0 ? (
                <Alert
                  type="info"
                  showIcon
                  message={extractResult.warnings.join(' ')}
                  className="gm-brand-mb-sm"
                />
              ) : null}
              <div className="gm-brand-apply-mode">
                <span>写入方式：</span>
                <Radio.Group
                  value={applyMode}
                  onChange={(event) => setApplyMode(event.target.value as 'replace' | 'append')}
                >
                  <Radio value="replace">覆盖对应卡片</Radio>
                  <Radio value="append">追加到现有内容</Radio>
                </Radio.Group>
              </div>
              {extractResult.facts.map((item) => (
                <div key={item.slot} className="gm-brand-draft-item">
                  <div className="gm-brand-draft-head">
                    <strong>{BRAND_FACT_SLOT_LABELS[item.slot]}</strong>
                  </div>
                  <p className="gm-brand-draft-preview">{item.content || '（原文未提及）'}</p>
                </div>
              ))}
            </div>
          ) : null}

          <div className="gm-brand-modal-footer">
            <Button disabled={extracting} onClick={() => setExtractModalOpen(false)}>
              关闭
            </Button>
            <Button
              type={extractResult ? 'default' : 'primary'}
              loading={extracting}
              onClick={() => void handleRunExtract()}
            >
              开始 AI 提炼（免费）
            </Button>
            {extractResult ? (
              <Button type="primary" onClick={handleApplyExtracted}>
                应用到事实卡
              </Button>
            ) : null}
          </div>
        </div>
      </Modal>
    </Section>
  );
}
