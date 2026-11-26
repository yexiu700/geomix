'use client';

import {
  BRAND_CATEGORY_MAX,
  BRAND_FACT_SLOT_LABELS,
  BRAND_MAX_COMPETITORS,
  BRAND_NAME_MAX,
  BRAND_TRUTH_AGREEMENT_PARAGRAPHS,
  BRAND_TRUTH_AGREEMENT_TITLE,
  BRAND_TRUTH_CHECKBOX_LABEL,
  GLOBAL_CJK_IDENTITY_OVERRIDE_LABEL,
  containsCjk,
  validateGlobalMarketIdentity,
  type BrandFactCoreSlot,
  type BrandFactsResponse,
  type BrandMarketAiSuggestInput,
  type BrandMarketAiSuggestResponse,
  type BrandRecord,
  type CreateBrandInput,
  type ExtractBrandFactsResponse,
  type ExtractedBrandFactDraft,
  type FactSourceType,
  type GeoMarket,
  type UpdateBrandMarketInput,
  type UpsertBrandFactsInput,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Form, Input, Modal, Space, Tag } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { ExtractBrandFactsRequest } from '../../lib/brands';
import { useUxFeedback } from '../crud/ux-feedback';
import {
  CORE_FACT_SLOTS,
  FACT_EXTRACT_ACCEPT,
  mergeAiMarketSuggestions,
  serializeCompetitorRows,
  validateDomainListInput,
  validateFactUploadFile,
  type BrandMarketAiSuggestSelection,
  type CompetitorDraftRow,
} from './brand-form-helpers';
import { BrandMarketAiSuggestModal } from './brand-market-ai-suggest-modal';

type Step1FormValues = {
  name: string;
  category: string;
  markets: GeoMarket[];
  ownedDomainsText: string;
  globalLocalBrandName?: string;
  globalLocalCategory?: string;
  globalOwnedDomainsText?: string;
};

type ExtractSourceMode = 'URL_EXTRACT' | 'MANUAL' | 'DOC_UPLOAD';

export type BrandQuickCreateModalProps = {
  open: boolean;
  readOnly?: boolean;
  onClose: () => void;
  onCreateBrand: (input: CreateBrandInput) => Promise<BrandRecord>;
  onExtractFacts?: (
    brandId: string,
    input: ExtractBrandFactsRequest,
  ) => Promise<ExtractBrandFactsResponse>;
  onSaveFacts?: (brandId: string, input: UpsertBrandFactsInput) => Promise<BrandFactsResponse>;
  onBrandFactsSaved?: (brandId: string, signedAt: string | null) => void;
  onSuggestMarketConfig?: (
    brandId: string,
    market: GeoMarket,
    input?: BrandMarketAiSuggestInput,
  ) => Promise<BrandMarketAiSuggestResponse>;
  onSaveMarketConfig?: (
    brandId: string,
    market: GeoMarket,
    input: UpdateBrandMarketInput,
  ) => Promise<BrandRecord>;
};

let rowSeq = 1;
function makeEmptyCompetitorRow(): CompetitorDraftRow {
  rowSeq += 1;
  return { key: `qc-comp-${rowSeq}`, name: '', domainsText: '' };
}

function RemoveRowIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4.25h11" />
      <path d="M6 2.5h4" />
      <path d="M4.25 4.25l.6 8.5a1 1 0 0 0 1 .93h4.3a1 1 0 0 0 1-.93l.6-8.5" />
      <path d="M6.75 7v4" />
      <path d="M9.25 7v4" />
    </svg>
  );
}

export function BrandQuickCreateModal({
  open,
  readOnly = false,
  onClose,
  onCreateBrand,
  onExtractFacts,
  onSaveFacts,
  onBrandFactsSaved,
  onSuggestMarketConfig,
  onSaveMarketConfig,
}: BrandQuickCreateModalProps) {
  const feedback = useUxFeedback();
  const [form] = Form.useForm<Step1FormValues>();
  const watchedMarkets = Form.useWatch('markets', form);
  const watchedName = Form.useWatch('name', form);
  const watchedGlobalName = Form.useWatch('globalLocalBrandName', form);
  const watchedGlobalCategory = Form.useWatch('globalLocalCategory', form);
  const hasGlobalSelected = Array.isArray(watchedMarkets) && watchedMarkets.includes('GLOBAL');
  const effectiveGlobalName = watchedGlobalName?.trim() || watchedName?.trim() || '';
  const hasGlobalCjkIdentity =
    hasGlobalSelected &&
    (containsCjk(effectiveGlobalName) || containsCjk(watchedGlobalCategory?.trim() || ''));
  const hasPrefillStep = Boolean(onSuggestMarketConfig && onSaveMarketConfig);
  const [step, setStep] = useState<'create' | 'extract' | 'prefill'>('create');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowCjkGlobalIdentity, setAllowCjkGlobalIdentity] = useState(false);

  // Step 1 extra state: aliases chips + structured competitor rows
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasInput, setAliasInput] = useState('');
  const [competitorRows, setCompetitorRows] = useState<CompetitorDraftRow[]>([]);

  // Step 2 state: optional AI fact extraction
  const [createdBrand, setCreatedBrand] = useState<BrandRecord | null>(null);
  const [extractMode, setExtractMode] = useState<ExtractSourceMode>('URL_EXTRACT');
  const [extractUrl, setExtractUrl] = useState('');
  const [extractText, setExtractText] = useState('');
  const [extractFile, setExtractFile] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ExtractedBrandFactDraft[] | null>(null);
  const [draftSourceType, setDraftSourceType] = useState<FactSourceType>('URL_EXTRACT');
  const [draftSourceUrl, setDraftSourceUrl] = useState<string | null>(null);
  const [truthAgreed, setTruthAgreed] = useState(false);
  const [savingFacts, setSavingFacts] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Step 3 state: automatic AI market config prefill after saving facts
  const [prefillMarket, setPrefillMarket] = useState<GeoMarket>('CN');
  const [prefillLoading, setPrefillLoading] = useState(false);
  const [prefillSaving, setPrefillSaving] = useState(false);
  const [prefillError, setPrefillError] = useState<string | null>(null);
  const [prefillSuggestion, setPrefillSuggestion] = useState<BrandMarketAiSuggestResponse | null>(
    null,
  );
  const [prefillSourceUrl, setPrefillSourceUrl] = useState('');
  const prefillSeqRef = useRef(0);

  useEffect(() => {
    if (!open) {
      prefillSeqRef.current += 1;
      return;
    }
    prefillSeqRef.current += 1;
    setStep('create');
    setSubmitting(false);
    setError(null);
    setAllowCjkGlobalIdentity(false);
    setAliases([]);
    setAliasInput('');
    setCompetitorRows([]);
    setCreatedBrand(null);
    setExtractMode('URL_EXTRACT');
    setExtractUrl('');
    setExtractText('');
    setExtractFile(null);
    setExtracting(false);
    setExtractError(null);
    setDrafts(null);
    setTruthAgreed(false);
    setSavingFacts(false);
    setTermsOpen(false);
    setPrefillMarket('CN');
    setPrefillLoading(false);
    setPrefillSaving(false);
    setPrefillError(null);
    setPrefillSuggestion(null);
    setPrefillSourceUrl('');
    form.setFieldsValue({
      name: '',
      category: '',
      markets: ['CN'],
      ownedDomainsText: '',
      globalLocalBrandName: '',
      globalLocalCategory: '',
      globalOwnedDomainsText: '',
    });
  }, [form, open]);

  useEffect(() => {
    if (!hasGlobalCjkIdentity) {
      setAllowCjkGlobalIdentity(false);
    }
  }, [hasGlobalCjkIdentity]);

  const busy = submitting || extracting || savingFacts || prefillSaving;

  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  const handleAddAlias = () => {
    const trimmed = aliasInput.trim();
    if (!trimmed) return;
    if (aliases.length >= 20) return;
    if (aliases.some((item) => item.toLowerCase() === trimmed.toLowerCase())) {
      setAliasInput('');
      return;
    }
    setAliases((prev) => [...prev, trimmed.slice(0, BRAND_NAME_MAX)]);
    setAliasInput('');
  };

  const handleCreateSubmit = async (values: Step1FormValues) => {
    setError(null);
    const { domains: ownedDomains, invalidTokens } = validateDomainListInput(
      values.ownedDomainsText,
    );
    if (invalidTokens.length > 0) {
      setError(`以下官网域名格式不正确：${invalidTokens.join('、')}`);
      return;
    }
    if (ownedDomains.length === 0) {
      setError('请填写有效的自有官网域名（如 example.com）');
      return;
    }

    let globalDomains: string[] = [];
    if (values.markets.includes('GLOBAL') && values.globalOwnedDomainsText?.trim()) {
      const checkedGlobal = validateDomainListInput(values.globalOwnedDomainsText);
      if (checkedGlobal.invalidTokens.length > 0) {
        setError(`以下海外官网域名格式不正确：${checkedGlobal.invalidTokens.join('、')}`);
        return;
      }
      globalDomains = checkedGlobal.domains;
    }

    const { competitors, invalidDomainRows } = serializeCompetitorRows(competitorRows);
    if (invalidDomainRows.length > 0) {
      setError(`请检查竞品域名格式：${invalidDomainRows.join('；')}`);
      return;
    }

    const globalLocalBrandName = values.globalLocalBrandName?.trim() || undefined;
    const globalLocalCategory = values.globalLocalCategory?.trim() || undefined;
    if (values.markets.includes('GLOBAL')) {
      const globalCheck = validateGlobalMarketIdentity({
        market: 'GLOBAL',
        localBrandName: globalLocalBrandName,
        fallbackBrandName: values.name.trim(),
        localCategory: globalLocalCategory ?? null,
        allowCjkGlobalIdentity,
      });
      if (!globalCheck.ok) {
        setError(globalCheck.message);
        return;
      }
    }
    const hasGlobalOverrides = Boolean(
      values.markets.includes('GLOBAL') &&
      (globalLocalBrandName ||
        globalLocalCategory ||
        globalDomains.length > 0 ||
        allowCjkGlobalIdentity),
    );

    setSubmitting(true);
    try {
      const payload: CreateBrandInput =
        aliases.length > 0 || hasGlobalOverrides
          ? {
              name: values.name.trim(),
              category: values.category.trim(),
              markets: values.markets.map((market) =>
                market === 'GLOBAL'
                  ? {
                      market,
                      ...(globalLocalBrandName ? { localBrandName: globalLocalBrandName } : {}),
                      ...(globalLocalCategory ? { localCategory: globalLocalCategory } : {}),
                      ...(allowCjkGlobalIdentity ? { allowCjkGlobalIdentity: true } : {}),
                      aliases,
                      ownedDomains: globalDomains.length > 0 ? globalDomains : ownedDomains,
                      competitors,
                    }
                  : {
                      market,
                      aliases,
                      ownedDomains,
                      competitors,
                    },
              ),
              aliases,
              ownedDomains,
              competitors,
            }
          : {
              name: values.name.trim(),
              category: values.category.trim(),
              markets: values.markets,
              ownedDomains,
              competitors,
            };

      const created = await onCreateBrand(payload);
      feedback.notifySuccess(`已创建品牌「${created.name}」`);

      if (onExtractFacts && onSaveFacts) {
        setCreatedBrand(created);
        setExtractUrl(ownedDomains[0] ? `https://${ownedDomains[0]}` : '');
        setStep('extract');
      } else {
        onClose();
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error && reason.message ? reason.message : '创建品牌失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRunExtract = async () => {
    if (!createdBrand || !onExtractFacts) return;
    setExtractError(null);

    let request: ExtractBrandFactsRequest;
    if (extractMode === 'URL_EXTRACT') {
      const url = extractUrl.trim();
      if (!url) {
        setExtractError('请填写官网或产品详情页链接');
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
      const res = await onExtractFacts(createdBrand.id, request);
      const bySlot = new Map<BrandFactCoreSlot, ExtractedBrandFactDraft>();
      for (const item of res.facts) {
        bySlot.set(item.slot, item);
      }
      setDrafts(
        CORE_FACT_SLOTS.map((slot) => ({
          slot,
          title: bySlot.get(slot)?.title || BRAND_FACT_SLOT_LABELS[slot],
          content: bySlot.get(slot)?.content ?? '',
        })),
      );
      setDraftSourceType(res.sourceType);
      setDraftSourceUrl(res.sourceUrl);
      feedback.notifySuccess('已完成 4 块品牌事实卡提炼，请核对并勾选合规承诺后保存');
    } catch (reason: unknown) {
      setExtractError(
        reason instanceof Error && reason.message ? reason.message : 'AI 事实提炼失败，请稍后重试',
      );
    } finally {
      setExtracting(false);
    }
  };

  const runMarketPrefill = async (brandId: string, targetMarket: GeoMarket, sourceUrl?: string) => {
    if (!onSuggestMarketConfig) return;
    const seq = ++prefillSeqRef.current;
    setPrefillLoading(true);
    setPrefillError(null);
    setPrefillSuggestion(null);
    const trimmedUrl = sourceUrl?.trim() || '';
    try {
      const response = await onSuggestMarketConfig(
        brandId,
        targetMarket,
        trimmedUrl ? { sourceUrl: trimmedUrl } : {},
      );
      if (seq !== prefillSeqRef.current) return;
      setPrefillSuggestion(response);
      setPrefillError(null);
    } catch (reason: unknown) {
      if (seq !== prefillSeqRef.current) return;
      setPrefillError(
        reason instanceof Error && reason.message
          ? reason.message
          : 'AI 市场配置建议生成失败，您可以跳过直接进入工作区',
      );
    } finally {
      if (seq === prefillSeqRef.current) {
        setPrefillLoading(false);
      }
    }
  };

  const handleSaveExtractedFacts = async () => {
    if (!createdBrand || !onSaveFacts || !drafts) return;
    setExtractError(null);
    if (!truthAgreed) {
      setExtractError('请先勾选品牌事实真实性与合规承诺后再保存');
      return;
    }

    setSavingFacts(true);
    try {
      const saved = await onSaveFacts(createdBrand.id, {
        facts: drafts.map((item) => ({
          slot: item.slot,
          title: item.title.trim() || BRAND_FACT_SLOT_LABELS[item.slot],
          content: item.content.trim(),
          sourceType: draftSourceType,
          sourceUrl: draftSourceUrl,
        })),
        truthAgreed: true,
      });
      onBrandFactsSaved?.(createdBrand.id, saved.truthAgreementSignedAt);
      feedback.notifySuccess('已保存 4 块品牌事实卡');

      if (hasPrefillStep) {
        const targetMarket: GeoMarket = createdBrand.markets[0]?.market ?? 'CN';
        setPrefillMarket(targetMarket);
        setStep('prefill');
        void runMarketPrefill(createdBrand.id, targetMarket);
      } else {
        onClose();
      }
    } catch (reason: unknown) {
      setExtractError(
        reason instanceof Error && reason.message ? reason.message : '保存品牌事实卡失败',
      );
    } finally {
      setSavingFacts(false);
    }
  };

  const handleConfirmMarketPrefill = async (selection: BrandMarketAiSuggestSelection) => {
    if (!createdBrand || !onSaveMarketConfig) return;
    const existingMarket = createdBrand.markets.find((m) => m.market === prefillMarket);
    const merged = mergeAiMarketSuggestions({
      market: prefillMarket,
      current: {
        localBrandName: existingMarket?.localBrandName ?? createdBrand.name,
        localCategory: existingMarket?.localCategory ?? '',
        aliases: existingMarket?.aliases ?? [],
        competitors: existingMarket?.competitors ?? [],
        seedPrompts: existingMarket?.seedPrompts ?? [],
        controlPrompts: existingMarket?.controlPrompts ?? [],
      },
      selection,
    });

    const nextLocalBrandName = merged.localBrandName.trim() || createdBrand.name;
    const nextLocalCategory = merged.localCategory.trim() || null;
    const includeLocalBrandName =
      merged.addedCounts.localBrandName ||
      !(prefillMarket === 'GLOBAL' && containsCjk(nextLocalBrandName));
    const includeLocalCategory =
      merged.addedCounts.localCategory ||
      !(prefillMarket === 'GLOBAL' && nextLocalCategory !== null && containsCjk(nextLocalCategory));

    if (prefillMarket === 'GLOBAL') {
      if (includeLocalBrandName) {
        const nameCheck = validateGlobalMarketIdentity({
          market: 'GLOBAL',
          localBrandName: nextLocalBrandName,
          allowCjkGlobalIdentity: false,
        });
        if (!nameCheck.ok) {
          setPrefillError(nameCheck.message);
          return;
        }
      }
      if (includeLocalCategory) {
        const categoryCheck = validateGlobalMarketIdentity({
          market: 'GLOBAL',
          localCategory: nextLocalCategory,
          allowCjkGlobalIdentity: false,
        });
        if (!categoryCheck.ok) {
          setPrefillError(categoryCheck.message);
          return;
        }
      }
    }

    setPrefillSaving(true);
    setPrefillError(null);
    try {
      await onSaveMarketConfig(createdBrand.id, prefillMarket, {
        ...(includeLocalBrandName ? { localBrandName: nextLocalBrandName } : {}),
        ...(includeLocalCategory ? { localCategory: nextLocalCategory } : {}),
        aliases: merged.aliases,
        competitors: merged.competitors,
        seedPrompts: merged.seedPrompts,
        controlPrompts: merged.controlPrompts,
      });
      feedback.notifySuccess('已保存市场配置，可前往「可见度诊断」一键填入种子问句发起首轮监测');
      onClose();
    } catch (reason: unknown) {
      setPrefillError(
        reason instanceof Error && reason.message ? reason.message : '保存市场配置失败，请重试',
      );
    } finally {
      setPrefillSaving(false);
    }
  };

  const activePrefillMarketRecord =
    createdBrand?.markets.find((m) => m.market === prefillMarket) ?? null;

  return (
    <>
      <Modal
        open={open && step !== 'prefill'}
        title="60 秒创建品牌"
        width={660}
        onCancel={handleClose}
        keyboard={!busy}
        maskClosable={!busy}
        destroyOnHidden
        footer={null}
      >
        <div data-testid="brand-quick-create" className="gm-brand-quick-create">
          <div className="gm-brand-step-bar" aria-label="创建步骤">
            <span
              className={step === 'create' ? 'gm-brand-step is-active' : 'gm-brand-step is-done'}
            >
              1. 基础信息（60 秒）
            </span>
            <span className="gm-brand-step-sep" aria-hidden="true">
              →
            </span>
            <span
              className={
                step === 'extract'
                  ? 'gm-brand-step is-active'
                  : step === 'prefill'
                    ? 'gm-brand-step is-done'
                    : 'gm-brand-step'
              }
            >
              2. AI 提炼 4 块事实卡（可选 · 免费）
            </span>
            {hasPrefillStep ? (
              <>
                <span className="gm-brand-step-sep" aria-hidden="true">
                  →
                </span>
                <span className="gm-brand-step">3. AI 补全市场配置（可选 · 免费）</span>
              </>
            ) : null}
          </div>

          {step === 'create' ? (
            <Form<Step1FormValues>
              form={form}
              layout="vertical"
              scrollToFirstError
              initialValues={{ markets: ['CN'] }}
              onFinish={(values) => void handleCreateSubmit(values)}
            >
              <Form.Item
                label="品牌名称"
                name="name"
                validateFirst
                rules={[
                  { required: true, whitespace: true, message: '请填写品牌名称' },
                  { max: BRAND_NAME_MAX, message: `品牌名称不超过 ${BRAND_NAME_MAX} 字` },
                ]}
              >
                <Input
                  aria-label="品牌名称"
                  maxLength={BRAND_NAME_MAX}
                  disabled={readOnly || submitting}
                  placeholder="例如：绿联、智造激光"
                />
              </Form.Item>

              <Form.Item label="品牌别名（选填）">
                <div className="gm-brand-chip-input-row">
                  <Input
                    aria-label="品牌别名"
                    value={aliasInput}
                    maxLength={BRAND_NAME_MAX}
                    disabled={readOnly || submitting || aliases.length >= 20}
                    placeholder="输入别名或 SKU 系列词后回车添加"
                    onChange={(event) => setAliasInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        event.stopPropagation();
                        handleAddAlias();
                      }
                    }}
                  />
                  <Button
                    type="default"
                    autoInsertSpace={false}
                    disabled={readOnly || submitting || !aliasInput.trim() || aliases.length >= 20}
                    onClick={handleAddAlias}
                  >
                    添加
                  </Button>
                </div>
                {aliases.length > 0 ? (
                  <div className="gm-brand-chip-list">
                    {aliases.map((alias) => (
                      <Tag
                        key={alias}
                        closable={!readOnly && !submitting}
                        onClose={() => setAliases((prev) => prev.filter((item) => item !== alias))}
                      >
                        {alias}
                      </Tag>
                    ))}
                  </div>
                ) : null}
              </Form.Item>

              <Form.Item
                label="所属品类"
                name="category"
                validateFirst
                rules={[
                  { required: true, whitespace: true, message: '请填写所属品类' },
                  { max: BRAND_CATEGORY_MAX, message: `所属品类不超过 ${BRAND_CATEGORY_MAX} 字` },
                ]}
              >
                <Input
                  aria-label="所属品类"
                  maxLength={BRAND_CATEGORY_MAX}
                  disabled={readOnly || submitting}
                  placeholder="例如：家用 NAS、便携储能、工业激光设备"
                />
              </Form.Item>

              <Form.Item
                label="目标市场"
                name="markets"
                rules={[
                  {
                    validator: (_, value: GeoMarket[] | undefined) =>
                      Array.isArray(value) && value.length > 0
                        ? Promise.resolve()
                        : Promise.reject(new Error('请至少选择一个目标市场')),
                  },
                ]}
              >
                <Checkbox.Group
                  disabled={readOnly || submitting}
                  options={[
                    { label: '🇨🇳 国内市场 (CN · zh-CN)', value: 'CN' },
                    { label: '🌐 海外市场 (GLOBAL · en-US)', value: 'GLOBAL' },
                  ]}
                />
              </Form.Item>

              <Form.Item
                label="自有官网域名"
                name="ownedDomainsText"
                validateFirst
                rules={[
                  {
                    required: true,
                    whitespace: true,
                    message: '请填写有效的自有官网域名（如 example.com）',
                  },
                  {
                    validator: (_, value: string | undefined) => {
                      if (!value || !value.trim()) return Promise.resolve();
                      const { domains, invalidTokens } = validateDomainListInput(value);
                      if (invalidTokens.length > 0) {
                        return Promise.reject(
                          new Error(`域名格式不正确：${invalidTokens.join('、')}`),
                        );
                      }
                      if (domains.length === 0) {
                        return Promise.reject(
                          new Error('请填写有效的自有官网域名（如 example.com）'),
                        );
                      }
                      return Promise.resolve();
                    },
                  },
                ]}
              >
                <Input
                  aria-label="官网域名"
                  disabled={readOnly || submitting}
                  placeholder="例如：example.com（多个域名可用逗号分隔）"
                />
              </Form.Item>

              {hasGlobalSelected ? (
                <div
                  data-testid="brand-quick-create-global-fields"
                  className="gm-brand-qc-global-box"
                >
                  <div className="gm-brand-qc-global-title">
                    🌐 海外市场本地化身份（选填 · 建议填写纯英文避免英文种子问句与 Schema 混入中文）
                  </div>
                  <Form.Item
                    label="海外英文品牌名（选填）"
                    name="globalLocalBrandName"
                    rules={[
                      { max: BRAND_NAME_MAX, message: `品牌名称不超过 ${BRAND_NAME_MAX} 字` },
                    ]}
                    className="gm-brand-qc-item-sm"
                  >
                    <Input
                      aria-label="海外英文品牌名"
                      maxLength={BRAND_NAME_MAX}
                      disabled={readOnly || submitting}
                      placeholder="例如：ExampleBrand（留空默认继承主品牌名）"
                    />
                  </Form.Item>
                  <Form.Item
                    label="海外英文品类（选填）"
                    name="globalLocalCategory"
                    rules={[
                      {
                        max: BRAND_CATEGORY_MAX,
                        message: `所属品类不超过 ${BRAND_CATEGORY_MAX} 字`,
                      },
                    ]}
                    className="gm-brand-qc-item-sm"
                  >
                    <Input
                      aria-label="海外英文品类"
                      maxLength={BRAND_CATEGORY_MAX}
                      disabled={readOnly || submitting}
                      placeholder="例如：Portable Power Station / Wireless Earbuds"
                    />
                  </Form.Item>
                  <Form.Item
                    label="海外官网域名（选填）"
                    name="globalOwnedDomainsText"
                    className="gm-brand-qc-item-none"
                  >
                    <Input
                      aria-label="海外官网域名"
                      disabled={readOnly || submitting}
                      placeholder="例如：example.com（留空默认继承上方官网域名）"
                    />
                  </Form.Item>
                  {hasGlobalCjkIdentity ? (
                    <div className="gm-brand-global-cjk-guard gm-brand-mt-sm">
                      <Checkbox
                        data-testid="quick-create-allow-cjk-global-checkbox"
                        checked={allowCjkGlobalIdentity}
                        disabled={readOnly || submitting}
                        onChange={(event) => {
                          setAllowCjkGlobalIdentity(event.target.checked);
                          if (event.target.checked && error) setError(null);
                        }}
                      >
                        {GLOBAL_CJK_IDENTITY_OVERRIDE_LABEL}（确认保留中文用于海外市场）
                      </Checkbox>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <Form.Item
                label={`主要竞品（选填，最多 ${BRAND_MAX_COMPETITORS} 家 · ${competitorRows.length} / ${BRAND_MAX_COMPETITORS}）`}
              >
                <div className="gm-brand-competitor-list">
                  {competitorRows.map((row, idx) => (
                    <div key={row.key} className="gm-brand-competitor-row">
                      <Input
                        aria-label={`竞品名称 ${idx + 1}`}
                        value={row.name}
                        maxLength={BRAND_NAME_MAX}
                        disabled={readOnly || submitting}
                        placeholder="竞品名称（如 群晖）"
                        onChange={(event) =>
                          setCompetitorRows((prev) =>
                            prev.map((item) =>
                              item.key === row.key ? { ...item, name: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <Input
                        aria-label={`竞品官网域名 ${idx + 1}`}
                        value={row.domainsText}
                        disabled={readOnly || submitting}
                        placeholder="竞品官网域名（选填，如 synology.com）"
                        onChange={(event) =>
                          setCompetitorRows((prev) =>
                            prev.map((item) =>
                              item.key === row.key
                                ? { ...item, domainsText: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                      <button
                        type="button"
                        className="gm-brand-row-remove-btn"
                        aria-label={`移除竞品 ${row.name.trim() || idx + 1}`}
                        title="移除竞品"
                        disabled={readOnly || submitting}
                        onClick={() =>
                          setCompetitorRows((prev) => prev.filter((item) => item.key !== row.key))
                        }
                      >
                        <RemoveRowIcon />
                      </button>
                    </div>
                  ))}
                  <Button
                    type="dashed"
                    size="small"
                    disabled={
                      readOnly || submitting || competitorRows.length >= BRAND_MAX_COMPETITORS
                    }
                    onClick={() =>
                      setCompetitorRows((prev) =>
                        prev.length >= BRAND_MAX_COMPETITORS
                          ? prev
                          : [...prev, makeEmptyCompetitorRow()],
                      )
                    }
                  >
                    + 添加竞品
                  </Button>
                </div>
              </Form.Item>

              {error ? (
                <Alert type="error" showIcon message={error} className="gm-brand-inline-alert" />
              ) : null}

              <div className="gm-brand-modal-footer">
                <Button autoInsertSpace={false} disabled={submitting} onClick={handleClose}>
                  取消
                </Button>
                <Button type="primary" htmlType="submit" loading={submitting} disabled={readOnly}>
                  创建并进入工作区
                </Button>
              </div>
            </Form>
          ) : (
            <div className="gm-brand-extract-step">
              <Alert
                type="success"
                showIcon
                message={`品牌「${createdBrand?.name ?? ''}」已创建！`}
                description="贴入官网链接或上传产品资料（TXT / MD / PDF），AI 自动帮您提炼 4 块结构化品牌事实卡（免费，0 点）。"
                className="gm-brand-inline-alert"
              />

              <div className="gm-brand-mode-tabs" role="tablist" aria-label="资料来源方式">
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
                  disabled={extracting || savingFacts}
                  placeholder="https://example.com/product"
                  onChange={(event) => setExtractUrl(event.target.value)}
                />
              ) : extractMode === 'MANUAL' ? (
                <Input.TextArea
                  aria-label="粘贴产品资料"
                  rows={4}
                  value={extractText}
                  disabled={extracting || savingFacts}
                  placeholder="粘贴产品参数表、核心卖点、资质证书或客户案例文本（至少 10 字）"
                  onChange={(event) => setExtractText(event.target.value)}
                />
              ) : (
                <div className="gm-brand-file-picker">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={FACT_EXTRACT_ACCEPT}
                    aria-label="上传品牌资料文档"
                    disabled={extracting || savingFacts}
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

              <div className="gm-brand-qc-extract-action">
                <Button
                  type={drafts ? 'default' : 'primary'}
                  loading={extracting}
                  disabled={savingFacts}
                  onClick={() => void handleRunExtract()}
                >
                  AI 提炼 4 块事实卡（免费）
                </Button>
              </div>

              {drafts ? (
                <div className="gm-brand-draft-list">
                  {drafts.map((item) => (
                    <div key={item.slot} className="gm-brand-draft-item">
                      <div className="gm-brand-draft-head">
                        <strong>{BRAND_FACT_SLOT_LABELS[item.slot]}</strong>
                      </div>
                      <Input.TextArea
                        aria-label={`提炼草稿 ${BRAND_FACT_SLOT_LABELS[item.slot]}`}
                        rows={3}
                        value={item.content}
                        disabled={savingFacts}
                        onChange={(event) =>
                          setDrafts((prev) =>
                            prev
                              ? prev.map((row) =>
                                  row.slot === item.slot
                                    ? { ...row, content: event.target.value }
                                    : row,
                                )
                              : prev,
                          )
                        }
                      />
                    </div>
                  ))}

                  <div className="gm-brand-truth-bar">
                    <Checkbox
                      checked={truthAgreed}
                      disabled={savingFacts}
                      onChange={(event) => setTruthAgreed(event.target.checked)}
                    >
                      {BRAND_TRUTH_CHECKBOX_LABEL}
                    </Checkbox>
                    <Button type="link" size="small" onClick={() => setTermsOpen(true)}>
                      查看承诺协议全文
                    </Button>
                  </div>
                </div>
              ) : null}

              {extractError ? (
                <Alert
                  type="error"
                  showIcon
                  message={extractError}
                  className="gm-brand-mt-sm gm-brand-mb-xs"
                />
              ) : null}

              <div className="gm-brand-modal-footer">
                <Button disabled={busy} onClick={handleClose}>
                  跳过，直接进入
                </Button>
                {drafts ? (
                  <Button
                    type="primary"
                    loading={savingFacts}
                    disabled={extracting}
                    onClick={() => void handleSaveExtractedFacts()}
                  >
                    保存事实卡并完成
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </Modal>

      <BrandMarketAiSuggestModal
        open={open && step === 'prefill'}
        market={prefillMarket}
        mode="full"
        loading={prefillLoading}
        saving={prefillSaving}
        error={prefillError}
        suggestion={prefillSuggestion}
        currentLocalBrandName={
          activePrefillMarketRecord?.localBrandName ?? createdBrand?.name ?? ''
        }
        currentLocalCategory={activePrefillMarketRecord?.localCategory ?? ''}
        sourceUrl={prefillSourceUrl}
        allowSourceUrl={true}
        confirmLabel="保存市场配置并完成"
        cancelLabel="跳过，直接进入"
        footerHint="勾选确认后直接保存市场配置，随后可在可见度诊断页一键填入种子问句发起首轮监测。"
        onSourceUrlChange={setPrefillSourceUrl}
        onRegenerate={(url) => {
          if (createdBrand) {
            void runMarketPrefill(createdBrand.id, prefillMarket, url);
          }
        }}
        onConfirm={handleConfirmMarketPrefill}
        onCancel={handleClose}
      />

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
    </>
  );
}
