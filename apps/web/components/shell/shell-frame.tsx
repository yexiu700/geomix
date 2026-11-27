'use client';

import {
  GEO_MARKET_DEFAULTS,
  GLOBAL_CJK_IDENTITY_OVERRIDE_LABEL,
  containsCjk,
  normalizeBrandDomain,
  validateGlobalMarketIdentity,
  type BrandCompetitor,
  type BrandFactsResponse,
  type BrandMarketAiSuggestInput,
  type BrandMarketAiSuggestResponse,
  type BrandRecord,
  type CreateBrandInput,
  type ExtractBrandFactsResponse,
  type GeoMarket,
  type UpdateBrandMarketInput,
  type UpsertBrandFactsInput,
  type UpsertBrandMarketInput,
} from '@geomix/shared';
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Form,
  Input,
  Layout,
  Modal,
  Select,
  Skeleton,
  Tooltip,
} from 'antd';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import type { WalletSummary } from '../../lib/account-client';
import type { AccountProfile } from '../../lib/api';
import type { ExtractBrandFactsRequest } from '../../lib/brands';
import { matchRoute } from '../../lib/routes';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { BrandQuickCreateModal } from '../brands/brand-quick-create-modal';
import { useUxFeedback } from '../crud/ux-feedback';
import { Explain } from '../ui';
import { SideMenu } from './side-menu';

const PasswordForm = dynamic(() => import('../password-form').then((m) => m.PasswordForm));
const CommandPalette = dynamic(() => import('./command-palette').then((m) => m.CommandPalette));

const { Header, Sider, Content } = Layout;
const MOBILE_BREAKPOINT = 768;

type EnableMarketFormValues = {
  localBrandName: string;
  localCategory?: string;
  ownedDomainsText?: string;
  competitorsText?: string;
};

type WorkspaceContainerVariant = 'wide' | 'form' | 'studio';

function resolveContainerVariant(routePath: string | undefined): WorkspaceContainerVariant {
  if (routePath === '/studio' || routePath === '/publish') return 'studio';
  if (routePath === '/brands' || routePath === '/account') return 'form';
  return 'wide';
}

function parseDomainLines(raw: string | undefined): string[] {
  if (!raw) return [];
  const items = raw
    .split(/[\n,，;；]+/)
    .map((part) => normalizeBrandDomain(part))
    .filter(Boolean);
  return Array.from(new Set(items));
}

function parseCompetitorLines(raw: string | undefined): BrandCompetitor[] {
  if (!raw) return [];
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const results: BrandCompetitor[] = [];
  for (const line of lines.slice(0, 10)) {
    const parts = line
      .split(/[,，]/)
      .map((part) => part.trim())
      .filter(Boolean);
    const name = parts[0];
    if (!name) continue;
    const domains = parts
      .slice(1)
      .map((domain) => normalizeBrandDomain(domain))
      .filter(Boolean);
    results.push({ name, aliases: [], domains: Array.from(new Set(domains)) });
  }
  return results;
}

export type ShellFrameProps = {
  account: AccountProfile;
  activePath: string;
  brands: readonly BrandRecord[];
  brandsLoading: boolean;
  brandsLoaded: boolean;
  brandsError: string | null;
  activeBrandId: string | null;
  activeMarket: GeoMarket;
  menuCollapsed: boolean;
  wallet: WalletSummary | null;
  walletLoading: boolean;
  announcement?: string | null;
  createBrandModalOpen?: boolean;
  enableMarketModalTarget?: GeoMarket | null;
  onOpenCreateBrandModal?: () => void;
  onCloseCreateBrandModal?: () => void;
  onOpenEnableMarketModal?: (market: GeoMarket) => void;
  onCloseEnableMarketModal?: () => void;
  onNavigate: (href: string) => void;
  onSelectBrand: (brandId: string) => void;
  onSelectMarket: (market: GeoMarket) => void;
  onRetryBrands?: () => void;
  onCreateBrand: (input: CreateBrandInput) => Promise<BrandRecord>;
  onExtractBrandFacts?: (
    brandId: string,
    input: ExtractBrandFactsRequest,
  ) => Promise<ExtractBrandFactsResponse>;
  onSaveBrandFacts?: (brandId: string, input: UpsertBrandFactsInput) => Promise<BrandFactsResponse>;
  onBrandFactsSaved?: (brandId: string, signedAt: string | null) => void;
  onSuggestBrandMarketConfig?: (
    brandId: string,
    market: GeoMarket,
    input?: BrandMarketAiSuggestInput,
    options?: { signal?: AbortSignal },
  ) => Promise<BrandMarketAiSuggestResponse>;
  onSaveBrandMarketConfig?: (
    brandId: string,
    market: GeoMarket,
    input: UpdateBrandMarketInput,
  ) => Promise<BrandRecord>;
  onEnableMarket: (
    brandId: string,
    market: GeoMarket,
    input: UpsertBrandMarketInput,
  ) => Promise<BrandRecord>;
  onToggleMenu: () => void;
  onLogout: () => void;
  onChangePassword: (values: {
    currentPassword: string;
    newPassword: string;
  }) => Promise<string | null>;
  children?: ReactNode;
};

export function ShellFrame({
  account,
  activePath,
  brands,
  brandsLoading,
  brandsLoaded,
  brandsError,
  activeBrandId,
  activeMarket,
  menuCollapsed,
  wallet,
  walletLoading,
  announcement = null,
  createBrandModalOpen,
  enableMarketModalTarget,
  onOpenCreateBrandModal,
  onCloseCreateBrandModal,
  onOpenEnableMarketModal,
  onCloseEnableMarketModal,
  onNavigate,
  onSelectBrand,
  onSelectMarket,
  onRetryBrands,
  onCreateBrand,
  onExtractBrandFacts,
  onSaveBrandFacts,
  onBrandFactsSaved,
  onSuggestBrandMarketConfig,
  onSaveBrandMarketConfig,
  onEnableMarket,
  onToggleMenu,
  onLogout,
  onChangePassword,
  children,
}: ShellFrameProps) {
  const feedback = useUxFeedback();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  const [internalCreateOpen, setInternalCreateOpen] = useState(false);
  const [internalEnableMarket, setInternalEnableMarket] = useState<GeoMarket | null>(null);
  const [enableSubmitting, setEnableSubmitting] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [enableAllowCjkGlobal, setEnableAllowCjkGlobal] = useState(false);
  const [isWindows, setIsWindows] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT,
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [studioRailExpanded, setStudioRailExpanded] = useState(false);
  const [enableForm] = Form.useForm<EnableMarketFormValues>();
  const watchedEnableLocalName = Form.useWatch('localBrandName', enableForm);
  const watchedEnableLocalCategory = Form.useWatch('localCategory', enableForm);

  const isCreateOpen = createBrandModalOpen ?? internalCreateOpen;
  const enableTarget =
    enableMarketModalTarget !== undefined ? enableMarketModalTarget : internalEnableMarket;

  const matchedRoute = matchRoute(activePath);
  const isSplitWorkspaceRoute =
    matchedRoute?.path === '/studio' || matchedRoute?.path === '/publish';
  const containerVariant = resolveContainerVariant(matchedRoute?.path);

  useEffect(() => {
    setStudioRailExpanded(false);
  }, [matchedRoute?.path, isSplitWorkspaceRoute]);

  const openCreateModal = () => {
    if (onOpenCreateBrandModal) {
      onOpenCreateBrandModal();
    } else {
      setInternalCreateOpen(true);
    }
  };

  const closeCreateModal = () => {
    if (onCloseCreateBrandModal) {
      onCloseCreateBrandModal();
    } else {
      setInternalCreateOpen(false);
    }
  };

  const openEnableModal = (market: GeoMarket) => {
    setEnableError(null);
    if (onOpenEnableMarketModal) {
      onOpenEnableMarketModal(market);
    } else {
      setInternalEnableMarket(market);
    }
  };

  const closeEnableModal = () => {
    if (enableSubmitting) return;
    setEnableError(null);
    if (onCloseEnableMarketModal) {
      onCloseEnableMarketModal();
    } else {
      setInternalEnableMarket(null);
    }
  };

  useEffect(() => {
    if (typeof navigator !== 'undefined' && /win/i.test(navigator.platform)) {
      setIsWindows(true);
    }
  }, []);

  useEffect(() => {
    const syncViewport = () => {
      const mobile = window.innerWidth <= MOBILE_BREAKPOINT;
      setIsMobile(mobile);
      if (!mobile) {
        setMobileMenuOpen(false);
      }
    };
    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k' &&
        !event.isComposing
      ) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!passwordOpen) return undefined;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        setPasswordOpen(false);
      }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [passwordOpen]);

  const activeBrand = brands.find((item) => item.id === activeBrandId) ?? null;
  const hasCN = Boolean(activeBrand?.markets.some((item) => item.market === 'CN'));
  const hasGlobal = Boolean(activeBrand?.markets.some((item) => item.market === 'GLOBAL'));
  const hasBothMarkets = hasCN && hasGlobal;
  const missingMarket: GeoMarket | null =
    activeBrand && !hasBothMarkets ? (hasCN ? 'GLOBAL' : 'CN') : null;

  useEffect(() => {
    if (!enableTarget || !activeBrand) return;
    setEnableAllowCjkGlobal(false);
    setEnableError(null);
    enableForm.setFieldsValue({
      localBrandName: activeBrand.name,
      localCategory: '',
      ownedDomainsText: '',
      competitorsText: '',
    });
  }, [activeBrand, enableForm, enableTarget]);

  const visibilityEnabled = account.features?.visibility !== false;
  const desktopRailCollapsed = isSplitWorkspaceRoute ? !studioRailExpanded : menuCollapsed;
  const siderCollapsed = isMobile ? !mobileMenuOpen : desktopRailCollapsed;
  const railMode = !isMobile && desktopRailCollapsed;
  const mobileClosed = isMobile && !mobileMenuOpen;
  const siderClassName = mobileClosed
    ? 'gm-sider gm-sider-collapsed'
    : railMode
      ? 'gm-sider gm-sider-rail'
      : 'gm-sider';
  const trimmedAnnouncement = announcement?.trim() || '';

  const toggleMenu = () => {
    if (isMobile) {
      setMobileMenuOpen((open) => !open);
      return;
    }
    if (isSplitWorkspaceRoute) {
      setStudioRailExpanded((expanded) => !expanded);
      return;
    }
    onToggleMenu();
  };

  const handleNavigate = (href: string) => {
    if (isMobile) {
      setMobileMenuOpen(false);
    }
    onNavigate(href);
  };

  const handleEnableSubmit = async (values: EnableMarketFormValues) => {
    if (!activeBrand || !enableTarget) return;
    const trimmedLocalName = values.localBrandName.trim() || activeBrand.name;
    const trimmedLocalCategory = values.localCategory?.trim();
    const globalCheck = validateGlobalMarketIdentity({
      market: enableTarget,
      localBrandName: trimmedLocalName,
      localCategory: trimmedLocalCategory ?? null,
      allowCjkGlobalIdentity: enableAllowCjkGlobal,
    });
    if (!globalCheck.ok) {
      setEnableError(globalCheck.message);
      return;
    }

    setEnableSubmitting(true);
    setEnableError(null);
    try {
      const payload: UpsertBrandMarketInput = {
        localBrandName: trimmedLocalName,
        ...(trimmedLocalCategory ? { localCategory: trimmedLocalCategory } : {}),
        ...(enableTarget === 'GLOBAL' && enableAllowCjkGlobal
          ? { allowCjkGlobalIdentity: true }
          : {}),
        ownedDomains: parseDomainLines(values.ownedDomainsText),
        competitors: parseCompetitorLines(values.competitorsText),
      };
      await onEnableMarket(activeBrand.id, enableTarget, payload);
      feedback.notifySuccess(
        enableTarget === 'GLOBAL' ? '已开启海外市场（GLOBAL）' : '已开启国内市场（CN）',
      );
      if (onCloseEnableMarketModal) {
        onCloseEnableMarketModal();
      } else {
        setInternalEnableMarket(null);
      }
    } catch (reason: unknown) {
      setEnableError(reason instanceof Error && reason.message ? reason.message : '开启市场失败');
    } finally {
      setEnableSubmitting(false);
    }
  };

  const enableDefaults = enableTarget ? GEO_MARKET_DEFAULTS[enableTarget] : null;
  const effectiveEnableLocalName =
    watchedEnableLocalName?.trim() || activeBrand?.name?.trim() || '';
  const hasEnableGlobalCjk =
    enableTarget === 'GLOBAL' &&
    (containsCjk(effectiveEnableLocalName) ||
      containsCjk(watchedEnableLocalCategory?.trim() || ''));

  useEffect(() => {
    if (!hasEnableGlobalCjk) {
      setEnableAllowCjkGlobal(false);
    }
  }, [hasEnableGlobalCjk]);

  return (
    <Layout className="gm-shell-layout">
      {isMobile && mobileMenuOpen ? (
        <div
          className="gm-sider-mask"
          aria-hidden="true"
          onClick={() => setMobileMenuOpen(false)}
        />
      ) : null}
      <Sider
        id="gm-sider-nav"
        className={siderClassName}
        width={220}
        collapsed={siderCollapsed}
        collapsedWidth={isMobile ? 0 : 72}
        trigger={null}
        theme="dark"
      >
        <SideMenu
          activePath={activePath}
          collapsed={railMode}
          mobileClosed={mobileClosed}
          showCollapseToggle={!isMobile}
          onToggleCollapse={toggleMenu}
          account={account}
          visibilityEnabled={visibilityEnabled}
          onNavigate={handleNavigate}
          onChangePassword={() => setPasswordOpen(true)}
          onLogout={onLogout}
        />
      </Sider>
      <Layout className="gm-shell-body">
        <Header className="gm-header">
          <div className="gm-header-left">
            {isMobile ? (
              <button
                type="button"
                className="gm-mobile-menu-btn"
                aria-label={mobileMenuOpen ? '关闭菜单' : '打开菜单'}
                aria-expanded={mobileMenuOpen}
                aria-controls="gm-sider-nav"
                onClick={toggleMenu}
              >
                <MobileMenuIcon />
              </button>
            ) : null}

            {brandsLoading ? (
              <span
                className="gm-header-switcher-skeleton"
                data-testid="global-brand-switcher-loading"
                aria-busy="true"
              >
                <Skeleton.Input active size="small" className="gm-skel-brand" />
              </span>
            ) : brandsError && brands.length === 0 ? (
              <Button
                size="small"
                danger
                className="gm-shell-noshrink"
                data-testid="global-brand-switcher-retry"
                onClick={() => {
                  if (onRetryBrands) {
                    onRetryBrands();
                  } else {
                    void useWorkspaceStore.getState().loadBrands({
                      storage: window.sessionStorage,
                      persistStorage: window.localStorage,
                    });
                  }
                }}
              >
                重试
              </Button>
            ) : brands.length === 0 ? (
              <Button
                type="default"
                size="small"
                className="gm-shell-noshrink gm-brand-create-btn"
                data-testid="global-brand-switcher"
                disabled={account.tenant.readOnly}
                onClick={openCreateModal}
              >
                建品牌
              </Button>
            ) : (
              <Select<string>
                variant="borderless"
                data-testid="global-brand-switcher"
                aria-label="切换当前品牌"
                size="small"
                value={activeBrand?.id}
                virtual={false}
                onChange={onSelectBrand}
                className="gm-brand-select"
                popupMatchSelectWidth={240}
                options={brands.map((brand) => {
                  const marketEntry = brand.markets.find((m) => m.market === activeMarket);
                  return {
                    value: brand.id,
                    label: marketEntry?.localBrandName?.trim() || brand.name,
                  };
                })}
                popupRender={(menu) => (
                  <div>
                    {menu}
                    <Divider className="gm-brand-popup-divider" />
                    <div className="gm-brand-popup-footer">
                      <Button
                        type="text"
                        size="small"
                        block
                        disabled={account.tenant.readOnly}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={openCreateModal}
                      >
                        + 新建品牌
                      </Button>
                    </div>
                  </div>
                )}
              />
            )}

            {brandsLoading ? (
              <span className="gm-header-switcher-skeleton" aria-busy="true">
                <Skeleton.Button active size="small" className="gm-skel-market" />
              </span>
            ) : activeBrand ? (
              <div
                className="gm-market-toggle"
                role="group"
                aria-label="切换目标市场"
                data-testid="global-market-switcher"
              >
                {hasBothMarkets ? (
                  <>
                    <button
                      type="button"
                      className={activeMarket === 'CN' ? 'gm-market-btn active' : 'gm-market-btn'}
                      aria-pressed={activeMarket === 'CN'}
                      onClick={() => onSelectMarket('CN')}
                    >
                      国内
                    </button>
                    <button
                      type="button"
                      className={
                        activeMarket === 'GLOBAL' ? 'gm-market-btn active' : 'gm-market-btn'
                      }
                      aria-pressed={activeMarket === 'GLOBAL'}
                      onClick={() => onSelectMarket('GLOBAL')}
                    >
                      海外
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="gm-market-btn active"
                      aria-pressed="true"
                      onClick={() => onSelectMarket(activeMarket)}
                    >
                      {activeMarket === 'CN' ? '国内' : '海外'}
                    </button>
                    {missingMarket ? (
                      <button
                        type="button"
                        className="gm-market-enable-btn"
                        data-testid="enable-other-market-btn"
                        disabled={account.tenant.readOnly}
                        onClick={() => openEnableModal(missingMarket)}
                      >
                        加市场
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </div>

          <div className="gm-header-right">
            <Tooltip title={isWindows ? '搜索 (Ctrl+K)' : '搜索 (⌘K)'}>
              <button
                type="button"
                className="gm-cmd-trigger gm-cmd-trigger--icon"
                aria-label="打开指令面板"
                onClick={() => setPaletteOpen(true)}
              >
                <SearchIcon />
              </button>
            </Tooltip>

            {trimmedAnnouncement ? (
              <Tooltip title={trimmedAnnouncement}>
                <button
                  type="button"
                  className="gm-announce-bell"
                  data-testid="header-announcement-bell"
                  aria-label="查看系统公告"
                  onClick={() => setAnnouncementOpen(true)}
                >
                  <BellIcon />
                  <span className="gm-announce-bell-dot" aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}

            {walletLoading || wallet === null ? (
              <span
                className="gm-points-skeleton"
                data-testid="header-points-loading"
                aria-busy="true"
              >
                <Skeleton.Button active size="small" className="gm-skel-points" />
              </span>
            ) : (
              <Link
                href="/account"
                className="gm-points-pill"
                data-testid="header-points-pill"
                aria-label={`可用点数 ${wallet.available} 点`}
              >
                <span className="gm-num">{wallet.available}</span>
                <span>点</span>
              </Link>
            )}
          </div>
        </Header>

        <Content className={isSplitWorkspaceRoute ? 'gm-content gm-content--studio' : 'gm-content'}>
          <div className={`gm-workspace-main gm-workspace-main--${containerVariant}`}>
            {account.tenant.readOnly ? (
              <Alert
                type="warning"
                showIcon
                message="账号已到期"
                className="gm-shell-readonly-alert"
              />
            ) : null}
            {!brandsLoading &&
            brandsLoaded &&
            brands.length === 0 &&
            !brandsError &&
            isSplitWorkspaceRoute ? (
              <section className="gm-onboarding-banner" aria-label="首次建档引导">
                <div className="gm-onboarding-banner-copy gm-ui-section-title-row">
                  <strong>先建品牌</strong>
                  <Explain text="填写品牌名、品类与目标市场后，全站看板、监测与写作台自动锁定该品牌上下文。" />
                </div>
                <Button type="primary" disabled={account.tenant.readOnly} onClick={openCreateModal}>
                  建品牌
                </Button>
              </section>
            ) : null}
            {children}
          </div>
        </Content>
      </Layout>

      <BrandQuickCreateModal
        open={isCreateOpen}
        readOnly={account.tenant.readOnly}
        onClose={closeCreateModal}
        onCreateBrand={onCreateBrand}
        onExtractFacts={onExtractBrandFacts}
        onSaveFacts={onSaveBrandFacts}
        onBrandFactsSaved={onBrandFactsSaved}
        onSuggestMarketConfig={onSuggestBrandMarketConfig}
        onSaveMarketConfig={onSaveBrandMarketConfig}
      />

      <Modal
        open={enableTarget !== null}
        title={enableTarget === 'GLOBAL' ? '开启海外' : '开启国内'}
        onCancel={closeEnableModal}
        keyboard
        maskClosable
        destroyOnHidden
        okText="开启"
        cancelText="取消"
        confirmLoading={enableSubmitting}
        onOk={() => enableForm.submit()}
      >
        {enableDefaults ? (
          <div className="gm-modal-hint gm-ui-section-title-row">
            <span>
              默认 {enableDefaults.locale} / {enableDefaults.region}
            </span>
            <Explain text="开启后将与现有市场共享核心品牌事实卡，但引擎组、可见度看板与成稿严格隔离。" />
          </div>
        ) : null}
        <Form<EnableMarketFormValues>
          form={enableForm}
          layout="vertical"
          onFinish={(values) => void handleEnableSubmit(values)}
        >
          <Form.Item
            label="品牌名"
            name="localBrandName"
            rules={[
              { required: true, whitespace: true, message: '请填写当地品牌名称' },
              { max: 80, message: '品牌名称不超过 80 字' },
            ]}
          >
            <Input
              aria-label="当地品牌名称"
              placeholder={
                enableTarget === 'GLOBAL'
                  ? '例如：UGREEN（海外英文品牌名）'
                  : '例如：绿联（国内中文品牌名）'
              }
            />
          </Form.Item>
          <Form.Item
            label="品类"
            name="localCategory"
            rules={[{ max: 80, message: '品类名称不超过 80 字' }]}
          >
            <Input
              aria-label="当地品类名称"
              placeholder={
                enableTarget === 'GLOBAL'
                  ? '例如：USB-C GaN Fast Charger / Outdoor Power Station'
                  : '例如：氮化镓快充 / 户外电源'
              }
            />
          </Form.Item>
          <Form.Item label="官网域名" name="ownedDomainsText">
            <Input
              aria-label="当地官网域名"
              placeholder="例如：global.example.com（多个域名可用逗号分隔）"
            />
          </Form.Item>
          <Form.Item label="竞品列表" name="competitorsText">
            <Input.TextArea
              aria-label="当地主要竞品"
              rows={3}
              placeholder="每行一个竞品，格式：竞品名, 竞品域名（域名选填）"
            />
          </Form.Item>
          {hasEnableGlobalCjk ? (
            <div className="gm-brand-global-cjk-guard gm-modal-alert">
              <Checkbox
                data-testid="enable-market-allow-cjk-global-checkbox"
                checked={enableAllowCjkGlobal}
                disabled={enableSubmitting}
                onChange={(event) => {
                  setEnableAllowCjkGlobal(event.target.checked);
                  if (event.target.checked && enableError) setEnableError(null);
                }}
              >
                {GLOBAL_CJK_IDENTITY_OVERRIDE_LABEL}（确认保留中文用于海外市场）
              </Checkbox>
            </div>
          ) : null}
          {enableError ? (
            <Alert type="error" showIcon message={enableError} className="gm-modal-alert" />
          ) : null}
        </Form>
      </Modal>

      <Modal
        open={announcementOpen}
        title="系统公告"
        onCancel={() => setAnnouncementOpen(false)}
        keyboard
        maskClosable
        footer={[
          <Button key="close" type="primary" onClick={() => setAnnouncementOpen(false)}>
            知道了
          </Button>,
        ]}
      >
        <p className="gm-announce-modal-body">{trimmedAnnouncement || '当前暂无系统公告'}</p>
      </Modal>

      {paletteOpen ? (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          role={account.role}
          readOnly={account.tenant.readOnly}
          visibilityEnabled={visibilityEnabled}
          brands={brands}
          activeBrandId={activeBrandId}
          activeMarket={activeMarket}
          onNavigate={handleNavigate}
          onSelectBrand={onSelectBrand}
          onSelectMarket={onSelectMarket}
          onOpenCreateBrand={openCreateModal}
          onOpenEnableMarket={openEnableModal}
          onToggleMenu={toggleMenu}
          onChangePassword={() => setPasswordOpen(true)}
          onLogout={onLogout}
        />
      ) : null}

      <Modal
        open={passwordOpen}
        title="修改密码"
        onCancel={() => setPasswordOpen(false)}
        keyboard
        maskClosable
        destroyOnHidden
        footer={null}
      >
        {passwordOpen ? (
          <PasswordForm onSubmit={onChangePassword} onCancel={() => setPasswordOpen(false)} />
        ) : null}
      </Modal>
    </Layout>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.6 10.6L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2.2C5.9 2.2 4.4 3.8 4.4 6V8.9L3.2 10.8C3 11.1 3.2 11.5 3.6 11.5H12.4C12.8 11.5 13 11.1 12.8 10.8L11.6 8.9V6C11.6 3.8 10.1 2.2 8 2.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M6.6 12.8C6.9 13.4 7.4 13.8 8 13.8C8.6 13.8 9.1 13.4 9.4 12.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MobileMenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.2H13.5M2.5 8H13.5M2.5 11.8H13.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
