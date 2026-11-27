'use client';

import {
  BRAND_CATEGORY_MAX,
  BRAND_DEFAULT_RETEST_CONTROL_PROMPTS,
  BRAND_MAX_COMPETITORS,
  BRAND_MAX_CONTROL_PROMPTS,
  BRAND_NAME_MAX,
  GEO_MARKET_LABELS,
  GLOBAL_CJK_IDENTITY_OVERRIDE_LABEL,
  GLOBAL_SUPPORTED_LOCALES,
  SUPPORTED_LOCALES,
  containsCjk,
  normalizeBrandDomain,
  validateControlPromptsAgainstSeeds,
  validateGlobalMarketIdentity,
  type BrandCompetitor,
  type BrandMarketAiSuggestField,
  type BrandMarketAiSuggestResponse,
  type BrandMarketRecord,
  type BrandRecord,
  type GeoMarket,
  type RetestBudgetSummaryDto,
  type SupportedLocale,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Input, InputNumber, Select, Tag } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { suggestBrandMarketConfig, updateBrand, updateBrandMarket } from '../../lib/brands';
import { invalidateFreshness } from '../../lib/tab-freshness';
import { useUxFeedback } from '../crud/ux-feedback';
import { CostChip, EmptyState, Explain, FormField, Section, StatusBadge } from '../ui';
import {
  buildFallbackSeedPromptSuggestionResponse,
  hydrateCompetitorRows,
  mergeAiMarketSuggestions,
  parseCompetitorAliases,
  parseDomainTokens,
  serializeCompetitorRows,
  type BrandMarketAiSuggestSelection,
  type CompetitorDraftRow,
} from './brand-form-helpers';
import {
  BrandMarketAiSuggestModal,
  type BrandMarketAiSuggestMode,
} from './brand-market-ai-suggest-modal';

export type BrandIdentitySectionProps = {
  brand: BrandRecord;
  activeMarket: GeoMarket;
  activeBrandMarket: BrandMarketRecord | null;
  retestBudget?: RetestBudgetSummaryDto | null;
  readOnly: boolean;
  onBrandUpdated: (brand: BrandRecord, market?: GeoMarket) => void;
  onOpenEnableMarket?: (market: GeoMarket) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

let identityCompSeq = 1;
function createBlankCompetitor(): CompetitorDraftRow {
  identityCompSeq += 1;
  return { key: `id-comp-${identityCompSeq}`, name: '', domainsText: '', aliasesText: '' };
}

function createCompetitorRowFromSuggestion(comp: BrandCompetitor): CompetitorDraftRow {
  identityCompSeq += 1;
  return {
    key: `id-comp-ai-${identityCompSeq}`,
    name: comp.name,
    domainsText: comp.domains.join(', '),
    aliasesText: comp.aliases.join(', '),
  };
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
  monthlyRetestPointCap: number | null;
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
  if ((input.monthlyRetestPointCap ?? null) !== (activeBrandMarket.monthlyRetestPointCap ?? null)) {
    return true;
  }
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
  retestBudget = null,
  readOnly,
  onBrandUpdated,
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
  const [monthlyRetestPointCap, setMonthlyRetestPointCap] = useState<number | null>(
    activeBrandMarket?.monthlyRetestPointCap ?? null,
  );
  const [allowCjkGlobalIdentity, setAllowCjkGlobalIdentity] = useState(false);
  const [savingMarket, setSavingMarket] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);

  // Advanced control prompts & monthly budget cap panel (Y8)
  const [controlPanelOpen, setControlPanelOpen] = useState(false);

  // AI market prefill modal state
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiModalMode, setAiModalMode] = useState<BrandMarketAiSuggestMode>('full');
  const [aiSuggestLoading, setAiSuggestLoading] = useState(false);
  const [aiSuggestError, setAiSuggestError] = useState<string | null>(null);
  const [aiSuggestion, setAiSuggestion] = useState<BrandMarketAiSuggestResponse | null>(null);
  const [aiSourceUrl, setAiSourceUrl] = useState('');

  const mountedRef = useRef(true);
  const marketSeqRef = useRef(0);
  const marketSaveCtrlRef = useRef<AbortController | null>(null);
  const aiSuggestSeqRef = useRef(0);
  const aiSuggestCtrlRef = useRef<AbortController | null>(null);

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
    aiSuggestSeqRef.current += 1;
    aiSuggestCtrlRef.current?.abort();
    aiSuggestCtrlRef.current = null;
    setSavingMarket(false);
    setMarketError(null);
    setAiModalOpen(false);
    setAiSuggestLoading(false);
    setAiSuggestError(null);
    setAiSuggestion(null);
    setAiSourceUrl('');
    return () => {
      marketSeqRef.current += 1;
      marketSaveCtrlRef.current?.abort();
      marketSaveCtrlRef.current = null;
      aiSuggestSeqRef.current += 1;
      aiSuggestCtrlRef.current?.abort();
      aiSuggestCtrlRef.current = null;
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
      activeBrandMarket.monthlyRetestPointCap ?? null,
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
    setMonthlyRetestPointCap(activeBrandMarket?.monthlyRetestPointCap ?? null);
    setAllowCjkGlobalIdentity(false);
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
        monthlyRetestPointCap,
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
      monthlyRetestPointCap,
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

  const trimmedLocalBrandName = localBrandName.trim();
  const trimmedLocalCategory = localCategory.trim() || null;
  const savedLocalBrandName = (activeBrandMarket?.localBrandName ?? brand.name).trim();
  const savedLocalCategory = activeBrandMarket?.localCategory?.trim() || null;
  const localNameChanged = trimmedLocalBrandName !== savedLocalBrandName;
  const localCategoryChanged = trimmedLocalCategory !== savedLocalCategory;
  const needsGlobalCjkOverride =
    activeMarket === 'GLOBAL' &&
    ((localNameChanged && containsCjk(trimmedLocalBrandName)) ||
      (localCategoryChanged && trimmedLocalCategory !== null && containsCjk(trimmedLocalCategory)));

  useEffect(() => {
    if (!needsGlobalCjkOverride) {
      setAllowCjkGlobalIdentity(false);
    }
  }, [needsGlobalCjkOverride]);

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
    setMonthlyRetestPointCap(activeBrandMarket?.monthlyRetestPointCap ?? null);
    setAllowCjkGlobalIdentity(false);
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

    const trimmedLocal = trimmedLocalBrandName;
    let serializedCompetitors: ReturnType<typeof serializeCompetitorRows>['competitors'] = [];
    if (saveMarket) {
      const globalIdentityCheck =
        localNameChanged || localCategoryChanged
          ? validateGlobalMarketIdentity({
              market: activeMarket,
              ...(localNameChanged ? { localBrandName: trimmedLocal } : {}),
              ...(localCategoryChanged ? { localCategory: trimmedLocalCategory } : {}),
              allowCjkGlobalIdentity,
            })
          : { ok: true as const };
      if (!trimmedLocal) {
        setMarketError('请填写当地品牌名称');
        hasValidationError = true;
      } else if (!globalIdentityCheck.ok) {
        setMarketError(globalIdentityCheck.message);
        hasValidationError = true;
      } else if (activeMarket === 'GLOBAL' && supportedLocales.length === 0) {
        setMarketError('请至少保留 1 个支持语种');
        hasValidationError = true;
      } else if (controlPrompts.length > BRAND_MAX_CONTROL_PROMPTS) {
        setMarketError(`最多配置 ${BRAND_MAX_CONTROL_PROMPTS} 条对照组问句`);
        hasValidationError = true;
      } else if (
        monthlyRetestPointCap !== null &&
        (!Number.isInteger(monthlyRetestPointCap) ||
          monthlyRetestPointCap < 1 ||
          monthlyRetestPointCap > 1_000_000)
      ) {
        setMarketError('本月自动复测点数上限需为 1–1,000,000 的整数，或留空表示不限');
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
        const includeLocalBrandName =
          localNameChanged || !(targetMarket === 'GLOBAL' && containsCjk(trimmedLocal));
        const includeLocalCategory =
          localCategoryChanged ||
          !(
            targetMarket === 'GLOBAL' &&
            trimmedLocalCategory !== null &&
            containsCjk(trimmedLocalCategory)
          );
        const updatedMarket = await updateBrandMarket(
          saveBrandId,
          targetMarket,
          {
            ...(includeLocalBrandName ? { localBrandName: trimmedLocal } : {}),
            ...(includeLocalCategory ? { localCategory: trimmedLocalCategory } : {}),
            aliases,
            ownedDomains,
            competitors: serializedCompetitors,
            seedPrompts,
            ...(targetMarket === 'GLOBAL' ? { supportedLocales } : {}),
            ...(targetMarket === 'GLOBAL' && allowCjkGlobalIdentity
              ? { allowCjkGlobalIdentity: true }
              : {}),
            controlPrompts,
            monthlyRetestPointCap,
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
          setMonthlyRetestPointCap(savedBm.monthlyRetestPointCap ?? null);
        }
        setAllowCjkGlobalIdentity(false);
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

  const openAiSuggest = async (
    mode: BrandMarketAiSuggestMode,
    customSourceUrl?: string,
    customFields?: BrandMarketAiSuggestField[],
  ) => {
    if (readOnly || saving || !activeBrandMarket) return;

    aiSuggestCtrlRef.current?.abort();
    const ctrl = new AbortController();
    aiSuggestCtrlRef.current = ctrl;
    const seq = ++aiSuggestSeqRef.current;

    const urlToSend = (customSourceUrl ?? (mode === 'full' ? aiSourceUrl : '')).trim();
    const fields: BrandMarketAiSuggestField[] | undefined =
      customFields && customFields.length > 0
        ? customFields
        : mode === 'seedPrompts'
          ? ['seedPrompts']
          : mode === 'localIdentity'
            ? ['localIdentity']
            : undefined;

    setAiModalMode(mode);
    setAiModalOpen(true);
    setAiSuggestLoading(true);
    setAiSuggestError(null);
    setAiSuggestion(null);

    try {
      const response = await suggestBrandMarketConfig(
        brand.id,
        activeMarket,
        {
          ...(fields ? { fields } : {}),
          ...(urlToSend ? { sourceUrl: urlToSend } : {}),
        },
        { storage: window.sessionStorage, signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || seq !== aiSuggestSeqRef.current || !mountedRef.current) return;
      setAiSuggestion(response);
      setAiSuggestError(null);
    } catch {
      if (ctrl.signal.aborted || seq !== aiSuggestSeqRef.current || !mountedRef.current) return;
      const fallback = buildFallbackSeedPromptSuggestionResponse({
        market: activeMarket,
        brandName: localBrandName.trim() || brand.name,
        category: brand.category,
        localCategory: localCategory.trim() || null,
        competitors: serializeCompetitorRows(competitorRows).competitors,
        existingSeedPrompts: seedPrompts,
      });
      setAiSuggestion(fallback);
      setAiSuggestError(null);
    } finally {
      if (aiSuggestCtrlRef.current === ctrl) {
        aiSuggestCtrlRef.current = null;
      }
      if (!ctrl.signal.aborted && seq === aiSuggestSeqRef.current && mountedRef.current) {
        setAiSuggestLoading(false);
      }
    }
  };

  const handleCloseAiModal = () => {
    aiSuggestSeqRef.current += 1;
    aiSuggestCtrlRef.current?.abort();
    aiSuggestCtrlRef.current = null;
    setAiSuggestLoading(false);
    setAiModalOpen(false);
  };

  const handleApplyAiSelection = (selection: BrandMarketAiSuggestSelection) => {
    const cleanGlobalCjkOnLocalize =
      activeMarket === 'GLOBAL' &&
      !allowCjkGlobalIdentity &&
      (aiModalMode === 'localIdentity' ||
        Boolean(
          selection.localBrandName ||
          selection.localCategory ||
          selection.aliases.length > 0 ||
          selection.competitors.length > 0 ||
          selection.seedPrompts.length > 0,
        ));
    const baseAliases = cleanGlobalCjkOnLocalize
      ? aliases.filter((item) => !containsCjk(item))
      : aliases;
    const baseCompetitorRows = cleanGlobalCjkOnLocalize
      ? competitorRows
          .filter((row) => !containsCjk(row.name))
          .map((row) => ({
            ...row,
            aliasesText: parseCompetitorAliases(row.aliasesText)
              .filter((alias) => !containsCjk(alias))
              .join(', '),
          }))
      : competitorRows;
    const baseSeedPrompts = cleanGlobalCjkOnLocalize
      ? seedPrompts.filter((item) => !containsCjk(item))
      : seedPrompts;
    const baseControlPrompts = cleanGlobalCjkOnLocalize
      ? controlPrompts.filter((item) => !containsCjk(item))
      : controlPrompts;

    const existingNonBlankRows = baseCompetitorRows.filter((row) => row.name.trim().length > 0);
    const existingSerialized = serializeCompetitorRows(existingNonBlankRows).competitors;

    const merged = mergeAiMarketSuggestions({
      market: activeMarket,
      current: {
        localBrandName,
        localCategory,
        aliases: baseAliases,
        competitors: existingSerialized,
        seedPrompts: baseSeedPrompts,
        controlPrompts: baseControlPrompts,
      },
      selection,
    });

    if (merged.addedCounts.localBrandName) {
      setLocalBrandName(merged.localBrandName);
    }
    if (merged.addedCounts.localCategory) {
      setLocalCategory(merged.localCategory);
    }
    if (merged.addedCounts.aliases > 0 || baseAliases.length !== aliases.length) {
      setAliases(merged.aliases);
    }
    if (
      merged.addedCounts.competitors > 0 ||
      baseCompetitorRows.length !== competitorRows.length ||
      cleanGlobalCjkOnLocalize
    ) {
      const newlyAdded = merged.competitors.slice(existingSerialized.length);
      setCompetitorRows(
        [...existingNonBlankRows, ...newlyAdded.map(createCompetitorRowFromSuggestion)].slice(
          0,
          BRAND_MAX_COMPETITORS,
        ),
      );
    }
    if (merged.addedCounts.seedPrompts > 0 || baseSeedPrompts.length !== seedPrompts.length) {
      setSeedPrompts(merged.seedPrompts);
    }
    if (
      merged.addedCounts.controlPrompts > 0 ||
      baseControlPrompts.length !== controlPrompts.length
    ) {
      setControlPrompts(merged.controlPrompts);
    }

    setMarketError(null);
    handleCloseAiModal();

    const totalAdded =
      (merged.addedCounts.localBrandName ? 1 : 0) +
      (merged.addedCounts.localCategory ? 1 : 0) +
      merged.addedCounts.aliases +
      merged.addedCounts.competitors +
      merged.addedCounts.seedPrompts +
      merged.addedCounts.controlPrompts;

    const truncatedParts: string[] = [];
    if (merged.truncatedCounts.aliases > 0) {
      truncatedParts.push(`别名截断 ${merged.truncatedCounts.aliases} 项`);
    }
    if (merged.truncatedCounts.competitors > 0) {
      truncatedParts.push(`竞品截断 ${merged.truncatedCounts.competitors} 项`);
    }
    if (merged.truncatedCounts.seedPrompts > 0) {
      truncatedParts.push(`种子问句截断 ${merged.truncatedCounts.seedPrompts} 条`);
    }
    if (merged.truncatedCounts.controlPrompts > 0) {
      truncatedParts.push(`对照组截断 ${merged.truncatedCounts.controlPrompts} 条`);
    }
    if (merged.skippedControlOverlaps > 0) {
      truncatedParts.push(`已自动跳过 ${merged.skippedControlOverlaps} 条与种子重复的对照问句`);
    }

    if (truncatedParts.length > 0) {
      feedback.notifyWarning(
        `已追加 ${totalAdded} 项建议至表单（${truncatedParts.join('，')}），请核对后点击底部「保存修改」落库`,
      );
    } else if (totalAdded > 0) {
      feedback.notifySuccess(
        `已追加 ${totalAdded} 项 AI 建议至表单，请核对后点击底部「保存修改」落库`,
      );
    } else {
      feedback.notifyWarning('所选建议均已在当前表单中存在，未产生重复追加');
    }
  };

  return (
    <Section
      id="brand-section-identity"
      variant="plain"
      aria-label="基础身份与竞品雷达"
      title="品牌身份"
      description="维护品牌主档与当前市场（CN / GLOBAL）独立的官网域名、竞品域名与监控种子问句。"
    >
      <div className="gm-brand-identity-stack">
        {/* Shared Brand Profile */}
        <div className="gm-brand-subcard">
          <div className="gm-brand-subcard-head">
            <h3>基本信息</h3>
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
            <h3>{activeMarket === 'CN' ? '国内身份' : '海外身份'}</h3>
            {activeBrandMarket ? (
              <div className="gm-brand-subcard-head-actions">
                <StatusBadge
                  tone="neutral"
                  label={`${activeBrandMarket.locale} / ${activeBrandMarket.region}`}
                />
                {!readOnly ? (
                  <>
                    <CostChip points={0} />
                    <Button
                      type="default"
                      size="small"
                      data-testid="brand-ai-prefill-btn"
                      aria-label="AI 补全"
                      disabled={saving}
                      className="gm-brand-btn-nowrap"
                      onClick={() => void openAiSuggest('full')}
                    >
                      AI 补全
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>

          {activeBrandMarket ? (
            <div className="gm-brand-market-fields">
              {(() => {
                if (activeMarket !== 'GLOBAL') return null;
                const hasIdentityCjkOrCn =
                  containsCjk(localBrandName) ||
                  containsCjk(localCategory) ||
                  (!localCategory.trim() && containsCjk(brand.category)) ||
                  ownedDomains.some((d) => d.endsWith('.cn'));
                const hasAliasCjk = aliases.some((item) => containsCjk(item));
                const hasCompetitorCjk = competitorRows.some(
                  (row) =>
                    containsCjk(row.name) ||
                    parseCompetitorAliases(row.aliasesText).some((alias) => containsCjk(alias)),
                );
                const hasSeedCjk = seedPrompts.some((item) => containsCjk(item));
                const hasControlCjk = controlPrompts.some((item) => containsCjk(item));
                const hasExtraCjk = hasAliasCjk || hasCompetitorCjk || hasSeedCjk || hasControlCjk;
                if (!hasIdentityCjkOrCn && !hasExtraCjk) return null;

                const issueParts: string[] = [];
                if (hasIdentityCjkOrCn) issueParts.push('品牌名/品类或 .cn 域名');
                if (hasAliasCjk) issueParts.push('品牌别名');
                if (hasCompetitorCjk) issueParts.push('竞品名称/别名');
                if (hasSeedCjk) issueParts.push('种子监控问句');
                if (hasControlCjk) issueParts.push('对照组问句');

                return (
                  <Alert
                    type="warning"
                    showIcon
                    data-testid="global-localization-guide"
                    className="gm-brand-inline-alert"
                    message={
                      <span className="gm-brand-alert-title-row">
                        <span>英文待补</span>
                        <Explain
                          text={`检测到海外市场（GLOBAL）的${issueParts.join('、')}包含中文或国内域名，建议点击右上「AI 补全」清理并替换为纯英文配置，以保障英文种子问句、JSON-LD 与 llms.txt 的专业输出。`}
                        />
                      </span>
                    }
                  />
                );
              })()}

              <div className="gm-brand-form-grid-2">
                <FormField label="本地名" htmlFor="gm-market-local-name">
                  <Input
                    id="gm-market-local-name"
                    aria-label="当地品牌名"
                    maxLength={BRAND_NAME_MAX}
                    value={localBrandName}
                    disabled={readOnly || saving}
                    placeholder={activeMarket === 'GLOBAL' ? '例如：ExampleBrand' : '例如：绿联'}
                    onChange={(event) => {
                      const nextVal = event.target.value;
                      setLocalBrandName(nextVal);
                      if (!containsCjk(nextVal) && !containsCjk(localCategory)) {
                        setAllowCjkGlobalIdentity(false);
                      }
                      if (marketError) setMarketError(null);
                    }}
                  />
                </FormField>

                <FormField
                  label="本地品类"
                  help="用于该市场种子问句、Schema 与 llms.txt"
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
                    onChange={(event) => {
                      const nextVal = event.target.value;
                      setLocalCategory(nextVal);
                      if (!containsCjk(localBrandName) && !containsCjk(nextVal)) {
                        setAllowCjkGlobalIdentity(false);
                      }
                      if (marketError) setMarketError(null);
                    }}
                  />
                </FormField>
              </div>

              {activeMarket === 'GLOBAL' ? (
                <div className="gm-brand-global-guard-slot">
                  {needsGlobalCjkOverride ? (
                    <div
                      className="gm-brand-global-cjk-guard gm-brand-alert-title-row"
                      data-testid="global-cjk-identity-guard"
                    >
                      <Checkbox
                        data-testid="allow-cjk-global-identity-checkbox"
                        checked={allowCjkGlobalIdentity}
                        disabled={readOnly || saving}
                        onChange={(event) => {
                          setAllowCjkGlobalIdentity(event.target.checked);
                          if (event.target.checked && marketError) {
                            setMarketError(null);
                          }
                        }}
                      >
                        保留中文
                      </Checkbox>
                      <Explain
                        text={`${GLOBAL_CJK_IDENTITY_OVERRIDE_LABEL}（确认保留中文用于海外市场）`}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}

              <FormField label="品牌别名" help="本地品牌别名或 SKU 词，最多 20 个">
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
                      添加
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

              <FormField label="官网域名" help="本地自有官网或文档域名，驱动自有信源归类">
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
                      添加
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

              <FormField label={`竞品 ${competitorRows.length}/${BRAND_MAX_COMPETITORS}`}>
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
                    添加竞品
                  </Button>
                </div>
              </FormField>

              <FormField label={`监控问句 ${seedPrompts.length}/50`}>
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
                      添加
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
                  label="多语种"
                  help="海外支持写作语种（至少 1 个）；开启多语种后写作台自动出现语种切换；支持英语（美/英）、德语、日语、西语、法语，日语内容自动采用防误判双信号校验。"
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

              <div className="gm-brand-extra-doc">
                <div className="gm-brand-advanced-toggle-row">
                  <button
                    type="button"
                    className="gm-brand-extra-doc-toggle"
                    data-testid="brand-advanced-control-toggle"
                    aria-expanded={controlPanelOpen}
                    onClick={() => setControlPanelOpen((prev) => !prev)}
                  >
                    <span>{controlPanelOpen ? '▾' : '▸'} 对照组</span>
                  </button>
                  <Explain text="配置 DiD 对照组基准问句与本月自动复测点数上限。" />
                </div>

                {controlPanelOpen ? (
                  <div className="gm-brand-extra-doc-body">
                    <FormField
                      data-testid="brand-control-prompts-field"
                      label={`对照组 ${controlPrompts.length}/${BRAND_MAX_CONTROL_PROMPTS}`}
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
                              readOnly ||
                              saving ||
                              controlPrompts.length >= BRAND_MAX_CONTROL_PROMPTS
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
                            添加
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
                                      label="默认"
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
                                      setControlPrompts((prev) =>
                                        prev.filter((item) => item !== prompt),
                                      )
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

                    <FormField
                      data-testid="brand-retest-cap-field"
                      label="复测上限"
                      htmlFor="market-retest-cap-input"
                      help={
                        retestBudget
                          ? `仅约束定时自动复测，超限时温和跳过并提示，不影响手动写作、监测与复测。本月（${retestBudget.monthKey}）已消耗 ${retestBudget.usedPoints} 点${retestBudget.capPoints !== null ? ` / 上限 ${retestBudget.capPoints} 点` : ''}。`
                          : '仅约束定时自动复测，超限时温和跳过并提示，不影响手动写作、监测与复测。'
                      }
                    >
                      <InputNumber
                        id="market-retest-cap-input"
                        data-testid="market-retest-cap-input"
                        aria-label="本月自动复测点数上限"
                        min={1}
                        max={1_000_000}
                        precision={0}
                        placeholder="留空不限"
                        value={monthlyRetestPointCap}
                        disabled={readOnly || saving}
                        className="gm-brand-w-full"
                        onChange={(val) => {
                          setMonthlyRetestPointCap(
                            typeof val === 'number' && Number.isFinite(val)
                              ? Math.trunc(val)
                              : null,
                          );
                          if (marketError) setMarketError(null);
                        }}
                      />
                    </FormField>
                  </div>
                ) : null}
              </div>

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
            <EmptyState
              size="compact"
              title="市场未开"
              description="请在顶部或页头开启当前市场后再维护该市场配置。"
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
          <StatusBadge tone="warning" size="sm" label="未保存" />
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
      <BrandMarketAiSuggestModal
        open={aiModalOpen}
        market={activeMarket}
        mode={aiModalMode}
        loading={aiSuggestLoading}
        error={aiSuggestError}
        suggestion={aiSuggestion}
        currentLocalBrandName={localBrandName}
        currentLocalCategory={localCategory}
        sourceUrl={aiSourceUrl}
        allowSourceUrl={aiModalMode === 'full'}
        onSourceUrlChange={setAiSourceUrl}
        onRegenerate={(url) => void openAiSuggest(aiModalMode, url)}
        onConfirm={handleApplyAiSelection}
        onCancel={handleCloseAiModal}
      />
    </Section>
  );
}
