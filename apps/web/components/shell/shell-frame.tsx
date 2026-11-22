'use client';

import {
  GEO_MARKET_DEFAULTS,
  SITE_NAME,
  normalizeBrandDomain,
  type BrandCompetitor,
  type BrandFactsResponse,
  type BrandRecord,
  type CreateBrandInput,
  type ExtractBrandFactsResponse,
  type GeoMarket,
  type UpsertBrandFactsInput,
  type UpsertBrandMarketInput,
} from '@geomix/shared';
import {
  Alert,
  Button,
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
import { HOME_ROUTE, matchRoute } from '../../lib/routes';
import { useWorkspaceStore } from '../../lib/workspace-store';
import { BrandQuickCreateModal } from '../brands/brand-quick-create-modal';
import { useUxFeedback } from '../crud/ux-feedback';
import { BrandMark, SideMenu } from './side-menu';

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
  const [isWindows, setIsWindows] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT,
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [enableForm] = Form.useForm<EnableMarketFormValues>();

  const isCreateOpen = createBrandModalOpen ?? internalCreateOpen;
  const enableTarget =
    enableMarketModalTarget !== undefined ? enableMarketModalTarget : internalEnableMarket;

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
    enableForm.setFieldsValue({
      localBrandName: activeBrand.name,
      localCategory: '',
      ownedDomainsText: '',
      competitorsText: '',
    });
  }, [activeBrand, enableForm, enableTarget]);

  const visibilityEnabled = account.features?.visibility !== false;
  const siderCollapsed = isMobile ? !mobileMenuOpen : menuCollapsed;
  const menuToggleLabel = siderCollapsed ? '展开菜单' : '收起菜单';
  const matchedRoute = matchRoute(activePath);
  const currentTitle = matchedRoute?.title ?? '行动首页';
  const isAccountPath = matchedRoute?.path === '/account';
  const trimmedAnnouncement = announcement?.trim() || '';

  const toggleMenu = () => {
    if (isMobile) {
      setMobileMenuOpen((open) => !open);
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
    setEnableSubmitting(true);
    setEnableError(null);
    try {
      const trimmedLocalCategory = values.localCategory?.trim();
      const payload: UpsertBrandMarketInput = {
        localBrandName: values.localBrandName.trim() || activeBrand.name,
        ...(trimmedLocalCategory ? { localCategory: trimmedLocalCategory } : {}),
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

  return (
    <Layout style={{ minHeight: '100vh', overflowX: 'clip' }}>
      {isMobile && mobileMenuOpen ? (
        <div
          className="gm-sider-mask"
          aria-hidden="true"
          onClick={() => setMobileMenuOpen(false)}
        />
      ) : null}
      <Sider
        id="gm-sider-nav"
        className={siderCollapsed ? 'gm-sider gm-sider-collapsed' : 'gm-sider'}
        width={220}
        collapsed={siderCollapsed}
        collapsedWidth={0}
        trigger={null}
        theme="dark"
        style={{
          background: 'var(--gm-bg-base)',
          borderRight: siderCollapsed ? 'none' : '1px solid var(--gm-line-1)',
          overflow: 'hidden',
        }}
      >
        <SideMenu
          activePath={activePath}
          collapsed={siderCollapsed}
          account={account}
          visibilityEnabled={visibilityEnabled}
          onNavigate={handleNavigate}
          onChangePassword={() => setPasswordOpen(true)}
          onLogout={onLogout}
        />
      </Sider>
      <Layout style={{ minWidth: 0, overflow: 'hidden' }}>
        <Header className="gm-header">
          <div className="gm-header-left">
            {siderCollapsed ? (
              <button
                type="button"
                className="gm-header-brand"
                aria-label={`返回${SITE_NAME}行动首页`}
                onClick={() => handleNavigate(HOME_ROUTE)}
              >
                <BrandMark />
                <span>{SITE_NAME}</span>
              </button>
            ) : null}

            {brandsLoading ? (
              <span
                className="gm-header-switcher-skeleton"
                data-testid="global-brand-switcher-loading"
                aria-busy="true"
              >
                <Skeleton.Input active size="small" style={{ width: 148, height: 28 }} />
              </span>
            ) : brandsError && brands.length === 0 ? (
              <Button
                size="small"
                danger
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
                style={{ flexShrink: 0 }}
              >
                重新加载品牌
              </Button>
            ) : brands.length === 0 ? (
              <Button
                type="primary"
                size="small"
                data-testid="global-brand-switcher"
                disabled={account.tenant.readOnly}
                onClick={openCreateModal}
                style={{ flexShrink: 0 }}
              >
                + 创建首个品牌
              </Button>
            ) : (
              <Select<string>
                data-testid="global-brand-switcher"
                aria-label="切换当前品牌"
                size="small"
                value={activeBrand?.id}
                virtual={false}
                onChange={onSelectBrand}
                className="gm-brand-select"
                popupMatchSelectWidth={240}
                options={brands.map((brand) => ({
                  value: brand.id,
                  label: brand.name,
                }))}
                popupRender={(menu) => (
                  <div>
                    {menu}
                    <Divider style={{ margin: '6px 0' }} />
                    <div style={{ padding: '0 6px 6px' }}>
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
              <span aria-busy="true" style={{ display: 'inline-flex', alignItems: 'center' }}>
                <Skeleton.Button active size="small" style={{ width: 112, height: 28 }} />
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
                      🇨🇳 国内
                    </button>
                    <button
                      type="button"
                      className={
                        activeMarket === 'GLOBAL' ? 'gm-market-btn active' : 'gm-market-btn'
                      }
                      aria-pressed={activeMarket === 'GLOBAL'}
                      onClick={() => onSelectMarket('GLOBAL')}
                    >
                      🌐 海外
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
                      {activeMarket === 'CN' ? '🇨🇳 国内' : '🌐 海外'}
                    </button>
                    {missingMarket ? (
                      <button
                        type="button"
                        className="gm-market-enable-btn"
                        data-testid="enable-other-market-btn"
                        disabled={account.tenant.readOnly}
                        onClick={() => openEnableModal(missingMarket)}
                      >
                        + 开启另一市场
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            <nav aria-label="面包屑" className="gm-breadcrumb">
              <span className="gm-breadcrumb-sep" aria-hidden="true">
                /
              </span>
              <span className="gm-breadcrumb-current">{currentTitle}</span>
            </nav>
          </div>

          <div className="gm-header-right">
            {trimmedAnnouncement ? (
              <Tooltip title={trimmedAnnouncement}>
                <button
                  type="button"
                  className="gm-announce-btn"
                  aria-label="查看公告全文"
                  onClick={() => setAnnouncementOpen(true)}
                >
                  {trimmedAnnouncement}
                </button>
              </Tooltip>
            ) : null}

            <button
              type="button"
              className="gm-cmd-trigger"
              aria-label="打开指令面板"
              onClick={() => setPaletteOpen(true)}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <SearchIcon />
                <span className="gm-cmd-trigger-text">搜索</span>
              </span>
              <kbd className="gm-cmd-trigger-kbd">{isWindows ? 'Ctrl K' : '⌘K'}</kbd>
            </button>

            {account.role === 'ADMIN' ? (
              <Link className="gm-admin-link" href="/admin/tenants">
                运营后台
              </Link>
            ) : null}

            {walletLoading || wallet === null ? (
              <span
                className="gm-points-skeleton"
                data-testid="header-points-loading"
                aria-busy="true"
              >
                <Skeleton.Button active size="small" style={{ width: 72, height: 26 }} />
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

            <Button
              size="small"
              aria-label={menuToggleLabel}
              aria-expanded={!siderCollapsed}
              aria-controls="gm-sider-nav"
              onClick={toggleMenu}
              style={{ flexShrink: 0 }}
            >
              {menuToggleLabel}
            </Button>
          </div>
        </Header>

        <Content className="gm-content" style={{ padding: isMobile ? 12 : 20 }}>
          {account.tenant.readOnly ? (
            <Alert
              type="warning"
              showIcon
              message="账号已到期，当前只读"
              style={{ marginBottom: 12 }}
            />
          ) : null}
          {!brandsLoading &&
          brandsLoaded &&
          brands.length === 0 &&
          !brandsError &&
          !isAccountPath ? (
            <section className="gm-onboarding-banner" aria-label="首次建档引导">
              <div className="gm-onboarding-banner-copy">
                <strong>60 秒创建首个品牌，开启双市场 AI 可见度与 GEO 写作闭环</strong>
                <span>
                  填写品牌名、品类与目标市场（🇨🇳 国内 / 🌐
                  海外）后，全站看板、监测与写作台立即自动锁定该品牌上下文。
                </span>
              </div>
              <Button type="primary" disabled={account.tenant.readOnly} onClick={openCreateModal}>
                60 秒创建首个品牌
              </Button>
            </section>
          ) : null}
          <div className="gm-workspace-main">{children}</div>
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
      />

      <Modal
        open={enableTarget !== null}
        title={enableTarget === 'GLOBAL' ? '开启海外市场' : '开启国内市场'}
        onCancel={closeEnableModal}
        keyboard
        maskClosable
        destroyOnHidden
        okText="确认开启"
        cancelText="取消"
        confirmLoading={enableSubmitting}
        onOk={() => enableForm.submit()}
      >
        {enableDefaults ? (
          <p style={{ marginTop: 0, marginBottom: 12, color: 'var(--gm-fg-2)', fontSize: 12 }}>
            默认语种与区域：{enableDefaults.locale} / {enableDefaults.region}
            。开启后将与现有市场共享核心品牌事实卡，但引擎组、可见度看板与成稿严格隔离。
          </p>
        ) : null}
        <Form<EnableMarketFormValues>
          form={enableForm}
          layout="vertical"
          onFinish={(values) => void handleEnableSubmit(values)}
        >
          <Form.Item
            label="当地品牌名称"
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
            label="当地品类名称（选填）"
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
          <Form.Item label="当地官网域名（选填）" name="ownedDomainsText">
            <Input
              aria-label="当地官网域名"
              placeholder="例如：global.example.com（多个域名可用逗号分隔）"
            />
          </Form.Item>
          <Form.Item label="当地主要竞品（选填）" name="competitorsText">
            <Input.TextArea
              aria-label="当地主要竞品"
              rows={3}
              placeholder="每行一个竞品，格式：竞品名, 竞品域名（域名选填）"
            />
          </Form.Item>
          {enableError ? (
            <Alert type="error" showIcon message={enableError} style={{ marginBottom: 8 }} />
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
        <p
          style={{ margin: 0, color: 'var(--gm-fg-1)', lineHeight: '22px', whiteSpace: 'pre-wrap' }}
        >
          {trimmedAnnouncement}
        </p>
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
