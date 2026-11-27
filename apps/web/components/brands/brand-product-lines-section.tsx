'use client';

import {
  BRAND_CATEGORY_MAX,
  BRAND_MAX_COMPETITORS,
  BRAND_MAX_PRODUCT_LINES,
  BRAND_NAME_MAX,
  GEO_MARKET_LABELS,
  PRODUCT_LINE_MAX_SEED_PROMPTS,
  readProductLineMarketCompetitors,
  readProductLineMarketSeedPrompts,
  type BrandProductLineDto,
  type BrandRecord,
  type CreateProductLineInput,
  type GeoMarket,
  type ProductLineCompetitors,
  type ProductLineLocalCategories,
  type ProductLineLocalNames,
  type ProductLineSeedPrompts,
} from '@geomix/shared';
import { Alert, Button, Input, InputNumber, Modal, Tag } from 'antd';
import type { JSX } from 'react';
import { useState } from 'react';
import {
  createBrandProductLine,
  deleteBrandProductLine,
  updateBrandProductLine,
} from '../../lib/brands';
import { GatewayApiError } from '../../lib/envelope';
import { GEO_MARKET_SHORT } from '../../lib/short-labels';
import { invalidateFreshness } from '../../lib/tab-freshness';
import { parsePromptLines } from '../../lib/visibility';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalError, SignalSkeleton } from '../geo/primitives';
import {
  EmptyState,
  Explain,
  FormField,
  RowActions,
  Section,
  StatusBadge,
  type RowActionItem,
} from '../ui';
import {
  hydrateCompetitorRows,
  serializeCompetitorRows,
  type CompetitorDraftRow,
} from './brand-form-helpers';

export type BrandProductLinesSectionProps = {
  brand: BrandRecord;
  activeMarket: GeoMarket;
  productLines: readonly BrandProductLineDto[];
  loading: boolean;
  error: string | null;
  readOnly: boolean;
  onRetry: () => void;
  onProductLinesChanged?: () => void;
};

let plCompSeq = 1;
function createBlankCompetitor(): CompetitorDraftRow {
  plCompSeq += 1;
  return { key: `pl-comp-${plCompSeq}`, name: '', domainsText: '', aliasesText: '' };
}

function formatProductLineError(err: unknown, fallback: string): string {
  if (err instanceof GatewayApiError) {
    if (err.status === 409) {
      return err.message || '同品牌下已存在同名产品线';
    }
    return err.message || fallback;
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  return fallback;
}

export function BrandProductLinesSection({
  brand,
  activeMarket,
  productLines,
  loading,
  error,
  readOnly,
  onRetry,
  onProductLinesChanged,
}: BrandProductLinesSectionProps): JSX.Element {
  const feedback = useUxFeedback();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingLine, setEditingLine] = useState<BrandProductLineDto | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingLineId, setDeletingLineId] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  // Modal fields
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [localNameCn, setLocalNameCn] = useState('');
  const [localNameGlobal, setLocalNameGlobal] = useState('');
  const [localCategoryCn, setLocalCategoryCn] = useState('');
  const [localCategoryGlobal, setLocalCategoryGlobal] = useState('');
  const [sortOrder, setSortOrder] = useState<number>(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [overrideMarket, setOverrideMarket] = useState<GeoMarket>(activeMarket);
  const [seedPromptsTextByMarket, setSeedPromptsTextByMarket] = useState<Record<GeoMarket, string>>(
    { CN: '', GLOBAL: '' },
  );
  const [competitorsByMarket, setCompetitorsByMarket] = useState<
    Record<GeoMarket, CompetitorDraftRow[]>
  >({ CN: [], GLOBAL: [] });

  const reachedMax = productLines.length >= BRAND_MAX_PRODUCT_LINES;

  const openCreateModal = () => {
    setEditingLine(null);
    setName('');
    setCategory('');
    setLocalNameCn('');
    setLocalNameGlobal('');
    setLocalCategoryCn('');
    setLocalCategoryGlobal('');
    setSortOrder(productLines.length);
    setAdvancedOpen(false);
    setOverrideMarket(activeMarket);
    setSeedPromptsTextByMarket({ CN: '', GLOBAL: '' });
    setCompetitorsByMarket({ CN: [], GLOBAL: [] });
    setModalError(null);
    setModalOpen(true);
  };

  const openEditModal = (line: BrandProductLineDto) => {
    const cnSeeds = readProductLineMarketSeedPrompts(line.seedPromptsJson, 'CN');
    const globalSeeds = readProductLineMarketSeedPrompts(line.seedPromptsJson, 'GLOBAL');
    const cnComps = readProductLineMarketCompetitors(line.competitorsJson, 'CN');
    const globalComps = readProductLineMarketCompetitors(line.competitorsJson, 'GLOBAL');

    setEditingLine(line);
    setName(line.name);
    setCategory(line.category);
    setLocalNameCn(line.localNamesJson?.CN ?? '');
    setLocalNameGlobal(line.localNamesJson?.GLOBAL ?? '');
    setLocalCategoryCn(line.localCategoriesJson?.CN ?? '');
    setLocalCategoryGlobal(line.localCategoriesJson?.GLOBAL ?? '');
    setSortOrder(line.sortOrder ?? 0);
    setAdvancedOpen(false);
    setOverrideMarket(activeMarket);
    setSeedPromptsTextByMarket({
      CN: cnSeeds.join('\n'),
      GLOBAL: globalSeeds.join('\n'),
    });
    setCompetitorsByMarket({
      CN: hydrateCompetitorRows(cnComps),
      GLOBAL: hydrateCompetitorRows(globalComps),
    });
    setModalError(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    if (submitting) return;
    setModalOpen(false);
    setModalError(null);
  };

  const handleSubmit = async () => {
    if (readOnly || submitting) return;
    setModalError(null);

    const trimmedName = name.trim();
    const trimmedCategory = category.trim();
    if (!trimmedName) {
      setModalError('请填写产品线名称');
      return;
    }
    if (!trimmedCategory) {
      setModalError('请填写默认品类');
      return;
    }

    const cnPrompts = parsePromptLines(seedPromptsTextByMarket.CN);
    const globalPrompts = parsePromptLines(seedPromptsTextByMarket.GLOBAL);
    if (cnPrompts.length > PRODUCT_LINE_MAX_SEED_PROMPTS) {
      setModalError(`国内监控问题最多配置 ${PRODUCT_LINE_MAX_SEED_PROMPTS} 条`);
      return;
    }
    if (globalPrompts.length > PRODUCT_LINE_MAX_SEED_PROMPTS) {
      setModalError(`海外监控问题最多配置 ${PRODUCT_LINE_MAX_SEED_PROMPTS} 条`);
      return;
    }

    const cnCompSerialized = serializeCompetitorRows(competitorsByMarket.CN);
    if (cnCompSerialized.invalidDomainRows.length > 0) {
      setModalError(`国内竞品域名格式有误：${cnCompSerialized.invalidDomainRows.join('；')}`);
      return;
    }
    const globalCompSerialized = serializeCompetitorRows(competitorsByMarket.GLOBAL);
    if (globalCompSerialized.invalidDomainRows.length > 0) {
      setModalError(`海外竞品域名格式有误：${globalCompSerialized.invalidDomainRows.join('；')}`);
      return;
    }

    const localNamesJson: ProductLineLocalNames = {};
    if (localNameCn.trim()) localNamesJson.CN = localNameCn.trim();
    if (localNameGlobal.trim()) localNamesJson.GLOBAL = localNameGlobal.trim();

    const localCategoriesJson: ProductLineLocalCategories = {};
    if (localCategoryCn.trim()) localCategoriesJson.CN = localCategoryCn.trim();
    if (localCategoryGlobal.trim()) localCategoriesJson.GLOBAL = localCategoryGlobal.trim();

    const seedPromptsJson: ProductLineSeedPrompts = {};
    if (cnPrompts.length > 0) seedPromptsJson.CN = cnPrompts;
    if (globalPrompts.length > 0) seedPromptsJson.GLOBAL = globalPrompts;

    const competitorsJson: ProductLineCompetitors = {};
    if (cnCompSerialized.competitors.length > 0) {
      competitorsJson.CN = cnCompSerialized.competitors;
    }
    if (globalCompSerialized.competitors.length > 0) {
      competitorsJson.GLOBAL = globalCompSerialized.competitors;
    }

    const payload: CreateProductLineInput = {
      name: trimmedName,
      category: trimmedCategory,
      localNamesJson,
      localCategoriesJson,
      seedPromptsJson,
      competitorsJson,
      sortOrder: Math.max(0, Math.min(1000, Math.trunc(sortOrder || 0))),
    };

    setSubmitting(true);
    try {
      const saved = editingLine
        ? await updateBrandProductLine(brand.id, editingLine.id, payload, {
            storage: window.sessionStorage,
          })
        : await createBrandProductLine(brand.id, payload, {
            storage: window.sessionStorage,
          });
      useWorkspaceStore.getState().upsertProductLine(saved);
      invalidateFreshness('product-lines', 'brands');
      onProductLinesChanged?.();
      setModalOpen(false);
      feedback.notifySuccess(
        editingLine ? `已更新产品线「${saved.name}」` : `已创建产品线「${saved.name}」`,
      );
    } catch (err: unknown) {
      setModalError(formatProductLineError(err, editingLine ? '更新产品线失败' : '创建产品线失败'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteLine = async (line: BrandProductLineDto) => {
    if (readOnly || deletingLineId) return;
    setDeletingLineId(line.id);
    try {
      await deleteBrandProductLine(brand.id, line.id, { storage: window.sessionStorage });
      useWorkspaceStore.getState().removeProductLine(line.id);
      invalidateFreshness('product-lines', 'brand-facts', 'brands');
      onProductLinesChanged?.();
      feedback.notifySuccess(`已删除产品线「${line.name}」，历史资产已保留为品牌通用`);
    } catch (err: unknown) {
      feedback.notifyError(formatProductLineError(err, '删除产品线失败'));
    } finally {
      setDeletingLineId(null);
    }
  };

  const activeMarketCompetitors = competitorsByMarket[overrideMarket];

  return (
    <Section
      id="brand-section-product-lines"
      data-testid="brand-product-lines-section"
      variant="plain"
      aria-label="产品线"
      title={
        <span className="gm-brand-section-title-row">
          <span>产品线</span>
          <StatusBadge
            tone={reachedMax ? 'warning' : 'neutral'}
            label={`${productLines.length} / ${BRAND_MAX_PRODUCT_LINES}`}
          />
        </span>
      }
      description="单品类品牌无需配置，全站保持零噪音视图；多品类品牌可按产品线独立设置品类、本地名、监控问句与竞品雷达。"
      actions={
        <Button
          type="default"
          data-testid="brand-add-product-line-btn"
          disabled={readOnly || loading || reachedMax}
          className="gm-brand-btn-nowrap"
          onClick={openCreateModal}
        >
          新增产线
        </Button>
      }
    >
      {reachedMax ? (
        <Alert
          type="info"
          showIcon
          className="gm-brand-inline-alert gm-brand-mb-sm"
          message={
            <span className="gm-brand-alert-title-row">
              <span>已达上限</span>
              <Explain
                text={`单品牌最多配置 ${BRAND_MAX_PRODUCT_LINES} 条产品线，如需新增请先删除或合并已有产品线。`}
              />
            </span>
          }
        />
      ) : null}

      {loading && productLines.length === 0 ? (
        <SignalSkeleton variant="row" rows={2} />
      ) : error && productLines.length === 0 ? (
        <SignalError message={error} onRetry={onRetry} />
      ) : productLines.length === 0 ? (
        <EmptyState
          size="compact"
          title="暂无产线"
          description="未配置产品线时，首页、可见度诊断与写作台保持单品类极简视图；当品牌横跨多个品类时，可点击「新增产线」开启渐进式多产品线隔离。"
        />
      ) : (
        <div className="gm-brand-pl-list" data-testid="brand-product-lines-list">
          {productLines.map((line) => {
            const cnSeeds = readProductLineMarketSeedPrompts(line.seedPromptsJson, 'CN').length;
            const globalSeeds = readProductLineMarketSeedPrompts(
              line.seedPromptsJson,
              'GLOBAL',
            ).length;
            const cnComps = readProductLineMarketCompetitors(line.competitorsJson, 'CN').length;
            const globalComps = readProductLineMarketCompetitors(
              line.competitorsJson,
              'GLOBAL',
            ).length;
            const totalSeeds = cnSeeds + globalSeeds;
            const totalComps = cnComps + globalComps;

            const secondaryActions: RowActionItem[] = [
              {
                key: 'edit',
                label: '编辑',
                disabled: readOnly || deletingLineId === line.id,
                testId: `brand-pl-edit-${line.id}`,
                onClick: () => openEditModal(line),
              },
              {
                key: 'delete',
                label: '删除',
                danger: true,
                disabled: readOnly,
                loading: deletingLineId === line.id,
                testId: `brand-pl-delete-${line.id}`,
                confirm: {
                  title: `确认删除产品线「${line.name}」？`,
                  content:
                    '删除后，该产品线关联的历史事实卡、监测记录、写作意见与文章将保留为「品牌通用」，不会丢失数据。',
                  okText: '确认删除',
                  cancelText: '取消',
                  danger: true,
                },
                onClick: () => handleDeleteLine(line),
              },
            ];

            return (
              <div
                key={line.id}
                className="gm-brand-pl-row"
                data-testid={`brand-product-line-row-${line.id}`}
              >
                <div className="gm-brand-pl-main">
                  <div className="gm-brand-pl-head">
                    <strong className="gm-brand-pl-name">{line.name}</strong>
                    <Tag className="gm-brand-header-tag">{line.category}</Tag>
                    {line.localCategoriesJson?.CN ? (
                      <StatusBadge tone="neutral" label={`CN: ${line.localCategoriesJson.CN}`} />
                    ) : null}
                    {line.localCategoriesJson?.GLOBAL ? (
                      <StatusBadge
                        tone="neutral"
                        label={`GLOBAL: ${line.localCategoriesJson.GLOBAL}`}
                      />
                    ) : null}
                  </div>
                  <div className="gm-brand-pl-meta">
                    {line.localNamesJson?.CN || line.localNamesJson?.GLOBAL ? (
                      <span>
                        本地名：
                        {[
                          line.localNamesJson?.CN ? `CN ${line.localNamesJson.CN}` : null,
                          line.localNamesJson?.GLOBAL
                            ? `GLOBAL ${line.localNamesJson.GLOBAL}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    ) : null}
                    <span>问句：{totalSeeds > 0 ? `${totalSeeds} 条` : '继承'}</span>
                    <span>竞品：{totalComps > 0 ? `${totalComps} 个` : '继承'}</span>
                    {line.sortOrder !== 0 ? (
                      <span className="gm-num">排序：{line.sortOrder}</span>
                    ) : null}
                  </div>
                </div>

                <RowActions
                  revealOnHover={false}
                  secondary={secondaryActions}
                  data-testid={`brand-pl-actions-${line.id}`}
                />
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={modalOpen}
        title={editingLine ? '编辑产线' : '新增产线'}
        width={660}
        onCancel={closeModal}
        keyboard={!submitting}
        maskClosable={!submitting}
        destroyOnHidden
        footer={[
          <Button key="cancel" autoInsertSpace={false} disabled={submitting} onClick={closeModal}>
            取消
          </Button>,
          <Button
            key="submit"
            type="primary"
            autoInsertSpace={false}
            loading={submitting}
            disabled={readOnly}
            data-testid="brand-pl-submit-btn"
            onClick={() => void handleSubmit()}
          >
            {editingLine ? '保存' : '创建'}
          </Button>,
        ]}
      >
        <div className="gm-brand-pl-modal-body" data-testid="brand-pl-modal">
          {/* Primary required fields FIRST so label/placeholder queries always resolve unambiguously */}
          <div className="gm-brand-form-grid-2">
            <FormField label="名称" htmlFor="brand-pl-name" required>
              <Input
                id="brand-pl-name"
                aria-label="产品线名称"
                data-testid="brand-pl-name-input"
                maxLength={BRAND_NAME_MAX}
                value={name}
                disabled={readOnly || submitting}
                placeholder="例如：Power Station Series / 便携储能系列"
                onChange={(event) => {
                  setName(event.target.value);
                  if (modalError) setModalError(null);
                }}
              />
            </FormField>

            <FormField label="默认品类" htmlFor="brand-pl-category" required>
              <Input
                id="brand-pl-category"
                aria-label="默认品类"
                data-testid="brand-pl-category-input"
                maxLength={BRAND_CATEGORY_MAX}
                value={category}
                disabled={readOnly || submitting}
                placeholder="例如：Portable Power Station / 便携储能电源"
                onChange={(event) => {
                  setCategory(event.target.value);
                  if (modalError) setModalError(null);
                }}
              />
            </FormField>
          </div>

          <div className="gm-brand-form-grid-2">
            <FormField label="国内名" htmlFor="brand-pl-local-name-cn">
              <Input
                id="brand-pl-local-name-cn"
                aria-label="国内本地名"
                maxLength={BRAND_NAME_MAX}
                value={localNameCn}
                disabled={readOnly || submitting}
                placeholder="留空默认使用产品线名称"
                onChange={(event) => setLocalNameCn(event.target.value)}
              />
            </FormField>

            <FormField label="海外名" htmlFor="brand-pl-local-name-global">
              <Input
                id="brand-pl-local-name-global"
                aria-label="海外本地名"
                maxLength={BRAND_NAME_MAX}
                value={localNameGlobal}
                disabled={readOnly || submitting}
                placeholder="建议纯英文，例如：Power Station Series"
                onChange={(event) => setLocalNameGlobal(event.target.value)}
              />
            </FormField>
          </div>

          <div className="gm-brand-form-grid-2">
            <FormField label="国内品类" htmlFor="brand-pl-local-cat-cn">
              <Input
                id="brand-pl-local-cat-cn"
                aria-label="国内细分品类"
                maxLength={BRAND_CATEGORY_MAX}
                value={localCategoryCn}
                disabled={readOnly || submitting}
                placeholder="留空默认使用默认品类"
                onChange={(event) => setLocalCategoryCn(event.target.value)}
              />
            </FormField>

            <FormField label="海外品类" htmlFor="brand-pl-local-cat-global">
              <Input
                id="brand-pl-local-cat-global"
                aria-label="海外细分品类"
                maxLength={BRAND_CATEGORY_MAX}
                value={localCategoryGlobal}
                disabled={readOnly || submitting}
                placeholder="例如：Portable Power Station"
                onChange={(event) => setLocalCategoryGlobal(event.target.value)}
              />
            </FormField>
          </div>

          <div className="gm-brand-extra-doc">
            <div className="gm-brand-advanced-toggle-row">
              <button
                type="button"
                className="gm-brand-extra-doc-toggle"
                data-testid="brand-pl-advanced-toggle"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((prev) => !prev)}
              >
                <span>{advancedOpen ? '▾' : '▸'} 高级</span>
              </button>
              <Explain text="可调整产品线列表展示排序权重（0–1000，越小越靠前）。" />
            </div>
            {advancedOpen ? (
              <div className="gm-brand-extra-doc-body">
                <FormField
                  label="排序"
                  help="0–1000，越小越靠前"
                  htmlFor="brand-pl-sort-order"
                  className="gm-brand-pl-sort-field"
                >
                  <InputNumber
                    id="brand-pl-sort-order"
                    aria-label="排序权重"
                    min={0}
                    max={1000}
                    precision={0}
                    value={sortOrder}
                    disabled={readOnly || submitting}
                    className="gm-brand-w-full"
                    onChange={(val) =>
                      setSortOrder(
                        typeof val === 'number' && Number.isFinite(val) ? Math.trunc(val) : 0,
                      )
                    }
                  />
                </FormField>
              </div>
            ) : null}
          </div>

          <div className="gm-brand-pl-market-overrides">
            <div className="gm-brand-pl-overrides-head">
              <span className="gm-brand-pl-overrides-title">市场覆盖</span>
              <div className="gm-brand-mode-tabs" role="tablist" aria-label="覆盖配置市场切换">
                {(['CN', 'GLOBAL'] as const).map((mkt) => (
                  <button
                    key={mkt}
                    type="button"
                    role="tab"
                    aria-selected={overrideMarket === mkt}
                    className={
                      overrideMarket === mkt ? 'gm-brand-mode-btn is-active' : 'gm-brand-mode-btn'
                    }
                    onClick={() => setOverrideMarket(mkt)}
                  >
                    {GEO_MARKET_SHORT[mkt]}
                  </button>
                ))}
              </div>
            </div>

            <FormField
              label="监控问句"
              help={`每行一条，最多 ${PRODUCT_LINE_MAX_SEED_PROMPTS} 条，留空继承品牌配置`}
              htmlFor="brand-pl-seed-prompts"
            >
              <Input.TextArea
                id="brand-pl-seed-prompts"
                aria-label={`${GEO_MARKET_LABELS[overrideMarket]}监控问句`}
                rows={3}
                value={seedPromptsTextByMarket[overrideMarket]}
                disabled={readOnly || submitting}
                placeholder={
                  overrideMarket === 'CN'
                    ? '每行输入一条国内监控问句...'
                    : 'Enter one GLOBAL monitoring prompt per line...'
                }
                onChange={(event) => {
                  const nextText = event.target.value;
                  setSeedPromptsTextByMarket((prev) => ({
                    ...prev,
                    [overrideMarket]: nextText,
                  }));
                }}
              />
            </FormField>

            <FormField
              label={`竞品 ${activeMarketCompetitors.length}/${BRAND_MAX_COMPETITORS}`}
              help="留空继承品牌市场竞品配置"
            >
              <div className="gm-brand-competitor-list">
                {activeMarketCompetitors.map((row, idx) => (
                  <div key={row.key} className="gm-brand-pl-comp-row">
                    <Input
                      aria-label={`产品线竞品名称 ${idx + 1}`}
                      value={row.name}
                      maxLength={BRAND_NAME_MAX}
                      disabled={readOnly || submitting}
                      placeholder="竞品名"
                      onChange={(event) =>
                        setCompetitorsByMarket((prev) => ({
                          ...prev,
                          [overrideMarket]: prev[overrideMarket].map((item) =>
                            item.key === row.key ? { ...item, name: event.target.value } : item,
                          ),
                        }))
                      }
                    />
                    <Input
                      aria-label={`产品线竞品别名 ${idx + 1}`}
                      value={row.aliasesText ?? ''}
                      disabled={readOnly || submitting}
                      placeholder="别名（逗号分隔）"
                      onChange={(event) =>
                        setCompetitorsByMarket((prev) => ({
                          ...prev,
                          [overrideMarket]: prev[overrideMarket].map((item) =>
                            item.key === row.key
                              ? { ...item, aliasesText: event.target.value }
                              : item,
                          ),
                        }))
                      }
                    />
                    <Input
                      aria-label={`产品线竞品域名 ${idx + 1}`}
                      value={row.domainsText}
                      disabled={readOnly || submitting}
                      placeholder="域名（逗号分隔）"
                      onChange={(event) =>
                        setCompetitorsByMarket((prev) => ({
                          ...prev,
                          [overrideMarket]: prev[overrideMarket].map((item) =>
                            item.key === row.key
                              ? { ...item, domainsText: event.target.value }
                              : item,
                          ),
                        }))
                      }
                    />
                    <Button
                      size="small"
                      disabled={readOnly || submitting}
                      aria-label={`移除产品线竞品 ${idx + 1}`}
                      onClick={() =>
                        setCompetitorsByMarket((prev) => ({
                          ...prev,
                          [overrideMarket]: prev[overrideMarket].filter(
                            (item) => item.key !== row.key,
                          ),
                        }))
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
                    readOnly ||
                    submitting ||
                    activeMarketCompetitors.length >= BRAND_MAX_COMPETITORS
                  }
                  onClick={() =>
                    setCompetitorsByMarket((prev) => ({
                      ...prev,
                      [overrideMarket]:
                        prev[overrideMarket].length >= BRAND_MAX_COMPETITORS
                          ? prev[overrideMarket]
                          : [...prev[overrideMarket], createBlankCompetitor()],
                    }))
                  }
                >
                  添加竞品
                </Button>
              </div>
            </FormField>
          </div>

          {modalError ? (
            <Alert
              type="error"
              showIcon
              data-testid="brand-pl-modal-error"
              message={modalError}
              className="gm-brand-inline-alert"
            />
          ) : null}
        </div>
      </Modal>
    </Section>
  );
}
