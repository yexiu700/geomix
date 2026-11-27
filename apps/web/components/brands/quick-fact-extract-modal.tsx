'use client';

import {
  BRAND_FACT_CARD_MAX,
  BRAND_FACT_SLOT_LABELS,
  BRAND_TRUTH_CHECKBOX_LABEL,
  type BrandFactCoreSlot,
  type BrandFactsResponse,
  type FactSourceType,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Input, Modal } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { extractBrandFacts, saveBrandFacts, type ExtractBrandFactsRequest } from '../../lib/brands';
import { invalidateFreshness } from '../../lib/tab-freshness';
import { BRAND_FACT_SLOT_SHORT } from '../../lib/short-labels';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { CostChip, Explain } from '../ui';
import {
  CORE_FACT_SLOTS,
  FACT_EXTRACT_ACCEPT,
  FACT_SLOT_PLACEHOLDERS,
  validateFactUploadFile,
} from './brand-form-helpers';

type ExtractSourceMode = 'URL_EXTRACT' | 'MANUAL' | 'DOC_UPLOAD';

type ExtractedSlotDraft = {
  slot: BrandFactCoreSlot;
  title: string;
  content: string;
};

export type QuickFactExtractModalProps = {
  open: boolean;
  brandId: string;
  brandName?: string;
  productLineId?: string | null;
  productLineName?: string | null;
  defaultDomain?: string | null;
  truthSignedAt?: string | null;
  readOnly?: boolean;
  onClose: () => void;
  onSkipAndGenerate: () => void;
  onSaved: (response: BrandFactsResponse) => void;
};

function buildInitialUrl(defaultDomain?: string | null): string {
  const clean = defaultDomain?.trim() || '';
  if (!clean) return '';
  if (/^https?:\/\//i.test(clean)) return clean;
  return `https://${clean}`;
}

function buildEmptyReviewDrafts(): Record<BrandFactCoreSlot, ExtractedSlotDraft> {
  return {
    PRODUCT_SPECS: {
      slot: 'PRODUCT_SPECS',
      title: BRAND_FACT_SLOT_LABELS.PRODUCT_SPECS,
      content: '',
    },
    DIFFERENTIATORS: {
      slot: 'DIFFERENTIATORS',
      title: BRAND_FACT_SLOT_LABELS.DIFFERENTIATORS,
      content: '',
    },
    CREDENTIALS: {
      slot: 'CREDENTIALS',
      title: BRAND_FACT_SLOT_LABELS.CREDENTIALS,
      content: '',
    },
    CASE_STUDIES: {
      slot: 'CASE_STUDIES',
      title: BRAND_FACT_SLOT_LABELS.CASE_STUDIES,
      content: '',
    },
  };
}

export function QuickFactExtractModal({
  open,
  brandId,
  brandName,
  productLineId = null,
  productLineName = null,
  defaultDomain,
  truthSignedAt,
  readOnly = false,
  onClose,
  onSkipAndGenerate,
  onSaved,
}: QuickFactExtractModalProps) {
  const [extractMode, setExtractMode] = useState<ExtractSourceMode>('URL_EXTRACT');
  const [extractUrl, setExtractUrl] = useState(() => buildInitialUrl(defaultDomain));
  const [extractText, setExtractText] = useState('');
  const [extractFile, setExtractFile] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [sourceMeta, setSourceMeta] = useState<{
    sourceType: FactSourceType;
    sourceUrl: string | null;
  } | null>(null);
  const [hasExtracted, setHasExtracted] = useState(false);
  const [reviewDrafts, setReviewDrafts] = useState<Record<BrandFactCoreSlot, ExtractedSlotDraft>>(
    () => buildEmptyReviewDrafts(),
  );
  const [truthAgreed, setTruthAgreed] = useState(Boolean(truthSignedAt));

  const extractCtrlRef = useRef<AbortController | null>(null);
  const saveCtrlRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      extractCtrlRef.current?.abort();
      saveCtrlRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    extractCtrlRef.current?.abort();
    extractCtrlRef.current = null;
    saveCtrlRef.current?.abort();
    saveCtrlRef.current = null;
    if (!open) {
      setExtracting(false);
      setSaving(false);
      return;
    }
    setExtractMode('URL_EXTRACT');
    setExtractUrl(buildInitialUrl(defaultDomain));
    setExtractText('');
    setExtractFile(null);
    setExtracting(false);
    setSaving(false);
    setError(null);
    setWarnings([]);
    setSourceMeta(null);
    setHasExtracted(false);
    setReviewDrafts(buildEmptyReviewDrafts());
    setTruthAgreed(Boolean(truthSignedAt));
  }, [open, brandId, productLineId, defaultDomain, truthSignedAt]);

  const busy = extracting || saving;

  const handleRunExtract = async () => {
    if (readOnly || busy) return;
    setError(null);

    let request: ExtractBrandFactsRequest;
    if (extractMode === 'URL_EXTRACT') {
      const trimmedUrl = extractUrl.trim();
      if (!/^https?:\/\/.+/i.test(trimmedUrl)) {
        setError('请输入以 http:// 或 https:// 开头的完整官网或商品页链接');
        return;
      }
      request = { sourceType: 'URL_EXTRACT', url: trimmedUrl };
    } else if (extractMode === 'MANUAL') {
      const rawText = extractText.trim();
      if (rawText.length < 10) {
        setError('请至少粘贴 10 个字以上的产品资料');
        return;
      }
      request = { sourceType: 'MANUAL', rawText };
    } else {
      if (!extractFile) {
        setError('请选择要上传的 TXT、MD 或 PDF 文档');
        return;
      }
      const checked = validateFactUploadFile(extractFile);
      if (!checked.ok) {
        setError(checked.message);
        return;
      }
      request = { file: extractFile, sourceType: 'DOC_UPLOAD' };
    }

    extractCtrlRef.current?.abort();
    const ctrl = new AbortController();
    extractCtrlRef.current = ctrl;
    setExtracting(true);
    try {
      const res = await extractBrandFacts(brandId, request, {
        storage: window.sessionStorage,
        signal: ctrl.signal,
      });
      if (!mountedRef.current || ctrl.signal.aborted) return;

      const nextDrafts = buildEmptyReviewDrafts();
      for (const item of res.facts) {
        nextDrafts[item.slot] = {
          slot: item.slot,
          title: item.title.trim() || BRAND_FACT_SLOT_LABELS[item.slot],
          content: item.content.slice(0, BRAND_FACT_CARD_MAX),
        };
      }
      setReviewDrafts(nextDrafts);
      setSourceMeta({ sourceType: res.sourceType, sourceUrl: res.sourceUrl });
      setWarnings(res.warnings ?? []);
      setHasExtracted(true);
    } catch (reason: unknown) {
      if (!mountedRef.current || ctrl.signal.aborted) return;
      const status =
        typeof reason === 'object' && reason !== null && 'status' in reason
          ? Number((reason as { status?: unknown }).status)
          : 0;
      if (status === 429) {
        setError('提炼请求过于频繁，请稍后再试');
      } else {
        setError(
          reason instanceof Error && reason.message
            ? reason.message
            : 'AI 事实提炼失败，请稍后重试',
        );
      }
    } finally {
      if (mountedRef.current && extractCtrlRef.current === ctrl) {
        setExtracting(false);
      }
    }
  };

  const handleSaveAndResume = async () => {
    if (readOnly || busy) return;
    setError(null);

    if (!truthAgreed) {
      setError('请先勾选品牌事实真实性与合规承诺后再保存');
      return;
    }

    const nonEmptyFacts = CORE_FACT_SLOTS.map((slot) => reviewDrafts[slot]).filter(
      (item) => item.content.trim().length > 0,
    );
    if (nonEmptyFacts.length === 0) {
      setError('请至少保留 1 块非空的品牌事实内容后再保存');
      return;
    }

    saveCtrlRef.current?.abort();
    const ctrl = new AbortController();
    saveCtrlRef.current = ctrl;
    setSaving(true);
    try {
      const saved = await saveBrandFacts(
        brandId,
        {
          facts: nonEmptyFacts.map((item) => ({
            slot: item.slot,
            title: item.title.trim() || BRAND_FACT_SLOT_LABELS[item.slot],
            content: item.content.trim().slice(0, BRAND_FACT_CARD_MAX),
            sourceType: sourceMeta?.sourceType ?? 'MANUAL',
            sourceUrl: sourceMeta?.sourceUrl ?? null,
            ...(productLineId ? { productLineId } : {}),
          })),
          truthAgreed: true,
        },
        { storage: window.sessionStorage, signal: ctrl.signal },
      );
      if (!mountedRef.current || ctrl.signal.aborted) return;

      if (saved.truthAgreementSignedAt) {
        useWorkspaceStore.getState().markBrandTruthSigned(brandId, saved.truthAgreementSignedAt);
      }
      onSaved(saved);
      invalidateFreshness('brand-facts');
    } catch (reason: unknown) {
      if (!mountedRef.current || ctrl.signal.aborted) return;
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : '保存品牌事实卡失败，请稍后重试',
      );
    } finally {
      if (mountedRef.current && saveCtrlRef.current === ctrl) {
        setSaving(false);
      }
    }
  };

  return (
    <Modal
      open={open}
      title="补充事实"
      width={680}
      onCancel={() => {
        if (!busy) onClose();
      }}
      keyboard={!busy}
      maskClosable={!busy}
      destroyOnHidden
      footer={null}
    >
      <div className="gm-brand-extract-step" data-testid="quick-fact-extract-modal">
        <div className="gm-brand-extra-doc-head">
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
                disabled={busy || readOnly}
                onClick={() => {
                  setExtractMode(mode);
                  setError(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <Explain
            text={`当前品牌${brandName ? `「${brandName}」` : ''}${productLineName ? `（产品线：${productLineName}）` : ''}尚未维护品牌事实卡。输入官网/商品页链接或粘贴参数，系统可 0 点提炼事实并直接续跑写作。`}
          />
        </div>

        {extractMode === 'URL_EXTRACT' ? (
          <Input
            aria-label="官网链接"
            value={extractUrl}
            disabled={busy || readOnly}
            placeholder="https://example.com/product"
            onChange={(event) => setExtractUrl(event.target.value)}
          />
        ) : extractMode === 'MANUAL' ? (
          <Input.TextArea
            aria-label="粘贴产品资料"
            rows={4}
            value={extractText}
            disabled={busy || readOnly}
            placeholder="粘贴官网介绍、产品规格书、评测参数或客户案例文本（至少 10 字）"
            onChange={(event) => setExtractText(event.target.value)}
          />
        ) : (
          <div className="gm-brand-file-picker">
            <input
              type="file"
              accept={FACT_EXTRACT_ACCEPT}
              aria-label="上传品牌资料文档"
              disabled={busy || readOnly}
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                setExtractFile(file);
                setError(null);
              }}
            />
            {extractFile ? (
              <span className="gm-brand-file-name">已选文件：{extractFile.name}</span>
            ) : null}
          </div>
        )}

        {error ? <Alert type="error" showIcon message={error} className="gm-brand-mt-sm" /> : null}

        {hasExtracted ? (
          <div className="gm-brand-draft-list" data-testid="quick-fact-review-list">
            {warnings.length > 0 ? (
              <Alert type="info" showIcon message={warnings.join(' ')} className="gm-brand-mb-sm" />
            ) : null}
            {CORE_FACT_SLOTS.map((slot) => {
              const draft = reviewDrafts[slot];
              return (
                <div key={slot} className="gm-brand-draft-item">
                  <div className="gm-brand-draft-head">
                    <strong>{BRAND_FACT_SLOT_SHORT[slot]}</strong>
                    <span className="gm-brand-fact-meta">{draft.content.length} 字</span>
                  </div>
                  <Input.TextArea
                    aria-label={BRAND_FACT_SLOT_LABELS[slot]}
                    value={draft.content}
                    maxLength={BRAND_FACT_CARD_MAX}
                    autoSize={{ minRows: 2, maxRows: 5 }}
                    disabled={busy || readOnly}
                    placeholder={FACT_SLOT_PLACEHOLDERS[slot]}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setReviewDrafts((prev) => ({
                        ...prev,
                        [slot]: { ...prev[slot], content: nextValue },
                      }));
                    }}
                  />
                </div>
              );
            })}

            <div className="gm-brand-truth-bar">
              <Checkbox
                data-testid="quick-fact-truth-checkbox"
                checked={truthAgreed}
                disabled={busy || readOnly}
                onChange={(event) => {
                  setTruthAgreed(event.target.checked);
                  if (event.target.checked) setError(null);
                }}
              >
                确认属实
              </Checkbox>
              <Explain text={BRAND_TRUTH_CHECKBOX_LABEL} />
            </div>
          </div>
        ) : null}

        <div className="gm-brand-modal-footer">
          <Button
            type="default"
            autoInsertSpace={false}
            data-testid="quick-fact-skip-btn"
            disabled={busy || readOnly}
            onClick={onSkipAndGenerate}
          >
            跳过
          </Button>
          <CostChip points={0} />
          <Button
            type={hasExtracted ? 'default' : 'primary'}
            data-testid="quick-fact-extract-btn"
            loading={extracting}
            disabled={saving || readOnly}
            onClick={() => void handleRunExtract()}
          >
            AI 提炼
          </Button>
          {hasExtracted ? (
            <Button
              type="primary"
              data-testid="quick-fact-save-btn"
              loading={saving}
              disabled={extracting || readOnly}
              onClick={() => void handleSaveAndResume()}
            >
              保存继续
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
