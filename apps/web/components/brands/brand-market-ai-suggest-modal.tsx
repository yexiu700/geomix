'use client';

import {
  BRAND_CATEGORY_MAX,
  BRAND_NAME_MAX,
  BRAND_SEED_PROMPT_INTENTS,
  BRAND_SEED_PROMPT_INTENT_LABELS,
  GEO_MARKET_LABELS,
  containsCjk,
  type BrandCompetitor,
  type BrandMarketAiSuggestResponse,
  type BrandSeedPromptIntent,
  type GeoMarket,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Input, Modal, Skeleton } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { EmptyState, StatusBadge } from '../ui';
import {
  parseCompetitorAliases,
  parseDomainTokens,
  type BrandMarketAiSuggestSelection,
} from './brand-form-helpers';

export type BrandMarketAiSuggestMode = 'full' | 'seedPrompts' | 'localIdentity';

export type BrandMarketAiSuggestModalProps = {
  open: boolean;
  market: GeoMarket;
  mode: BrandMarketAiSuggestMode;
  loading: boolean;
  saving?: boolean;
  error: string | null;
  suggestion: BrandMarketAiSuggestResponse | null;
  currentLocalBrandName?: string;
  currentLocalCategory?: string;
  sourceUrl?: string;
  allowSourceUrl?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  footerHint?: string;
  onSourceUrlChange?: (value: string) => void;
  onRegenerate?: (sourceUrl?: string) => void;
  onConfirm: (selection: BrandMarketAiSuggestSelection) => void | Promise<void>;
  onCancel: () => void;
};

type EditableAliasItem = {
  id: string;
  checked: boolean;
  value: string;
};

type EditableCompetitorItem = {
  id: string;
  checked: boolean;
  name: string;
  domainsText: string;
  aliasesText: string;
};

type EditableSeedPromptItem = {
  id: string;
  checked: boolean;
  intent: BrandSeedPromptIntent;
  prompt: string;
};

type EditableControlPromptItem = {
  id: string;
  checked: boolean;
  prompt: string;
};

function resolveModalTitle(mode: BrandMarketAiSuggestMode, market: GeoMarket): string {
  const marketLabel = GEO_MARKET_LABELS[market];
  if (mode === 'seedPrompts') {
    return `AI 生成高频监控问句（${marketLabel}）`;
  }
  if (mode === 'localIdentity') {
    return 'AI 一键英文本地化（海外市场）';
  }
  return `AI 一键补全市场配置（${marketLabel}）`;
}

export function BrandMarketAiSuggestModal({
  open,
  market,
  mode,
  loading,
  saving = false,
  error,
  suggestion,
  currentLocalBrandName = '',
  currentLocalCategory = '',
  sourceUrl = '',
  allowSourceUrl = false,
  confirmLabel = '采纳所选项',
  cancelLabel = '取消',
  footerHint = '仅追加去重，不覆盖已有手调内容；采纳后需点击保存落库。',
  onSourceUrlChange,
  onRegenerate,
  onConfirm,
  onCancel,
}: BrandMarketAiSuggestModalProps) {
  const [localNameChecked, setLocalNameChecked] = useState(false);
  const [localNameDraft, setLocalNameDraft] = useState('');
  const [localCategoryChecked, setLocalCategoryChecked] = useState(false);
  const [localCategoryDraft, setLocalCategoryDraft] = useState('');
  const [aliasItems, setAliasItems] = useState<EditableAliasItem[]>([]);
  const [competitorItems, setCompetitorItems] = useState<EditableCompetitorItem[]>([]);
  const [seedItems, setSeedItems] = useState<EditableSeedPromptItem[]>([]);
  const [controlItems, setControlItems] = useState<EditableControlPromptItem[]>([]);

  useEffect(() => {
    if (!open || !suggestion) return;

    const hasSuggestedLocalName = Boolean(market === 'GLOBAL' && suggestion.localBrandName?.trim());
    const hasSuggestedLocalCat = Boolean(market === 'GLOBAL' && suggestion.localCategory?.trim());
    const currentNameClean = currentLocalBrandName.trim();
    const currentCatClean = currentLocalCategory.trim();

    // Default checked when replacing empty/CJK identity or explicitly in localIdentity mode;
    // when user already customized a clean English value in full mode, default unchecked to avoid overwriting.
    const shouldDefaultCheckLocalName =
      hasSuggestedLocalName &&
      (mode === 'localIdentity' || !currentNameClean || containsCjk(currentNameClean));
    const shouldDefaultCheckLocalCat =
      hasSuggestedLocalCat &&
      (mode === 'localIdentity' || !currentCatClean || containsCjk(currentCatClean));

    setLocalNameChecked(shouldDefaultCheckLocalName);
    setLocalNameDraft(suggestion.localBrandName?.trim() ?? '');
    setLocalCategoryChecked(shouldDefaultCheckLocalCat);
    setLocalCategoryDraft(suggestion.localCategory?.trim() ?? '');

    setAliasItems(
      (suggestion.aliases ?? []).map((value, idx) => ({
        id: `alias-${idx}`,
        checked: true,
        value,
      })),
    );
    setCompetitorItems(
      (suggestion.competitors ?? []).map((comp, idx) => ({
        id: `comp-${idx}`,
        checked: true,
        name: comp.name,
        domainsText: comp.domains.join(', '),
        aliasesText: comp.aliases.join(', '),
      })),
    );
    setSeedItems(
      (suggestion.seedPrompts ?? []).map((item, idx) => ({
        id: `seed-${idx}`,
        checked: true,
        intent: item.intent,
        prompt: item.prompt,
      })),
    );
    setControlItems(
      (suggestion.controlPrompts ?? []).map((prompt, idx) => ({
        id: `ctrl-${idx}`,
        checked: true,
        prompt,
      })),
    );
  }, [open, suggestion, market, mode, currentLocalBrandName, currentLocalCategory]);

  const hasLocalIdentityGroup =
    market === 'GLOBAL' && Boolean(localNameDraft.trim() || localCategoryDraft.trim());

  const seedGroups = useMemo(() => {
    const byIntent = new Map<BrandSeedPromptIntent, EditableSeedPromptItem[]>();
    for (const intent of BRAND_SEED_PROMPT_INTENTS) {
      byIntent.set(intent, []);
    }
    for (const item of seedItems) {
      byIntent.get(item.intent)?.push(item);
    }
    return BRAND_SEED_PROMPT_INTENTS.map((intent) => ({
      intent,
      label: BRAND_SEED_PROMPT_INTENT_LABELS[intent],
      items: byIntent.get(intent) ?? [],
    })).filter((group) => group.items.length > 0);
  }, [seedItems]);

  const selectedLocalCount =
    (localNameChecked && localNameDraft.trim() ? 1 : 0) +
    (localCategoryChecked && localCategoryDraft.trim() ? 1 : 0);
  const selectedAliasCount = aliasItems.filter((item) => item.checked && item.value.trim()).length;
  const selectedCompetitorCount = competitorItems.filter(
    (item) => item.checked && item.name.trim(),
  ).length;
  const selectedSeedCount = seedItems.filter(
    (item) => item.checked && item.prompt.trim().length >= 2,
  ).length;
  const selectedControlCount = controlItems.filter(
    (item) => item.checked && item.prompt.trim().length >= 2,
  ).length;

  const totalSelected =
    selectedLocalCount +
    selectedAliasCount +
    selectedCompetitorCount +
    selectedSeedCount +
    selectedControlCount;

  const hasAnySuggestions =
    hasLocalIdentityGroup ||
    aliasItems.length > 0 ||
    competitorItems.length > 0 ||
    seedItems.length > 0 ||
    controlItems.length > 0;

  const busy = loading || saving;

  const handleConfirmClick = () => {
    const selectedCompetitors: BrandCompetitor[] = competitorItems
      .filter((item) => item.checked && item.name.trim())
      .map((item) => ({
        name: item.name.trim().slice(0, BRAND_NAME_MAX),
        domains: parseDomainTokens(item.domainsText),
        aliases: parseCompetitorAliases(item.aliasesText),
      }));

    const selection: BrandMarketAiSuggestSelection = {
      ...(market === 'GLOBAL' && localNameChecked && localNameDraft.trim()
        ? { localBrandName: localNameDraft.trim().slice(0, BRAND_NAME_MAX) }
        : {}),
      ...(market === 'GLOBAL' && localCategoryChecked && localCategoryDraft.trim()
        ? { localCategory: localCategoryDraft.trim().slice(0, BRAND_CATEGORY_MAX) }
        : {}),
      aliases: aliasItems
        .filter((item) => item.checked && item.value.trim())
        .map((item) => item.value.trim().slice(0, BRAND_NAME_MAX)),
      competitors: selectedCompetitors,
      seedPrompts: seedItems
        .filter((item) => item.checked && item.prompt.trim().length >= 2)
        .map((item) => item.prompt.trim().slice(0, 300)),
      controlPrompts: controlItems
        .filter((item) => item.checked && item.prompt.trim().length >= 2)
        .map((item) => item.prompt.trim().slice(0, 300)),
    };

    void onConfirm(selection);
  };

  return (
    <Modal
      open={open}
      title={resolveModalTitle(mode, market)}
      width={740}
      onCancel={() => {
        if (!saving) onCancel();
      }}
      keyboard={!saving}
      maskClosable={!saving}
      destroyOnHidden
      footer={null}
    >
      <div className="gm-brand-ai-modal" data-testid="brand-ai-suggest-modal">
        {allowSourceUrl && onRegenerate ? (
          <div className="gm-brand-ai-url-bar">
            <Input
              aria-label="补充商品页链接（选填）"
              value={sourceUrl}
              disabled={busy}
              placeholder="选填：粘贴 1 个商品/产品详情页链接补充 SKU 与卖点"
              onChange={(event) => onSourceUrlChange?.(event.target.value)}
              onPressEnter={(event) => {
                event.preventDefault();
                if (!busy) onRegenerate(sourceUrl);
              }}
            />
            <Button
              size="middle"
              loading={loading}
              disabled={saving}
              className="gm-brand-btn-nowrap"
              onClick={() => onRegenerate(sourceUrl)}
            >
              结合链接重新生成
            </Button>
          </div>
        ) : null}

        {loading ? (
          <div className="gm-brand-ai-loading" data-testid="brand-ai-suggest-loading">
            <p className="gm-brand-ai-loading-copy">
              正在综合品牌主档、当前市场配置与品牌事实卡生成建议...
            </p>
            <Skeleton active paragraph={{ rows: 6 }} />
          </div>
        ) : error ? (
          <Alert
            type="error"
            showIcon
            data-testid="brand-ai-suggest-error"
            className="gm-brand-inline-alert"
            message={error}
            action={
              onRegenerate ? (
                <Button size="small" onClick={() => onRegenerate(sourceUrl)}>
                  重试
                </Button>
              ) : undefined
            }
          />
        ) : suggestion ? (
          <div className="gm-brand-ai-groups">
            {suggestion.fallbackUsed || (suggestion.warnings && suggestion.warnings.length > 0) ? (
              <Alert
                type="warning"
                showIcon
                data-testid="brand-ai-suggest-fallback-notice"
                className="gm-brand-inline-alert"
                message={
                  suggestion.fallbackUsed
                    ? '已使用品类规则模板生成建议（不影响勾选与采纳）'
                    : '生成提示'
                }
                description={suggestion.warnings?.join('；')}
              />
            ) : null}

            {!hasAnySuggestions ? (
              <EmptyState
                size="compact"
                title="当前市场配置已较完善，暂无新增建议"
                description="您可粘贴具体产品详情页链接重新生成，或直接手动微调配置。"
              />
            ) : null}

            {/* Group 0: GLOBAL English Identity */}
            {hasLocalIdentityGroup ? (
              <section
                className="gm-brand-ai-group"
                data-testid="ai-suggest-group-localIdentity"
                aria-label="海外英文身份建议"
              >
                <div className="gm-brand-ai-group-head">
                  <div className="gm-brand-ai-group-title">
                    <h4>海外英文身份与品类</h4>
                    <StatusBadge tone="neutral" size="sm" label={`已选 ${selectedLocalCount}`} />
                  </div>
                </div>
                <div className="gm-brand-ai-rows">
                  {localNameDraft.trim() ? (
                    <div className="gm-brand-ai-row">
                      <Checkbox
                        aria-label="勾选建议海外英文品牌名"
                        checked={localNameChecked}
                        disabled={saving}
                        onChange={(event) => setLocalNameChecked(event.target.checked)}
                      />
                      <span className="gm-brand-ai-field-label">当地品牌名</span>
                      <Input
                        aria-label="编辑建议海外英文品牌名"
                        value={localNameDraft}
                        maxLength={BRAND_NAME_MAX}
                        disabled={saving}
                        onChange={(event) => setLocalNameDraft(event.target.value)}
                      />
                      {currentLocalBrandName.trim() && !containsCjk(currentLocalBrandName) ? (
                        <StatusBadge tone="neutral" size="sm" label="已有英文名" />
                      ) : null}
                    </div>
                  ) : null}
                  {localCategoryDraft.trim() ? (
                    <div className="gm-brand-ai-row">
                      <Checkbox
                        aria-label="勾选建议海外英文品类"
                        checked={localCategoryChecked}
                        disabled={saving}
                        onChange={(event) => setLocalCategoryChecked(event.target.checked)}
                      />
                      <span className="gm-brand-ai-field-label">当地品类</span>
                      <Input
                        aria-label="编辑建议海外英文品类"
                        value={localCategoryDraft}
                        maxLength={BRAND_CATEGORY_MAX}
                        disabled={saving}
                        onChange={(event) => setLocalCategoryDraft(event.target.value)}
                      />
                      {currentLocalCategory.trim() && !containsCjk(currentLocalCategory) ? (
                        <StatusBadge tone="neutral" size="sm" label="已有英文品类" />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}

            {/* Group 1: Aliases & SKUs */}
            {aliasItems.length > 0 ? (
              <section
                className="gm-brand-ai-group"
                data-testid="ai-suggest-group-aliases"
                aria-label="SKU 与品牌别名建议"
              >
                <div className="gm-brand-ai-group-head">
                  <div className="gm-brand-ai-group-title">
                    <h4>SKU 型号与品牌别名</h4>
                    <StatusBadge
                      tone="neutral"
                      size="sm"
                      label={`已选 ${selectedAliasCount} / ${aliasItems.length}`}
                    />
                  </div>
                  <Button
                    type="link"
                    size="small"
                    disabled={saving}
                    onClick={() => {
                      const nextChecked = selectedAliasCount < aliasItems.length;
                      setAliasItems((prev) =>
                        prev.map((item) => ({ ...item, checked: nextChecked })),
                      );
                    }}
                  >
                    {selectedAliasCount < aliasItems.length ? '全选本组' : '取消全选'}
                  </Button>
                </div>
                <div className="gm-brand-ai-alias-grid">
                  {aliasItems.map((item, idx) => (
                    <div key={item.id} className="gm-brand-ai-row">
                      <Checkbox
                        aria-label={`勾选别名建议 ${idx + 1}`}
                        checked={item.checked}
                        disabled={saving}
                        onChange={(event) =>
                          setAliasItems((prev) =>
                            prev.map((row) =>
                              row.id === item.id ? { ...row, checked: event.target.checked } : row,
                            ),
                          )
                        }
                      />
                      <Input
                        aria-label={`编辑别名建议 ${idx + 1}`}
                        value={item.value}
                        maxLength={BRAND_NAME_MAX}
                        disabled={saving}
                        onChange={(event) =>
                          setAliasItems((prev) =>
                            prev.map((row) =>
                              row.id === item.id ? { ...row, value: event.target.value } : row,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {/* Group 2: Competitors */}
            {competitorItems.length > 0 ? (
              <section
                className="gm-brand-ai-group"
                data-testid="ai-suggest-group-competitors"
                aria-label="主要竞品与域名建议"
              >
                <div className="gm-brand-ai-group-head">
                  <div className="gm-brand-ai-group-title">
                    <h4>主要竞品与官网域名</h4>
                    <StatusBadge
                      tone="neutral"
                      size="sm"
                      label={`已选 ${selectedCompetitorCount} / ${competitorItems.length}`}
                    />
                  </div>
                  <Button
                    type="link"
                    size="small"
                    disabled={saving}
                    onClick={() => {
                      const nextChecked = selectedCompetitorCount < competitorItems.length;
                      setCompetitorItems((prev) =>
                        prev.map((item) => ({ ...item, checked: nextChecked })),
                      );
                    }}
                  >
                    {selectedCompetitorCount < competitorItems.length ? '全选本组' : '取消全选'}
                  </Button>
                </div>
                <div className="gm-brand-ai-rows">
                  {competitorItems.map((item, idx) => (
                    <div key={item.id} className="gm-brand-ai-comp-row">
                      <Checkbox
                        aria-label={`勾选竞品建议 ${idx + 1}`}
                        checked={item.checked}
                        disabled={saving}
                        onChange={(event) =>
                          setCompetitorItems((prev) =>
                            prev.map((row) =>
                              row.id === item.id ? { ...row, checked: event.target.checked } : row,
                            ),
                          )
                        }
                      />
                      <Input
                        aria-label={`编辑竞品名称建议 ${idx + 1}`}
                        value={item.name}
                        maxLength={BRAND_NAME_MAX}
                        disabled={saving}
                        placeholder="竞品名"
                        onChange={(event) =>
                          setCompetitorItems((prev) =>
                            prev.map((row) =>
                              row.id === item.id ? { ...row, name: event.target.value } : row,
                            ),
                          )
                        }
                      />
                      <Input
                        aria-label={`编辑竞品域名建议 ${idx + 1}`}
                        value={item.domainsText}
                        disabled={saving}
                        placeholder="竞品官网域名（逗号分隔）"
                        onChange={(event) =>
                          setCompetitorItems((prev) =>
                            prev.map((row) =>
                              row.id === item.id
                                ? { ...row, domainsText: event.target.value }
                                : row,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {/* Group 3: Seed Prompts (grouped by intent) */}
            {seedItems.length > 0 ? (
              <section
                className="gm-brand-ai-group"
                data-testid="ai-suggest-group-seedPrompts"
                aria-label="分意图高频监控问句建议"
              >
                <div className="gm-brand-ai-group-head">
                  <div className="gm-brand-ai-group-title">
                    <h4>高频监控问句（分意图）</h4>
                    <StatusBadge
                      tone="neutral"
                      size="sm"
                      label={`已选 ${selectedSeedCount} / ${seedItems.length}`}
                    />
                  </div>
                  <Button
                    type="link"
                    size="small"
                    disabled={saving}
                    onClick={() => {
                      const nextChecked = selectedSeedCount < seedItems.length;
                      setSeedItems((prev) =>
                        prev.map((item) => ({ ...item, checked: nextChecked })),
                      );
                    }}
                  >
                    {selectedSeedCount < seedItems.length ? '全选本组' : '取消全选'}
                  </Button>
                </div>
                <div className="gm-brand-ai-intent-list">
                  {seedGroups.map((group) => (
                    <div key={group.intent} className="gm-brand-ai-intent-block">
                      <div className="gm-brand-ai-intent-head">
                        <StatusBadge tone="active" size="sm" label={group.label} />
                      </div>
                      <div className="gm-brand-ai-rows">
                        {group.items.map((item) => (
                          <div key={item.id} className="gm-brand-ai-row">
                            <Checkbox
                              aria-label={`勾选种子问句 ${item.prompt}`}
                              checked={item.checked}
                              disabled={saving}
                              onChange={(event) =>
                                setSeedItems((prev) =>
                                  prev.map((row) =>
                                    row.id === item.id
                                      ? { ...row, checked: event.target.checked }
                                      : row,
                                  ),
                                )
                              }
                            />
                            <Input
                              aria-label={`编辑种子问句 ${item.id}`}
                              value={item.prompt}
                              maxLength={300}
                              disabled={saving}
                              onChange={(event) =>
                                setSeedItems((prev) =>
                                  prev.map((row) =>
                                    row.id === item.id
                                      ? { ...row, prompt: event.target.value }
                                      : row,
                                  ),
                                )
                              }
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {/* Group 4: Control Prompts */}
            {controlItems.length > 0 ? (
              <section
                className="gm-brand-ai-group"
                data-testid="ai-suggest-group-controlPrompts"
                aria-label="对照组问句建议"
              >
                <div className="gm-brand-ai-group-head">
                  <div className="gm-brand-ai-group-title">
                    <h4>对照组问句（DiD 归因基线）</h4>
                    <StatusBadge
                      tone="neutral"
                      size="sm"
                      label={`已选 ${selectedControlCount} / ${controlItems.length}`}
                    />
                  </div>
                  <Button
                    type="link"
                    size="small"
                    disabled={saving}
                    onClick={() => {
                      const nextChecked = selectedControlCount < controlItems.length;
                      setControlItems((prev) =>
                        prev.map((item) => ({ ...item, checked: nextChecked })),
                      );
                    }}
                  >
                    {selectedControlCount < controlItems.length ? '全选本组' : '取消全选'}
                  </Button>
                </div>
                <div className="gm-brand-ai-rows">
                  {controlItems.map((item, idx) => (
                    <div key={item.id} className="gm-brand-ai-row">
                      <Checkbox
                        aria-label={`勾选对照组问句 ${idx + 1}`}
                        checked={item.checked}
                        disabled={saving}
                        onChange={(event) =>
                          setControlItems((prev) =>
                            prev.map((row) =>
                              row.id === item.id ? { ...row, checked: event.target.checked } : row,
                            ),
                          )
                        }
                      />
                      <Input
                        aria-label={`编辑对照组问句 ${idx + 1}`}
                        value={item.prompt}
                        maxLength={300}
                        disabled={saving}
                        onChange={(event) =>
                          setControlItems((prev) =>
                            prev.map((row) =>
                              row.id === item.id ? { ...row, prompt: event.target.value } : row,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        <div className="gm-brand-ai-footer">
          <span className="gm-brand-ai-footer-hint">
            {totalSelected > 0 ? `已选 ${totalSelected} 项 · ${footerHint}` : footerHint}
          </span>
          <div className="gm-brand-ai-footer-actions">
            <Button autoInsertSpace={false} disabled={saving} onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button
              type="primary"
              data-testid="brand-ai-suggest-confirm-btn"
              loading={saving}
              disabled={loading || totalSelected === 0}
              onClick={handleConfirmClick}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
