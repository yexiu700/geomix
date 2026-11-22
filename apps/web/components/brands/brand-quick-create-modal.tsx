'use client';

import {
  BRAND_CATEGORY_MAX,
  BRAND_FACT_SLOT_LABELS,
  BRAND_MAX_COMPETITORS,
  BRAND_NAME_MAX,
  BRAND_TRUTH_AGREEMENT_PARAGRAPHS,
  BRAND_TRUTH_AGREEMENT_TITLE,
  BRAND_TRUTH_CHECKBOX_LABEL,
  type BrandFactCoreSlot,
  type BrandFactsResponse,
  type BrandRecord,
  type CreateBrandInput,
  type ExtractBrandFactsResponse,
  type ExtractedBrandFactDraft,
  type FactSourceType,
  type GeoMarket,
  type UpsertBrandFactsInput,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Form, Input, Modal, Space, Tag } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { ExtractBrandFactsRequest } from '../../lib/brands';
import { useUxFeedback } from '../crud/ux-feedback';
import {
  CORE_FACT_SLOTS,
  FACT_EXTRACT_ACCEPT,
  serializeCompetitorRows,
  validateDomainListInput,
  validateFactUploadFile,
  type CompetitorDraftRow,
} from './brand-form-helpers';

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
};

let rowSeq = 1;
function makeEmptyCompetitorRow(): CompetitorDraftRow {
  rowSeq += 1;
  return { key: `qc-comp-${rowSeq}`, name: '', domainsText: '' };
}

export function BrandQuickCreateModal({
  open,
  readOnly = false,
  onClose,
  onCreateBrand,
  onExtractFacts,
  onSaveFacts,
  onBrandFactsSaved,
}: BrandQuickCreateModalProps) {
  const feedback = useUxFeedback();
  const [form] = Form.useForm<Step1FormValues>();
  const watchedMarkets = Form.useWatch('markets', form);
  const hasGlobalSelected = Array.isArray(watchedMarkets) && watchedMarkets.includes('GLOBAL');
  const [step, setStep] = useState<'create' | 'extract'>('create');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!open) return;
    setStep('create');
    setSubmitting(false);
    setError(null);
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

  const busy = submitting || extracting || savingFacts;

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
    const hasGlobalOverrides = Boolean(
      values.markets.includes('GLOBAL') &&
      (globalLocalBrandName || globalLocalCategory || globalDomains.length > 0),
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
      onClose();
    } catch (reason: unknown) {
      setExtractError(
        reason instanceof Error && reason.message ? reason.message : '保存品牌事实卡失败',
      );
    } finally {
      setSavingFacts(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
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
            <span className={step === 'extract' ? 'gm-brand-step is-active' : 'gm-brand-step'}>
              2. AI 提炼 4 块事实卡（可选 · 免费）
            </span>
          </div>

          {step === 'create' ? (
            <Form<Step1FormValues>
              form={form}
              layout="vertical"
              initialValues={{ markets: ['CN'] }}
              onFinish={(values) => void handleCreateSubmit(values)}
            >
              <Form.Item
                label="品牌名称"
                name="name"
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
                    onPressEnter={(event) => {
                      event.preventDefault();
                      handleAddAlias();
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
                rules={[
                  {
                    required: true,
                    whitespace: true,
                    message: '请填写有效的自有官网域名（如 example.com）',
                  },
                  {
                    validator: (_, value: string | undefined) => {
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
                  style={{
                    padding: 12,
                    marginBottom: 16,
                    borderRadius: 'var(--gm-radius-sm)',
                    border: '1px solid var(--gm-line-2)',
                    background: 'var(--gm-bg-elevated)',
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--gm-fg-1)',
                      marginBottom: 8,
                    }}
                  >
                    🌐 海外市场本地化身份（选填 · 建议填写纯英文避免英文种子问句与 Schema 混入中文）
                  </div>
                  <Form.Item
                    label="海外英文品牌名（选填）"
                    name="globalLocalBrandName"
                    rules={[
                      { max: BRAND_NAME_MAX, message: `品牌名称不超过 ${BRAND_NAME_MAX} 字` },
                    ]}
                    style={{ marginBottom: 10 }}
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
                    style={{ marginBottom: 10 }}
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
                    style={{ marginBottom: 0 }}
                  >
                    <Input
                      aria-label="海外官网域名"
                      disabled={readOnly || submitting}
                      placeholder="例如：example.com（留空默认继承上方官网域名）"
                    />
                  </Form.Item>
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
                      <Button
                        size="small"
                        danger
                        autoInsertSpace={false}
                        disabled={readOnly || submitting}
                        onClick={() =>
                          setCompetitorRows((prev) => prev.filter((item) => item.key !== row.key))
                        }
                      >
                        移除
                      </Button>
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
                <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
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
                style={{ marginBottom: 12 }}
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

              <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                  type="primary"
                  ghost
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
                  style={{ marginTop: 10, marginBottom: 4 }}
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
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {BRAND_TRUTH_AGREEMENT_PARAGRAPHS.map((para, idx) => (
            <p key={idx} style={{ margin: 0, color: 'var(--gm-fg-2)', lineHeight: 1.7 }}>
              {para}
            </p>
          ))}
        </Space>
      </Modal>
    </>
  );
}
