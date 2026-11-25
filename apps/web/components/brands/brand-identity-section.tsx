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
import { useEffect, useRef, useState } from 'react';
import { deleteBrand, updateBrand, updateBrandMarket } from '../../lib/brands';
import { invalidateFreshness } from '../../lib/tab-freshness';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { useUxFeedback } from '../crud/ux-feedback';
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
  onBrandDeleted: (brandId: string) => void;
  onOpenEnableMarket: (market: GeoMarket) => void;
};

let identityCompSeq = 1;
function createBlankCompetitor(): CompetitorDraftRow {
  identityCompSeq += 1;
  return { key: `id-comp-${identityCompSeq}`, name: '', domainsText: '', aliasesText: '' };
}

export function BrandIdentitySection({
  brand,
  activeMarket,
  activeBrandMarket,
  readOnly,
  onBrandUpdated,
  onBrandDeleted,
  onOpenEnableMarket,
}: BrandIdentitySectionProps) {
  const feedback = useUxFeedback();

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
  const [competitorRows, setCompetitorRows] = useState<CompetitorDraftRow[]>(
    hydrateCompetitorRows(activeBrandMarket?.competitors ?? []),
  );
  const resolveInitialLocales = (
    market: GeoMarket,
    bm: BrandMarketRecord | null,
  ): SupportedLocale[] => {
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
  };

  const [seedPrompts, setSeedPrompts] = useState<string[]>(activeBrandMarket?.seedPrompts ?? []);
  const [promptInput, setPromptInput] = useState('');
  const [supportedLocales, setSupportedLocales] = useState<SupportedLocale[]>(() =>
    resolveInitialLocales(activeMarket, activeBrandMarket),
  );
  const [controlPrompts, setControlPrompts] = useState<string[]>(
    activeBrandMarket?.controlPrompts ?? [],
  );
  const [controlPromptInput, setControlPromptInput] = useState('');
  const [savingMarket, setSavingMarket] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const marketSeqRef = useRef(0);
  const marketSaveCtrlRef = useRef<AbortController | null>(null);

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

  useEffect(() => {
    setLocalBrandName(activeBrandMarket?.localBrandName ?? brand.name);
    setLocalCategory(activeBrandMarket?.localCategory ?? '');
    setAliases(activeBrandMarket?.aliases ?? []);
    setAliasInput('');
    setOwnedDomains(activeBrandMarket?.ownedDomains ?? []);
    setDomainInput('');
    setCompetitorRows(hydrateCompetitorRows(activeBrandMarket?.competitors ?? []));
    setSeedPrompts(activeBrandMarket?.seedPrompts ?? []);
    setPromptInput('');
    setSupportedLocales(resolveInitialLocales(activeMarket, activeBrandMarket));
    setControlPrompts(activeBrandMarket?.controlPrompts ?? []);
    setControlPromptInput('');
    setMarketError(null);
  }, [brand.id, brand.name, activeMarket, activeBrandMarket]);

  const hasCN = brand.markets.some((m) => m.market === 'CN');
  const hasGlobal = brand.markets.some((m) => m.market === 'GLOBAL');

  const handleSaveBrand = async () => {
    setBrandError(null);
    const trimmedName = brandName.trim();
    const trimmedCategory = brandCategory.trim();
    if (!trimmedName) {
      setBrandError('请填写品牌名称');
      return;
    }
    if (!trimmedCategory) {
      setBrandError('请填写所属品类');
      return;
    }
    setSavingBrand(true);
    try {
      const updated = await updateBrand(
        brand.id,
        { name: trimmedName, category: trimmedCategory },
        { storage: window.sessionStorage },
      );
      onBrandUpdated(updated, activeMarket);
      feedback.notifySuccess('已保存品牌基础信息');
    } catch (reason: unknown) {
      setBrandError(reason instanceof Error && reason.message ? reason.message : '保存品牌失败');
    } finally {
      setSavingBrand(false);
    }
  };

  const handleDeleteBrand = () => {
    feedback.confirm({
      title: `确认删除品牌「${brand.name}」？`,
      content: '删除后将同步清除该品牌的市场配置、事实卡与产品实拍图，无法恢复。',
      okText: '确认删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await deleteBrand(brand.id, { storage: window.sessionStorage });
          onBrandDeleted(brand.id);
          feedback.notifySuccess(`已删除品牌「${brand.name}」`);
        } catch (reason: unknown) {
          feedback.notifyError(
            reason instanceof Error && reason.message ? reason.message : '删除品牌失败',
          );
        }
      },
    });
  };

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

  const handleSaveMarket = async () => {
    if (!activeBrandMarket) return;
    setMarketError(null);

    const trimmedLocal = localBrandName.trim();
    if (!trimmedLocal) {
      setMarketError('请填写当地品牌名称');
      return;
    }

    if (activeMarket === 'GLOBAL' && supportedLocales.length === 0) {
      setMarketError('请至少保留 1 个支持语种');
      return;
    }

    if (controlPrompts.length > BRAND_MAX_CONTROL_PROMPTS) {
      setMarketError(`最多配置 ${BRAND_MAX_CONTROL_PROMPTS} 条对照组问句`);
      return;
    }

    const overlapCheck = validateControlPromptsAgainstSeeds(controlPrompts, seedPrompts);
    if (!overlapCheck.ok) {
      setMarketError(`对照组问句不能与种子监控问句重复：${overlapCheck.duplicates[0]}`);
      return;
    }

    const { competitors, invalidDomainRows } = serializeCompetitorRows(competitorRows);
    if (invalidDomainRows.length > 0) {
      setMarketError(`请检查竞品域名格式：${invalidDomainRows.join('；')}`);
      return;
    }

    marketSaveCtrlRef.current?.abort();
    const ctrl = new AbortController();
    marketSaveCtrlRef.current = ctrl;
    const seq = ++marketSeqRef.current;
    const saveBrandId = brand.id;
    const saveMarket = activeMarket;

    setSavingMarket(true);
    try {
      const updated = await updateBrandMarket(
        saveBrandId,
        saveMarket,
        {
          localBrandName: trimmedLocal,
          localCategory: localCategory.trim() || null,
          aliases,
          ownedDomains,
          competitors,
          seedPrompts,
          ...(saveMarket === 'GLOBAL' ? { supportedLocales } : {}),
          controlPrompts,
        },
        { storage: window.sessionStorage, signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || seq !== marketSeqRef.current) return;
      onBrandUpdated(updated, saveMarket);
      invalidateFreshness('brands');
      feedback.notifySuccess(`已保存${GEO_MARKET_LABELS[saveMarket]}配置`);
    } catch (reason: unknown) {
      if (ctrl.signal.aborted || seq !== marketSeqRef.current) return;
      setMarketError(
        reason instanceof Error && reason.message ? reason.message : '保存市场配置失败',
      );
    } finally {
      if (marketSaveCtrlRef.current === ctrl) {
        marketSaveCtrlRef.current = null;
      }
      if (!ctrl.signal.aborted && seq === marketSeqRef.current) {
        setSavingMarket(false);
      }
    }
  };

  return (
    <section
      id="brand-section-identity"
      className="gm-brand-section"
      aria-label="基础身份与竞品雷达"
    >
      <div className="gm-brand-section-head">
        <div>
          <h2 className="gm-brand-section-title">1. 基础身份与竞品雷达</h2>
          <p className="gm-brand-section-desc">
            维护品牌主档与当前市场（CN / GLOBAL）独立的官网域名、竞品域名与监控种子问句。
          </p>
        </div>
      </div>

      <div className="gm-brand-identity-grid">
        {/* Left: Shared Brand Profile */}
        <div className="gm-brand-subcard">
          <div className="gm-brand-subcard-head">
            <h3>品牌主档案</h3>
            <Tag>双市场共享</Tag>
          </div>

          <div className="gm-brand-field">
            <label htmlFor="gm-edit-brand-name">品牌名称</label>
            <Input
              id="gm-edit-brand-name"
              aria-label="编辑品牌名称"
              maxLength={BRAND_NAME_MAX}
              value={brandName}
              disabled={readOnly || savingBrand}
              onChange={(event) => setBrandName(event.target.value)}
            />
          </div>

          <div className="gm-brand-field">
            <label htmlFor="gm-edit-brand-category">所属品类</label>
            <Input
              id="gm-edit-brand-category"
              aria-label="编辑所属品类"
              maxLength={BRAND_CATEGORY_MAX}
              value={brandCategory}
              disabled={readOnly || savingBrand}
              onChange={(event) => setBrandCategory(event.target.value)}
            />
          </div>

          <div className="gm-brand-field">
            <span className="gm-brand-field-label">已开启目标市场</span>
            <div className="gm-brand-market-pills">
              {hasCN ? (
                <Button
                  size="small"
                  type={activeMarket === 'CN' ? 'primary' : 'default'}
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
                  type={activeMarket === 'GLOBAL' ? 'primary' : 'default'}
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
          </div>

          {brandError ? (
            <Alert type="error" showIcon message={brandError} style={{ marginBottom: 12 }} />
          ) : null}

          <div className="gm-brand-subcard-actions">
            <Button
              type="primary"
              loading={savingBrand}
              disabled={readOnly}
              onClick={() => void handleSaveBrand()}
            >
              保存基础信息
            </Button>
            <Button danger disabled={readOnly || savingBrand} onClick={handleDeleteBrand}>
              删除品牌
            </Button>
          </div>
        </div>

        {/* Right: Active Market Identity & Competitor Radar */}
        <div className="gm-brand-subcard">
          <div className="gm-brand-subcard-head">
            <h3>
              {activeMarket === 'CN' ? '🇨🇳 国内市场身份与竞品雷达' : '🌐 海外市场身份与竞品雷达'}
            </h3>
            {activeBrandMarket ? (
              <Tag color="cyan">
                {activeBrandMarket.locale} / {activeBrandMarket.region}
              </Tag>
            ) : null}
          </div>

          {activeBrandMarket ? (
            <>
              {activeMarket === 'GLOBAL' &&
              (containsCjk(localBrandName) ||
                (!localCategory.trim() && containsCjk(brand.category)) ||
                ownedDomains.some((d) => d.endsWith('.cn'))) ? (
                <Alert
                  type="warning"
                  showIcon
                  data-testid="global-localization-guide"
                  style={{ marginBottom: 12 }}
                  message="建议完善海外市场英文身份"
                  description="检测到海外市场仍包含中文品牌名、未设置英文品类或使用 .cn 域名，建议补全纯英文当地品牌名、当地品类与海外官网域名，以保障英文种子问句、JSON-LD 与 llms.txt 的专业输出。"
                />
              ) : null}

              <div className="gm-brand-field">
                <label htmlFor="gm-market-local-name">当地品牌名</label>
                <Input
                  id="gm-market-local-name"
                  aria-label="当地品牌名"
                  maxLength={BRAND_NAME_MAX}
                  value={localBrandName}
                  disabled={readOnly || savingMarket}
                  placeholder={activeMarket === 'GLOBAL' ? '例如：ExampleBrand' : '例如：绿联'}
                  onChange={(event) => setLocalBrandName(event.target.value)}
                />
              </div>

              <div className="gm-brand-field">
                <label htmlFor="gm-market-local-category">
                  当地品类名称（用于该市场种子问句、Schema 与 llms.txt）
                </label>
                <Input
                  id="gm-market-local-category"
                  aria-label="当地品类名称"
                  maxLength={BRAND_CATEGORY_MAX}
                  value={localCategory}
                  disabled={readOnly || savingMarket}
                  placeholder={
                    activeMarket === 'GLOBAL'
                      ? '例如：Home NAS / Portable Power Station（留空将自动回退英文品类）'
                      : `留空默认继承主档案品类（${brand.category}）`
                  }
                  onChange={(event) => setLocalCategory(event.target.value)}
                />
              </div>

              <div className="gm-brand-field">
                <span className="gm-brand-field-label">当地品牌别名 / SKU 词（最多 20 个）</span>
                <div className="gm-brand-chip-input-row">
                  <Input
                    aria-label="添加市场别名"
                    value={aliasInput}
                    maxLength={BRAND_NAME_MAX}
                    disabled={readOnly || savingMarket || aliases.length >= 20}
                    placeholder="输入别名或系列型号后回车"
                    onChange={(event) => setAliasInput(event.target.value)}
                    onPressEnter={(event) => {
                      event.preventDefault();
                      handleAddAlias();
                    }}
                  />
                  <Button
                    disabled={
                      readOnly || savingMarket || !aliasInput.trim() || aliases.length >= 20
                    }
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
                        closable={!readOnly && !savingMarket}
                        onClose={() => setAliases((prev) => prev.filter((x) => x !== item))}
                      >
                        {item}
                      </Tag>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="gm-brand-field">
                <span className="gm-brand-field-label">
                  当地自有官网 / 文档域名（驱动自有信源归类）
                </span>
                <div className="gm-brand-chip-input-row">
                  <Input
                    aria-label="添加自有官网域名"
                    value={domainInput}
                    disabled={readOnly || savingMarket || ownedDomains.length >= 20}
                    placeholder="输入域名如 example.com 后回车"
                    onChange={(event) => setDomainInput(event.target.value)}
                    onPressEnter={(event) => {
                      event.preventDefault();
                      handleAddDomain();
                    }}
                  />
                  <Button
                    disabled={
                      readOnly || savingMarket || !domainInput.trim() || ownedDomains.length >= 20
                    }
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
                        color="blue"
                        closable={!readOnly && !savingMarket}
                        onClose={() => setOwnedDomains((prev) => prev.filter((x) => x !== domain))}
                      >
                        {domain}
                      </Tag>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="gm-brand-field">
                <span className="gm-brand-field-label">
                  主要竞品与竞品域名（{competitorRows.length} / {BRAND_MAX_COMPETITORS}）
                </span>
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
                            disabled={readOnly || savingMarket}
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
                            disabled={readOnly || savingMarket}
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
                          <Button
                            size="small"
                            danger
                            disabled={readOnly || savingMarket}
                            onClick={() =>
                              setCompetitorRows((prev) =>
                                prev.filter((item) => item.key !== row.key),
                              )
                            }
                          >
                            移除
                          </Button>
                        </div>
                        {hasPreviewChips ? (
                          <div className="gm-brand-chip-list gm-brand-competitor-chips">
                            {trimmedName ? <Tag>{trimmedName}</Tag> : null}
                            {parsedAliases.map((alias) => (
                              <Tag key={`alias-${alias}`}>{alias}</Tag>
                            ))}
                            {parsedDomains.map((domain) => (
                              <Tag key={`domain-${domain}`} color="volcano">
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
                    disabled={
                      readOnly || savingMarket || competitorRows.length >= BRAND_MAX_COMPETITORS
                    }
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
              </div>

              <div className="gm-brand-field">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    flexWrap: 'wrap',
                  }}
                >
                  <span className="gm-brand-field-label">
                    高频监控问句种子（{seedPrompts.length} / 50）
                  </span>
                  {!readOnly ? (
                    <Button
                      size="small"
                      aria-label="按当前品类重新生成种子问句"
                      disabled={savingMarket}
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
                  ) : null}
                </div>
                <div className="gm-brand-chip-input-row">
                  <Input
                    aria-label="添加监控问句种子"
                    value={promptInput}
                    maxLength={300}
                    disabled={readOnly || savingMarket || seedPrompts.length >= 50}
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
                      savingMarket ||
                      promptInput.trim().length < 2 ||
                      seedPrompts.length >= 50
                    }
                    onClick={handleAddSeedPrompt}
                  >
                    + 添加
                  </Button>
                </div>
                {seedPrompts.length > 0 ? (
                  <div className="gm-brand-seed-list">
                    {seedPrompts.map((prompt) => (
                      <div key={prompt} className="gm-brand-seed-item">
                        <span>{prompt}</span>
                        {!readOnly ? (
                          <Button
                            type="text"
                            size="small"
                            danger
                            disabled={savingMarket}
                            onClick={() =>
                              setSeedPrompts((prev) => prev.filter((item) => item !== prompt))
                            }
                          >
                            移除
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {activeMarket === 'GLOBAL' ? (
                <div className="gm-brand-field" data-testid="brand-supported-locales-field">
                  <span className="gm-brand-field-label">
                    海外支持写作语种（至少 1 个；开启多语种后写作台自动出现语种切换）
                  </span>
                  <Select<SupportedLocale[]>
                    mode="multiple"
                    aria-label="海外支持写作语种"
                    data-testid="brand-supported-locales-select"
                    style={{ width: '100%' }}
                    disabled={readOnly || savingMarket}
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
                  <div style={{ fontSize: 12, color: 'var(--gm-fg-3)', marginTop: 4 }}>
                    支持英语（美/英）、德语、日语、西语、法语；日语内容自动采用防误判双信号校验。
                  </div>
                </div>
              ) : null}

              <div className="gm-brand-field" data-testid="brand-control-prompts-field">
                <span className="gm-brand-field-label">
                  对照组问句（DiD 归因基线，{controlPrompts.length} / {BRAND_MAX_CONTROL_PROMPTS}）
                </span>
                <div style={{ fontSize: 12, color: 'var(--gm-fg-3)', marginBottom: 6 }}>
                  开启对照组自动复测时默认取前 {BRAND_DEFAULT_RETEST_CONTROL_PROMPTS}{' '}
                  条问句作为未发稿基线（最多 {BRAND_MAX_CONTROL_PROMPTS}{' '}
                  条），且不可与上方种子监控问句重复。
                </div>
                <div className="gm-brand-chip-input-row">
                  <Input
                    aria-label="添加对照组问句"
                    data-testid="control-prompt-input"
                    value={controlPromptInput}
                    maxLength={300}
                    disabled={
                      readOnly || savingMarket || controlPrompts.length >= BRAND_MAX_CONTROL_PROMPTS
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
                      savingMarket ||
                      controlPromptInput.trim().length < 2 ||
                      controlPrompts.length >= BRAND_MAX_CONTROL_PROMPTS
                    }
                    onClick={handleAddControlPrompt}
                  >
                    + 添加
                  </Button>
                </div>
                {controlPrompts.length > 0 ? (
                  <div className="gm-brand-seed-list" data-testid="control-prompts-list">
                    {controlPrompts.map((prompt, index) => (
                      <div key={prompt} className="gm-brand-seed-item">
                        <span style={{ overflowWrap: 'anywhere' }}>
                          {prompt}
                          {index < BRAND_DEFAULT_RETEST_CONTROL_PROMPTS ? (
                            <Tag
                              color="cyan"
                              style={{ marginLeft: 8, marginRight: 0, fontSize: 11 }}
                            >
                              默认 DiD 对照
                            </Tag>
                          ) : null}
                        </span>
                        {!readOnly ? (
                          <Button
                            type="text"
                            size="small"
                            danger
                            disabled={savingMarket}
                            onClick={() =>
                              setControlPrompts((prev) => prev.filter((item) => item !== prompt))
                            }
                          >
                            移除
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              {marketError ? (
                <Alert
                  type="error"
                  showIcon
                  data-testid="brand-market-error"
                  message={marketError}
                  style={{ marginBottom: 12 }}
                />
              ) : null}

              <div className="gm-brand-subcard-actions">
                <Button
                  type="primary"
                  loading={savingMarket}
                  disabled={readOnly}
                  onClick={() => void handleSaveMarket()}
                >
                  保存市场配置
                </Button>
              </div>
            </>
          ) : (
            <Alert
              type="info"
              showIcon
              message="当前市场尚未开启"
              action={
                <Button
                  size="small"
                  type="primary"
                  disabled={readOnly}
                  onClick={() => onOpenEnableMarket(activeMarket)}
                >
                  立即开启
                </Button>
              }
            />
          )}
        </div>
      </div>
    </section>
  );
}
