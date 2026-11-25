'use client';

import {
  BRAND_CATEGORY_MAX,
  BRAND_DEFAULT_RETEST_CONTROL_PROMPTS,
  BRAND_MAX_COMPETITORS,
  BRAND_MAX_CONTROL_PROMPTS,
  BRAND_NAME_MAX,
  GEO_MARKET_LABELS,
  GLOBAL_SUPPORTED_LOCALES,
  SUPPORTED_LOCALES,
  containsCjk,
  generateBrandSeedPrompts,
  normalizeBrandDomain,
  validateControlPromptsAgainstSeeds,
  type BrandMarketRecord,
  type BrandRecord,
  type GeoMarket,
  type SupportedLocale,
} from '@geomix/shared';
import { Alert, Button, Input, Select, Tag } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { updateBrand, updateBrandMarket } from '../../lib/brands';
import { invalidateFreshness } from '../../lib/tab-freshness';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { useUxFeedback } from '../crud/ux-feedback';
import { FormField, Section, StatusBadge } from '../ui';
import {
  hydrateCompetitorRows,
  parseCompetitorAliases,
  parseDomainTokens,
  serializeCompetitorRows,
  type CompetitorDraftRow,
} from './brand-form-helpers';

export type BrandIdentitySectionProps = {
  brand: BrandRecord;
  activeMarket: GeoMarket;
  activeBrandMarket: BrandMarketRecord | null;
  readOnly: boolean;
  onBrandUpdated: (brand: BrandRecord, market?: GeoMarket) => void;
  onOpenEnableMarket: (market: GeoMarket) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

let identityCompSeq = 1;
function createBlankCompetitor(): CompetitorDraftRow {
  identityCompSeq += 1;
  return { key: `id-comp-${identityCompSeq}`, name: '', domainsText: '', aliasesText: '' };
}

function resolveInitialLocales(market: GeoMarket, bm: BrandMarketRecord | null): SupportedLocale[] {
  if (market === 'CN') return ['zh-CN'];
  const raw = bm?.supportedLocales ?? [];
  const validGlobal = raw.filter((code) =>
    (GLOBAL_SUPPORTED_LOCALES as readonly string[]).includes(code),
  );
  if (validGlobal.length > 0) return [...new Set(validGlobal)];
  if (bm?.locale && (GLOBAL_SUPPORTED_LOCALES as readonly string[]).includes(bm.locale)) {
    return [bm.locale as SupportedLocale];
  }
  return ['en-US'];
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function competitorRowsEqual(
  a: readonly CompetitorDraftRow[],
  b: readonly CompetitorDraftRow[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.name !== right.name ||
      left.domainsText !== right.domainsText ||
      (left.aliasesText ?? '') !== (right.aliasesText ?? '')
    ) {
      return false;
    }
  }
  return true;
}

type MarketDirtyInput = {
  activeMarket: GeoMarket;
  brand: BrandRecord;
  activeBrandMarket: BrandMarketRecord | null;
  initialCompetitors: readonly CompetitorDraftRow[];
  initialSupportedLocales: readonly SupportedLocale[];
  localBrandName: string;
  localCategory: string;
  aliases: readonly string[];
  ownedDomains: readonly string[];
  competitorRows: readonly CompetitorDraftRow[];
  seedPrompts: readonly string[];
  supportedLocales: readonly SupportedLocale[];
  controlPrompts: readonly string[];
};

function computeMarketDirty(input: MarketDirtyInput): boolean {
  const { activeBrandMarket, brand, activeMarket } = input;
  if (!activeBrandMarket) return false;
  if (input.localBrandName !== (activeBrandMarket.localBrandName ?? brand.name)) return true;
  if (input.localCategory !== (activeBrandMarket.localCategory ?? '')) return true;
  if (!stringArraysEqual(input.aliases, activeBrandMarket.aliases ?? [])) return true;
  if (!stringArraysEqual(input.ownedDomains, activeBrandMarket.ownedDomains ?? [])) return true;
  if (!competitorRowsEqual(input.competitorRows, input.initialCompetitors)) return true;
  if (!stringArraysEqual(input.seedPrompts, activeBrandMarket.seedPrompts ?? [])) return true;
  if (
    activeMarket === 'GLOBAL' &&
    !stringArraysEqual(input.supportedLocales, input.initialSupportedLocales)
  ) {
    return true;
  }
  if (!stringArraysEqual(input.controlPrompts, activeBrandMarket.controlPrompts ?? [])) return true;
  return false;
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

export function BrandIdentitySection({
  brand,
  activeMarket,
  activeBrandMarket,
  readOnly,
  onBrandUpdated,
  onOpenEnableMarket,
  onDirtyChange,
}: BrandIdentitySectionProps) {
  const feedback = useUxFeedback();

  const initialCompetitors = useMemo(
    () => hydrateCompetitorRows(activeBrandMarket?.competitors ?? []),
    [activeBrandMarket],
  );
  const initialSupportedLocales = useMemo(
    () => resolveInitialLocales(activeMarket, activeBrandMarket),
    [activeMarket, activeBrandMarket],
  );

  // Brand root fields
  const [brandName, setBrandName] = useState(brand.name);
  const [brandCategory, setBrandCategory] = useState(brand.category);
  const [savingBrand, setSavingBrand] = useState(false);
  const [brandError, setBrandError] = useState<string | null>(null);

  // Market-isolated fields
  const [localBrandName, setLocalBrandName] = useState(
    activeBrandMarket?.localBrandName ?? brand.name,
  );
  const [localCategory, setLocalCategory] = useState(activeBrandMarket?.localCategory ?? '');
  const [aliases, setAliases] = useState<string[]>(activeBrandMarket?.aliases ?? []);
  const [aliasInput, setAliasInput] = useState('');
  const [ownedDomains, setOwnedDomains] = useState<string[]>(activeBrandMarket?.ownedDomains ?? []);
  const [domainInput, setDomainInput] = useState('');
  const [competitorRows, setCompetitorRows] = useState<CompetitorDraftRow[]>(initialCompetitors);
  const [seedPrompts, setSeedPrompts] = useState<string[]>(activeBrandMarket?.seedPrompts ?? []);
  const [promptInput, setPromptInput] = useState('');
  const [supportedLocales, setSupportedLocales] = useState<SupportedLocale[]>(
    () => initialSupportedLocales,
  );
  const [controlPrompts, setControlPrompts] = useState<string[]>(
    activeBrandMarket?.controlPrompts ?? [],
  );
  const [controlPromptInput, setControlPromptInput] = useState('');
  const [savingMarket, setSavingMarket] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const marketSeqRef = useRef(0);
  const marketSaveCtrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setBrandName(brand.name);
    setBrandCategory(brand.category);
    setBrandError(null);
  }, [brand.id, brand.name, brand.category]);

  useEffect(() => {
    marketSeqRef.current += 1;
    marketSaveCtrlRef.current?.abort();
    marketSaveCtrlRef.current = null;
    setSavingMarket(false);
    setMarketError(null);
    return () => {
      marketSeqRef.current += 1;
      marketSaveCtrlRef.current?.abort();
      marketSaveCtrlRef.current = null;
    };
  }, [brand.id, activeMarket]);

  const activeBrandMarketSignature = useMemo(() => {
    if (!activeBrandMarket) return '';
    return JSON.stringify([
      activeBrandMarket.id,
      activeBrandMarket.updatedAt,
      activeBrandMarket.localBrandName,
      activeBrandMarket.localCategory ?? '',
      activeBrandMarket.aliases ?? [],
      activeBrandMarket.ownedDomains ?? [],
      activeBrandMarket.competitors ?? [],
      activeBrandMarket.seedPrompts ?? [],
      activeBrandMarket.supportedLocales ?? [],
      activeBrandMarket.controlPrompts ?? [],
    ]);
  }, [activeBrandMarket]);

  useEffect(() => {
    setLocalBrandName(activeBrandMarket?.localBrandName ?? brand.name);
    setLocalCategory(activeBrandMarket?.localCategory ?? '');
    setAliases(activeBrandMarket?.aliases ?? []);
    setAliasInput('');
    setOwnedDomains(activeBrandMarket?.ownedDomains ?? []);
    setDomainInput('');
    setCompetitorRows(initialCompetitors);
    setSeedPrompts(activeBrandMarket?.seedPrompts ?? []);
    setPromptInput('');
    setSupportedLocales(initialSupportedLocales);
    setControlPrompts(activeBrandMarket?.controlPrompts ?? []);
    setControlPromptInput('');
    setMarketError(null);
    // Intentionally keyed on value-based activeBrandMarketSignature so base-only updates
    // (brand.name / brand.category) never discard unsaved market edits or partial-failure errors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand.id, activeMarket, activeBrandMarketSignature]);

  const isBaseDirty = brandName !== brand.name || brandCategory !== brand.category;
  const isMarketDirty = useMemo(
    () =>
      computeMarketDirty({
        activeMarket,
        brand,
        activeBrandMarket,
        initialCompetitors,
        initialSupportedLocales,
        localBrandName,
        localCategory,
        aliases,
        ownedDomains,
        competitorRows,
        seedPrompts,
        supportedLocales,
        controlPrompts,
      }),
    [
      activeMarket,
      brand,
      activeBrandMarket,
      initialCompetitors,
      initialSupportedLocales,
      localBrandName,
      localCategory,
      aliases,
      ownedDomains,
      competitorRows,
      seedPrompts,
      supportedLocales,
      controlPrompts,
    ],
  );
  const isDirty = isBaseDirty || isMarketDirty;
  const saving = savingBrand || savingMarket;

  useEffect(() => {
    onDirtyChange?.(isDirty && !readOnly);
  }, [isDirty, readOnly, onDirtyChange]);

  useEffect(() => {
    return () => {
      onDirtyChange?.(false);
    };
  }, [onDirtyChange]);

  const hasCN = brand.markets.some((m) => m.market === 'CN');
  const hasGlobal = brand.markets.some((m) => m.market === 'GLOBAL');

  const handleAddAlias = () => {
    const trimmed = aliasInput.trim();
    if (!trimmed || aliases.length >= 20) return;
    if (!aliases.some((item) => item.toLowerCase() === trimmed.toLowerCase())) {
      setAliases((prev) => [...prev, trimmed.slice(0, BRAND_NAME_MAX)]);
    }
    setAliasInput('');
  };

  const handleAddDomain = () => {
    const trimmed = domainInput.trim();
    if (!trimmed || ownedDomains.length >= 20) return;
    const normalized = normalizeBrandDomain(trimmed);
    if (!normalized) {
      setMarketError(`无效的域名格式：${trimmed}`);
      return;
    }
    setMarketError(null);
    if (!ownedDomains.includes(normalized)) {
      setOwnedDomains((prev) => [...prev, normalized]);
    }
    setDomainInput('');
  };

  const handleAddSeedPrompt = () => {
    const trimmed = promptInput.trim();
    if (trimmed.length < 2 || seedPrompts.length >= 50) return;
    if (!seedPrompts.some((item) => item.toLowerCase() === trimmed.toLowerCase())) {
      setSeedPrompts((prev) => [...prev, trimmed.slice(0, 300)]);
    }
    setPromptInput('');
  };

  const handleAddControlPrompt = () => {
    const trimmed = controlPromptInput.trim();
    if (trimmed.length < 2) {
      setMarketError('对照组问句至少 2 个字');
      return;
    }
    if (controlPrompts.length >= BRAND_MAX_CONTROL_PROMPTS) {
      setMarketError(`最多配置 ${BRAND_MAX_CONTROL_PROMPTS} 条对照组问句`);
      return;
    }
    const normalizedNew = trimmed.replace(/\s+/g, ' ').toLowerCase();
    if (
      controlPrompts.some(
        (item) => item.trim().replace(/\s+/g, ' ').toLowerCase() === normalizedNew,
      )
    ) {
      setControlPromptInput('');
      setMarketError(null);
      return;
    }
    const overlapCheck = validateControlPromptsAgainstSeeds([trimmed], seedPrompts);
    if (!overlapCheck.ok) {
      setMarketError(`对照组问句不能与种子监控问句重复：${overlapCheck.duplicates[0]}`);
      return;
    }
    setMarketError(null);
    setControlPrompts((prev) => [...prev, trimmed.slice(0, 300)]);
    setControlPromptInput('');
  };

  const handleDiscard = () => {
    if (saving) return;
    setBrandName(brand.name);
    setBrandCategory(brand.category);
    setBrandError(null);

    setLocalBrandName(activeBrandMarket?.localBrandName ?? brand.name);
    setLocalCategory(activeBrandMarket?.localCategory ?? '');
    setAliases(activeBrandMarket?.aliases ?? []);
    setAliasInput('');
    setOwnedDomains(activeBrandMarket?.ownedDomains ?? []);
    setDomainInput('');
    setCompetitorRows(initialCompetitors);
    setSeedPrompts(activeBrandMarket?.seedPrompts ?? []);
    setPromptInput('');
    setSupportedLocales(initialSupportedLocales);
    setControlPrompts(activeBrandMarket?.controlPrompts ?? []);
    setControlPromptInput('');
    setMarketError(null);
  };

  const handleSaveAll = async () => {
    if (readOnly || saving || !isDirty) return;
    setBrandError(null);
    setMarketError(null);

    const saveBase = isBaseDirty;
    const saveMarket = isMarketDirty && Boolean(activeBrandMarket);

    const trimmedName = brandName.trim();
    const trimmedCategory = brandCategory.trim();
    let hasValidationError = false;

    if (saveBase) {
      if (!trimmedName) {
        setBrandError('请填写品牌名称');
        hasValidationError = true;
      } else if (!trimmedCategory) {
        setBrandError('请填写所属品类');
        hasValidationError = true;
      }
    }

    const trimmedLocal = localBrandName.trim();
    let serializedCompetitors: ReturnType<typeof serializeCompetitorRows>['competitors'] = [];
    if (saveMarket) {
      if (!trimmedLocal) {
        setMarketError('请填写当地品牌名称');
        hasValidationError = true;
      } else if (activeMarket === 'GLOBAL' && supportedLocales.length === 0) {
        setMarketError('请至少保留 1 个支持语种');
        hasValidationError = true;
      } else if (controlPrompts.length > BRAND_MAX_CONTROL_PROMPTS) {
        setMarketError(`最多配置 ${BRAND_MAX_CONTROL_PROMPTS} 条对照组问句`);
        hasValidationError = true;
      } else {
        const overlapCheck = validateControlPromptsAgainstSeeds(controlPrompts, seedPrompts);
        if (!overlapCheck.ok) {
          setMarketError(`对照组问句不能与种子监控问句重复：${overlapCheck.duplicates[0]}`);
          hasValidationError = true;
        } else {
          const serialized = serializeCompetitorRows(competitorRows);
          if (serialized.invalidDomainRows.length > 0) {
            setMarketError(`请检查竞品域名格式：${serialized.invalidDomainRows.join('；')}`);
            hasValidationError = true;
          } else {
            serializedCompetitors = serialized.competitors;
          }
        }
      }
    }

    if (hasValidationError) return;

    const saveBrandId = brand.id;
    const targetMarket = activeMarket;
    const startMarketSeq = marketSeqRef.current;
    let baseSaved = false;
    let marketSaved = false;

    // Step A: Base brand fields (do NOT abort on unmount — preserves W-07 stale-save store update)
    if (saveBase) {
      setSavingBrand(true);
      try {
        const updatedBase = await updateBrand(
          saveBrandId,
          { name: trimmedName, category: trimmedCategory },
          { storage: window.sessionStorage },
        );
        // Brand-root fields are market-agnostic; never pass targetMarket so an in-flight base save cannot yank activeMarket.
        onBrandUpdated(updatedBase);
        if (mountedRef.current) {
          setBrandName(updatedBase.name);
          setBrandCategory(updatedBase.category);
        }
        baseSaved = true;
      } catch (reason: unknown) {
        if (mountedRef.current) {
          setBrandError(
            reason instanceof Error && reason.message ? reason.message : '保存品牌失败',
          );
        }
        return;
      } finally {
        if (mountedRef.current) {
          setSavingBrand(false);
        }
      }
    }

    // Step B: Market-isolated fields (aborted on brand/market switch — preserves BUG-5 race guard)
    if (saveMarket && mountedRef.current && marketSeqRef.current === startMarketSeq) {
      marketSaveCtrlRef.current?.abort();
      const ctrl = new AbortController();
      marketSaveCtrlRef.current = ctrl;
      const seq = ++marketSeqRef.current;

      setSavingMarket(true);
      try {
        const updatedMarket = await updateBrandMarket(
          saveBrandId,
          targetMarket,
          {
            localBrandName: trimmedLocal,
            localCategory: localCategory.trim() || null,
            aliases,
            ownedDomains,
            competitors: serializedCompetitors,
            seedPrompts,
            ...(targetMarket === 'GLOBAL' ? { supportedLocales } : {}),
            controlPrompts,
          },
          { storage: window.sessionStorage, signal: ctrl.signal },
        );
        if (ctrl.signal.aborted || seq !== marketSeqRef.current || !mountedRef.current) return;
        onBrandUpdated(updatedMarket, targetMarket);
        const savedBm = updatedMarket.markets.find((m) => m.market === targetMarket) ?? null;
        if (savedBm) {
          setLocalBrandName(savedBm.localBrandName ?? updatedMarket.name);
          setLocalCategory(savedBm.localCategory ?? '');
          setAliases(savedBm.aliases ?? []);
          setOwnedDomains(savedBm.ownedDomains ?? []);
          setCompetitorRows(hydrateCompetitorRows(savedBm.competitors ?? []));
          setSeedPrompts(savedBm.seedPrompts ?? []);
          setSupportedLocales(resolveInitialLocales(targetMarket, savedBm));
          setControlPrompts(savedBm.controlPrompts ?? []);
        }
        marketSaved = true;
      } catch (reason: unknown) {
        if (ctrl.signal.aborted || seq !== marketSeqRef.current || !mountedRef.current) return;
        setMarketError(
          reason instanceof Error && reason.message ? reason.message : '保存市场配置失败',
        );
        if (baseSaved) {
          invalidateFreshness('brands');
        }
        return;
      } finally {
        if (marketSaveCtrlRef.current === ctrl) {
          marketSaveCtrlRef.current = null;
        }
        if (!ctrl.signal.aborted && seq === marketSeqRef.current && mountedRef.current) {
          setSavingMarket(false);
        }
      }
    }

    if (baseSaved || marketSaved) {
      invalidateFreshness('brands');
      if (mountedRef.current) {
        if (baseSaved && marketSaved) {
          feedback.notifySuccess('已保存品牌与市场配置');
        } else if (baseSaved) {
          feedback.notifySuccess('已保存品牌基础信息');
        } else {
          feedback.notifySuccess(`已保存${GEO_MARKET_LABELS[targetMarket]}配置`);
        }
      }
    }
  };

  return (
    <Section
      id="brand-section-identity"
      variant="plain"
      aria-label="基础身份与竞品雷达"
      title="基础身份与竞品雷达"
      description="维护品牌主档与当前市场（CN / GLOBAL）独立的官网域名、竞品域名与监控种子问句。"
    >
      <div className="gm-brand-identity-stack">
        {/* Shared Brand Profile */}
        <div className="gm-brand-subcard">
          <div className="gm-brand-subcard-head">
            <h3>品牌主档案</h3>
            <StatusBadge tone="neutral" label="双市场共享" />
          </div>

          <div className="gm-brand-form-grid-2">
            <FormField label="品牌名称" htmlFor="gm-edit-brand-name">
              <Input
                id="gm-edit-brand-name"
                aria-label="编辑品牌名称"
                maxLength={BRAND_NAME_MAX}
                value={brandName}
                disabled={readOnly || saving}
                onChange={(event) => setBrandName(event.target.value)}
              />
            </FormField>

            <FormField label="所属品类" htmlFor="gm-edit-brand-category">
              <Input
                id="gm-edit-brand-category"
                aria-label="编辑所属品类"
                maxLength={BRAND_CATEGORY_MAX}
                value={brandCategory}
                disabled={readOnly || saving}
                onChange={(event) => setBrandCategory(event.target.value)}
              />
            </FormField>
          </div>

          <FormField label="已开启目标市场" className="gm-brand-mt-sm">
            <div className="gm-brand-market-pills">
              {hasCN ? (
                <Button
                  size="small"
                  type="default"
                  className={
                    activeMarket === 'CN'
                      ? 'gm-brand-market-pill is-active'
                      : 'gm-brand-market-pill'
                  }
                  onClick={() =>
                    useWorkspaceStore.getState().setActiveMarket('CN', window.localStorage)
                  }
                >
                  🇨🇳 国内 (CN)
                </Button>
              ) : (
                <Button
                  size="small"
                  type="dashed"
                  disabled={readOnly}
                  onClick={() => onOpenEnableMarket('CN')}
                >
                  + 开启国内市场
                </Button>
              )}

              {hasGlobal ? (
                <Button
                  size="small"
                  type="default"
                  className={
                    activeMarket === 'GLOBAL'
                      ? 'gm-brand-market-pill is-active'
                      : 'gm-brand-market-pill'
                  }
                  onClick={() =>
                    useWorkspaceStore.getState().setActiveMarket('GLOBAL', window.localStorage)
                  }
                >
                  🌐 海外 (GLOBAL)
                </Button>
              ) : (
                <Button
                  size="small"
                  type="dashed"
                  disabled={readOnly}
                  onClick={() => onOpenEnableMarket('GLOBAL')}
                >
                  + 开启海外市场
                </Button>
              )}
            </div>
          </FormField>

          {brandError ? (
            <Alert
              type="error"
              showIcon
              message={brandError}
              className="gm-brand-inline-alert gm-brand-mt-sm"
            />
          ) : null}
        </div>

        {/* Active Market Identity & Competitor Radar */}
        <div className="gm-brand-subcard">
          <div className="gm-brand-subcard-head">
            <h3>
              {activeMarket === 'CN' ? '🇨🇳 国内市场身份与竞品雷达' : '🌐 海外市场身份与竞品雷达'}
            </h3>
            {activeBrandMarket ? (
              <StatusBadge
                tone="neutral"
                label={`${activeBrandMarket.locale} / ${activeBrandMarket.region}`}
              />
            ) : null}
          </div>

          {activeBrandMarket ? (
            <div className="gm-brand-market-fields">
              {activeMarket === 'GLOBAL' &&
              (containsCjk(localBrandName) ||
                (!localCategory.trim() && containsCjk(brand.category)) ||
                ownedDomains.some((d) => d.endsWith('.cn'))) ? (
                <Alert
                  type="warning"
                  showIcon
                  data-testid="global-localization-guide"
                  className="gm-brand-inline-alert"
                  message="建议完善海外市场英文身份"
                  description="检测到海外市场仍包含中文品牌名、未设置英文品类或使用 .cn 域名，建议补全纯英文当地品牌名、当地品类与海外官网域名，以保障英文种子问句、JSON-LD 与 llms.txt 的专业输出。"
                />
              ) : null}

              <div className="gm-brand-form-grid-2">
                <FormField label="当地品牌名" htmlFor="gm-market-local-name">
                  <Input
                    id="gm-market-local-name"
                    aria-label="当地品牌名"
                    maxLength={BRAND_NAME_MAX}
                    value={localBrandName}
                    disabled={readOnly || saving}
                    placeholder={activeMarket === 'GLOBAL' ? '例如：ExampleBrand' : '例如：绿联'}
                    onChange={(event) => setLocalBrandName(event.target.value)}
                  />
                </FormField>

                <FormField
                  label="当地品类名称（用于该市场种子问句、Schema 与 llms.txt）"
                  htmlFor="gm-market-local-category"
                >
                  <Input
                    id="gm-market-local-category"
                    aria-label="当地品类名称"
                    maxLength={BRAND_CATEGORY_MAX}
                    value={localCategory}
                    disabled={readOnly || saving}
                    placeholder={
                      activeMarket === 'GLOBAL'
                        ? '例如：Home NAS / Portable Power Station（留空将自动回退英文品类）'
                        : `留空默认继承主档案品类（${brand.category}）`
                    }
                    onChange={(event) => setLocalCategory(event.target.value)}
                  />
                </FormField>
              </div>

              {activeMarket === 'GLOBAL' ? <div className="gm-brand-global-guard-slot" /> : null}

              <FormField label="当地品牌别名 / SKU 词（最多 20 个）">
                <div className="gm-brand-field-stack">
                  <div className="gm-brand-chip-input-row">
                    <Input
                      aria-label="添加市场别名"
                      value={aliasInput}
                      maxLength={BRAND_NAME_MAX}
                      disabled={readOnly || saving || aliases.length >= 20}
                      placeholder="输入别名或系列型号后回车"
                      onChange={(event) => setAliasInput(event.target.value)}
                      onPressEnter={(event) => {
                        event.preventDefault();
                        handleAddAlias();
                      }}
                    />
                    <Button
                      disabled={readOnly || saving || !aliasInput.trim() || aliases.length >= 20}
                      className="gm-brand-btn-nowrap"
                      onClick={handleAddAlias}
                    >
                      + 添加
                    </Button>
                  </div>
                  {aliases.length > 0 ? (
                    <div className="gm-brand-chip-list">
                      {aliases.map((item) => (
                        <Tag
                          key={item}
                          closable={!readOnly && !saving}
                          onClose={() => setAliases((prev) => prev.filter((x) => x !== item))}
                        >
                          {item}
                        </Tag>
                      ))}
                    </div>
                  ) : null}
                </div>
              </FormField>

              <FormField label="当地自有官网 / 文档域名（驱动自有信源归类）">
                <div className="gm-brand-field-stack">
                  <div className="gm-brand-chip-input-row">
                    <Input
                      aria-label="添加自有官网域名"
                      value={domainInput}
                      disabled={readOnly || saving || ownedDomains.length >= 20}
                      placeholder="输入域名如 example.com 后回车"
                      onChange={(event) => setDomainInput(event.target.value)}
                      onPressEnter={(event) => {
                        event.preventDefault();
                        handleAddDomain();
                      }}
                    />
                    <Button
                      disabled={
                        readOnly || saving || !domainInput.trim() || ownedDomains.length >= 20
                      }
                      className="gm-brand-btn-nowrap"
                      onClick={handleAddDomain}
                    >
                      + 添加
                    </Button>
                  </div>
                  {ownedDomains.length > 0 ? (
                    <div className="gm-brand-chip-list">
                      {ownedDomains.map((domain) => (
                        <Tag
                          key={domain}
                          className="gm-brand-domain-tag"
                          closable={!readOnly && !saving}
                          onClose={() =>
                            setOwnedDomains((prev) => prev.filter((x) => x !== domain))
                          }
                        >
                          {domain}
                        </Tag>
                      ))}
                    </div>
                  ) : null}
                </div>
              </FormField>

              <FormField
                label={`主要竞品与竞品域名（${competitorRows.length} / ${BRAND_MAX_COMPETITORS}）`}
              >
                <div className="gm-brand-competitor-list">
                  {competitorRows.map((row, idx) => {
                    const trimmedName = row.name.trim();
                    const parsedAliases = parseCompetitorAliases(row.aliasesText);
                    const parsedDomains = parseDomainTokens(row.domainsText);
                    const hasPreviewChips =
                      Boolean(trimmedName) || parsedAliases.length > 0 || parsedDomains.length > 0;
                    return (
                      <div key={row.key} className="gm-brand-competitor-item">
                        <div className="gm-brand-competitor-row">
                          <Input
                            aria-label={`市场竞品名称 ${idx + 1}`}
                            value={row.name}
                            maxLength={BRAND_NAME_MAX}
                            disabled={readOnly || saving}
                            placeholder="竞品名"
                            onChange={(event) =>
                              setCompetitorRows((prev) =>
                                prev.map((item) =>
                                  item.key === row.key
                                    ? { ...item, name: event.target.value }
                                    : item,
                                ),
                              )
                            }
                          />
                          <Input
                            aria-label={`市场竞品域名 ${idx + 1}`}
                            value={row.domainsText}
                            disabled={readOnly || saving}
                            placeholder="竞品域名（逗号分隔，选填）"
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
                          {!readOnly ? (
                            <button
                              type="button"
                              className="gm-brand-row-remove-btn"
                              aria-label={`移除竞品 ${trimmedName || idx + 1}`}
                              title="移除竞品"
                              disabled={saving}
                              onClick={() =>
                                setCompetitorRows((prev) =>
                                  prev.filter((item) => item.key !== row.key),
                                )
                              }
                            >
                              <RemoveRowIcon />
                            </button>
                          ) : null}
                        </div>
                        {hasPreviewChips ? (
                          <div className="gm-brand-chip-list gm-brand-competitor-chips">
                            {trimmedName ? <Tag>{trimmedName}</Tag> : null}
                            {parsedAliases.map((alias) => (
                              <Tag key={`alias-${alias}`}>{alias}</Tag>
                            ))}
                            {parsedDomains.map((domain) => (
                              <Tag
                                key={`domain-${domain}`}
                                className="gm-brand-competitor-domain-tag"
                              >
                                {domain}
                              </Tag>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  <Button
                    type="dashed"
                    size="small"
                    disabled={readOnly || saving || competitorRows.length >= BRAND_MAX_COMPETITORS}
                    onClick={() =>
                      setCompetitorRows((prev) =>
                        prev.length >= BRAND_MAX_COMPETITORS
                          ? prev
                          : [...prev, createBlankCompetitor()],
                      )
                    }
                  >
                    + 添加竞品
                  </Button>
                </div>
              </FormField>

              <FormField
                label={`高频监控问句种子（${seedPrompts.length} / 50）`}
                extra={
                  !readOnly ? (
                    <Button
                      size="small"
                      aria-label="按当前品类重新生成种子问句"
                      disabled={saving}
                      className="gm-brand-btn-nowrap"
                      onClick={() => {
                        const regenerated = generateBrandSeedPrompts({
                          market: activeMarket,
                          brandName: localBrandName.trim() || brand.name,
                          category: brand.category,
                          localCategory: localCategory.trim() || null,
                          competitors: competitorRows
                            .map((row) => ({ name: row.name.trim(), aliases: [], domains: [] }))
                            .filter((c) => c.name.length > 0),
                        });
                        setSeedPrompts(regenerated);
                      }}
                    >
                      按当前品类重新生成种子问句
                    </Button>
                  ) : null
                }
              >
                <div className="gm-brand-field-stack">
                  <div className="gm-brand-chip-input-row">
                    <Input
                      aria-label="添加监控问句种子"
                      value={promptInput}
                      maxLength={300}
                      disabled={readOnly || saving || seedPrompts.length >= 50}
                      placeholder={
                        activeMarket === 'CN'
                          ? '输入新的国内监控问题后回车'
                          : 'Add an English monitoring prompt and press Enter'
                      }
                      onChange={(event) => setPromptInput(event.target.value)}
                      onPressEnter={(event) => {
                        event.preventDefault();
                        handleAddSeedPrompt();
                      }}
                    />
                    <Button
                      disabled={
                        readOnly ||
                        saving ||
                        promptInput.trim().length < 2 ||
                        seedPrompts.length >= 50
                      }
                      className="gm-brand-btn-nowrap"
                      onClick={handleAddSeedPrompt}
                    >
                      + 添加
                    </Button>
                  </div>
                  {seedPrompts.length > 0 ? (
                    <div className="gm-brand-seed-list">
                      {seedPrompts.map((prompt) => (
                        <div key={prompt} className="gm-brand-seed-item">
                          <span className="gm-brand-seed-text">{prompt}</span>
                          {!readOnly ? (
                            <button
                              type="button"
                              className="gm-brand-row-remove-btn"
                              aria-label={`移除问句 ${prompt}`}
                              title="移除问句"
                              disabled={saving}
                              onClick={() =>
                                setSeedPrompts((prev) => prev.filter((item) => item !== prompt))
                              }
                            >
                              <RemoveRowIcon />
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </FormField>

              {activeMarket === 'GLOBAL' ? (
                <FormField
                  data-testid="brand-supported-locales-field"
                  label="海外支持写作语种（至少 1 个；开启多语种后写作台自动出现语种切换）"
                  help="支持英语（美/英）、德语、日语、西语、法语；日语内容自动采用防误判双信号校验。"
                >
                  <Select<SupportedLocale[]>
                    mode="multiple"
                    aria-label="海外支持写作语种"
                    data-testid="brand-supported-locales-select"
                    className="gm-brand-w-full"
                    disabled={readOnly || saving}
                    placeholder="选择海外市场支持的写作与分发语种"
                    value={supportedLocales}
                    options={GLOBAL_SUPPORTED_LOCALES.map((code) => {
                      const meta = SUPPORTED_LOCALES[code];
                      return {
                        value: code,
                        label: `${meta.labelZh} (${meta.code}) · ${meta.nativeLabel}`,
                      };
                    })}
                    onChange={(next) => {
                      setSupportedLocales(next);
                      if (next.length > 0 && marketError === '请至少保留 1 个支持语种') {
                        setMarketError(null);
                      }
                    }}
                  />
                </FormField>
              ) : null}

              <FormField
                data-testid="brand-control-prompts-field"
                label={`对照组问句（DiD 归因基线，${controlPrompts.length} / ${BRAND_MAX_CONTROL_PROMPTS}）`}
                help={`开启对照组自动复测时默认取前 ${BRAND_DEFAULT_RETEST_CONTROL_PROMPTS} 条问句作为未发稿基线（最多 ${BRAND_MAX_CONTROL_PROMPTS} 条），且不可与上方种子监控问句重复。`}
              >
                <div className="gm-brand-field-stack">
                  <div className="gm-brand-chip-input-row">
                    <Input
                      aria-label="添加对照组问句"
                      data-testid="control-prompt-input"
                      value={controlPromptInput}
                      maxLength={300}
                      disabled={
                        readOnly || saving || controlPrompts.length >= BRAND_MAX_CONTROL_PROMPTS
                      }
                      placeholder={
                        activeMarket === 'CN'
                          ? '输入未发稿对照组问句后回车（用于 DiD 净增益归因）'
                          : 'Add a control prompt not targeted by published articles'
                      }
                      onChange={(event) => {
                        setControlPromptInput(event.target.value);
                        if (marketError) setMarketError(null);
                      }}
                      onPressEnter={(event) => {
                        event.preventDefault();
                        handleAddControlPrompt();
                      }}
                    />
                    <Button
                      data-testid="add-control-prompt-btn"
                      disabled={
                        readOnly ||
                        saving ||
                        controlPromptInput.trim().length < 2 ||
                        controlPrompts.length >= BRAND_MAX_CONTROL_PROMPTS
                      }
                      className="gm-brand-btn-nowrap"
                      onClick={handleAddControlPrompt}
                    >
                      + 添加
                    </Button>
                  </div>
                  {controlPrompts.length > 0 ? (
                    <div className="gm-brand-seed-list" data-testid="control-prompts-list">
                      {controlPrompts.map((prompt, index) => (
                        <div key={prompt} className="gm-brand-seed-item">
                          <span className="gm-brand-seed-text">
                            <span>{prompt}</span>
                            {index < BRAND_DEFAULT_RETEST_CONTROL_PROMPTS ? (
                              <StatusBadge
                                tone="active"
                                size="sm"
                                label="默认 DiD 对照"
                                className="gm-brand-did-badge"
                              />
                            ) : null}
                          </span>
                          {!readOnly ? (
                            <button
                              type="button"
                              className="gm-brand-row-remove-btn"
                              aria-label={`移除对照组问句 ${prompt}`}
                              title="移除对照组问句"
                              disabled={saving}
                              onClick={() =>
                                setControlPrompts((prev) => prev.filter((item) => item !== prompt))
                              }
                            >
                              <RemoveRowIcon />
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </FormField>

              {marketError ? (
                <Alert
                  type="error"
                  showIcon
                  data-testid="brand-market-error"
                  message={marketError}
                  className="gm-brand-inline-alert"
                />
              ) : null}
            </div>
          ) : (
            <Alert
              type="info"
              showIcon
              message="当前市场尚未开启"
              action={
                <Button
                  size="small"
                  type="default"
                  disabled={readOnly}
                  className="gm-brand-btn-nowrap"
                  onClick={() => onOpenEnableMarket(activeMarket)}
                >
                  立即开启
                </Button>
              }
            />
          )}
        </div>
      </div>

      {isDirty && !readOnly ? (
        <div
          className="gm-brand-dirty-bar"
          role="region"
          aria-label="未保存更改操作栏"
          data-testid="brand-dirty-save-bar"
        >
          <StatusBadge tone="warning" size="sm" label="有未保存更改" />
          <div className="gm-brand-dirty-bar-actions">
            <Button
              autoInsertSpace={false}
              disabled={saving}
              className="gm-brand-btn-nowrap"
              onClick={handleDiscard}
            >
              放弃
            </Button>
            <Button
              type="primary"
              loading={saving}
              disabled={readOnly}
              className="gm-brand-btn-nowrap"
              onClick={() => void handleSaveAll()}
            >
              保存修改
            </Button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
