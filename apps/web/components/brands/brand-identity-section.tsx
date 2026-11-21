'use client';

import {
  BRAND_CATEGORY_MAX,
  BRAND_MAX_COMPETITORS,
  BRAND_NAME_MAX,
  GEO_MARKET_LABELS,
  normalizeBrandDomain,
  type BrandMarketRecord,
  type BrandRecord,
  type GeoMarket,
} from '@geomix/shared';
import { Alert, Button, Input, Tag } from 'antd';
import { useEffect, useState } from 'react';
import { deleteBrand, updateBrand, updateBrandMarket } from '../../lib/brands';
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
  const [aliases, setAliases] = useState<string[]>(activeBrandMarket?.aliases ?? []);
  const [aliasInput, setAliasInput] = useState('');
  const [ownedDomains, setOwnedDomains] = useState<string[]>(activeBrandMarket?.ownedDomains ?? []);
  const [domainInput, setDomainInput] = useState('');
  const [competitorRows, setCompetitorRows] = useState<CompetitorDraftRow[]>(
    hydrateCompetitorRows(activeBrandMarket?.competitors ?? []),
  );
  const [seedPrompts, setSeedPrompts] = useState<string[]>(activeBrandMarket?.seedPrompts ?? []);
  const [promptInput, setPromptInput] = useState('');
  const [savingMarket, setSavingMarket] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);

  useEffect(() => {
    setBrandName(brand.name);
    setBrandCategory(brand.category);
    setBrandError(null);
  }, [brand.id, brand.name, brand.category]);

  useEffect(() => {
    setLocalBrandName(activeBrandMarket?.localBrandName ?? brand.name);
    setAliases(activeBrandMarket?.aliases ?? []);
    setAliasInput('');
    setOwnedDomains(activeBrandMarket?.ownedDomains ?? []);
    setDomainInput('');
    setCompetitorRows(hydrateCompetitorRows(activeBrandMarket?.competitors ?? []));
    setSeedPrompts(activeBrandMarket?.seedPrompts ?? []);
    setPromptInput('');
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
        await deleteBrand(brand.id, { storage: window.sessionStorage });
        onBrandDeleted(brand.id);
        feedback.notifySuccess(`已删除品牌「${brand.name}」`);
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

  const handleSaveMarket = async () => {
    if (!activeBrandMarket) return;
    setMarketError(null);

    const trimmedLocal = localBrandName.trim();
    if (!trimmedLocal) {
      setMarketError('请填写当地品牌名称');
      return;
    }

    const { competitors, invalidDomainRows } = serializeCompetitorRows(competitorRows);
    if (invalidDomainRows.length > 0) {
      setMarketError(`请检查竞品域名格式：${invalidDomainRows.join('；')}`);
      return;
    }

    setSavingMarket(true);
    try {
      const updated = await updateBrandMarket(
        brand.id,
        activeMarket,
        {
          localBrandName: trimmedLocal,
          aliases,
          ownedDomains,
          competitors,
          seedPrompts,
        },
        { storage: window.sessionStorage },
      );
      onBrandUpdated(updated, activeMarket);
      feedback.notifySuccess(`已保存${GEO_MARKET_LABELS[activeMarket]}配置`);
    } catch (reason: unknown) {
      setMarketError(
        reason instanceof Error && reason.message ? reason.message : '保存市场配置失败',
      );
    } finally {
      setSavingMarket(false);
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
              <div className="gm-brand-field">
                <label htmlFor="gm-market-local-name">当地品牌名</label>
                <Input
                  id="gm-market-local-name"
                  aria-label="当地品牌名"
                  maxLength={BRAND_NAME_MAX}
                  value={localBrandName}
                  disabled={readOnly || savingMarket}
                  onChange={(event) => setLocalBrandName(event.target.value)}
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
                <span className="gm-brand-field-label">
                  高频监控问句种子（{seedPrompts.length} / 50）
                </span>
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

              {marketError ? (
                <Alert type="error" showIcon message={marketError} style={{ marginBottom: 12 }} />
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
