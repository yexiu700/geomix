'use client';

import {
  CHANNEL_PROVIDER_LABELS,
  GEO_MARKET_LABELS,
  SUPPORTED_LOCALES,
  formatShanghaiDateTime,
  type ChannelConnectionDto,
  type ChannelConnectionTestResultDto,
  type GeoMarket,
  type SupportedLocale,
} from '@geomix/shared';
import { Alert, Button } from 'antd';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteChannelConnection,
  listChannelConnections,
  testChannelConnection,
  updateChannelConnection,
} from '../../lib/distribution';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalError, SignalSkeleton } from '../geo/primitives';
import { EmptyState, Section, StatusBadge, type StatusTone } from '../ui';
import {
  ChannelConnectionCreateModal,
  WECHAT_IP_WHITELIST_NOTICE,
  formatConnError,
  hasWechatIpWhitelistError,
} from './channel-connection-create-modal';

export type BrandChannelConnectionsProps = {
  brandId: string;
  activeMarket: GeoMarket;
  marketEnabled: boolean;
  readOnly: boolean;
  onEnableMarket: () => void;
  supportedLocales?: readonly SupportedLocale[];
  /** Optional redirect callback for Shopify OAuth (defaults to window.location.assign) */
  onOAuthRedirect?: (authorizeUrl: string) => void;
};

function connectionStatusMeta(status: ChannelConnectionDto['status']): {
  tone: StatusTone;
  label: string;
} {
  switch (status) {
    case 'ACTIVE':
      return { tone: 'success', label: '已连接' };
    case 'INVALID':
      return { tone: 'danger', label: '连接异常' };
    case 'DISABLED':
      return { tone: 'neutral', label: '已停用' };
  }
}

export function BrandChannelConnections({
  brandId,
  activeMarket,
  marketEnabled,
  readOnly,
  onEnableMarket,
  supportedLocales,
  onOAuthRedirect,
}: BrandChannelConnectionsProps): JSX.Element {
  const feedback = useUxFeedback();

  const [connections, setConnections] = useState<ChannelConnectionDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingCardId, setTestingCardId] = useState<string | null>(null);
  const [togglingCardId, setTogglingCardId] = useState<string | null>(null);

  // Add / Edit Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<ChannelConnectionDto | null>(null);
  const [initialShopifyAuthMode, setInitialShopifyAuthMode] = useState<
    'oauth' | 'custom' | undefined
  >(undefined);

  const contextSeqRef = useRef(0);
  const loadSeqRef = useRef(0);
  const loadCtrlRef = useRef<AbortController | null>(null);
  const cardActionCtrlsRef = useRef<Set<AbortController>>(new Set());
  const skipNextSelfRefreshRef = useRef(false);
  const testingCardsRef = useRef<Set<string>>(new Set());
  const togglingCardsRef = useRef<Set<string>>(new Set());

  const abortCardActions = useCallback(() => {
    for (const ctrl of cardActionCtrlsRef.current) {
      ctrl.abort();
    }
    cardActionCtrlsRef.current.clear();
    testingCardsRef.current.clear();
    togglingCardsRef.current.clear();
  }, []);

  const broadcastConnectionsChanged = useCallback(() => {
    skipNextSelfRefreshRef.current = true;
    try {
      invalidateFreshness('channel-connections');
    } finally {
      skipNextSelfRefreshRef.current = false;
    }
  }, []);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setEditingConn(null);
    setInitialShopifyAuthMode(undefined);
  }, []);

  const loadConnections = useCallback(
    async (options?: { silent?: boolean }) => {
      loadCtrlRef.current?.abort();
      const ctrl = new AbortController();
      loadCtrlRef.current = ctrl;
      const seq = ++loadSeqRef.current;

      if (!marketEnabled) {
        setConnections([]);
        setError(null);
        setLoading(false);
        return;
      }

      if (!options?.silent) {
        setLoading(true);
        setError(null);
      }

      try {
        const res = await listChannelConnections(brandId, activeMarket, {
          storage: window.sessionStorage,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted || seq !== loadSeqRef.current) return;
        setConnections(res.items);
        setError(null);
      } catch (err) {
        if (ctrl.signal.aborted || seq !== loadSeqRef.current) return;
        setError(formatConnError(err, '无法加载发布渠道连接'));
      } finally {
        if (!ctrl.signal.aborted && seq === loadSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [activeMarket, brandId, marketEnabled],
  );

  useEffect(() => {
    contextSeqRef.current += 1;
    closeModal();
    abortCardActions();
    setConnections([]);
    setError(null);
    setTestingCardId(null);
    setTogglingCardId(null);
    if (!marketEnabled) {
      loadCtrlRef.current?.abort();
      loadSeqRef.current += 1;
      setLoading(false);
    } else {
      void loadConnections();
    }
    return () => {
      contextSeqRef.current += 1;
      loadSeqRef.current += 1;
      loadCtrlRef.current?.abort();
      abortCardActions();
    };
  }, [brandId, activeMarket, marketEnabled, loadConnections, closeModal, abortCardActions]);

  useTabFreshness({
    active: marketEnabled,
    domains: ['channel-connections'],
    refreshOnActivate: false,
    onRefresh: () => {
      if (skipNextSelfRefreshRef.current) return;
      void loadConnections({ silent: true });
    },
  });

  const openCreateModal = () => {
    setEditingConn(null);
    setInitialShopifyAuthMode('oauth');
    setModalOpen(true);
  };

  const openEditModal = (conn: ChannelConnectionDto, preferredShopifyTab?: 'oauth' | 'custom') => {
    setEditingConn(conn);
    setInitialShopifyAuthMode(preferredShopifyTab);
    setModalOpen(true);
  };

  const handleModalSaved = (saved: ChannelConnectionDto, mode: 'create' | 'update') => {
    if (mode === 'create') {
      setConnections((prev) => [saved, ...prev.filter((c) => c.id !== saved.id)]);
    } else {
      setConnections((prev) => prev.map((c) => (c.id === saved.id ? saved : c)));
    }
    broadcastConnectionsChanged();
  };

  const handleModalTested = (connId: string, res: ChannelConnectionTestResultDto) => {
    setConnections((prev) =>
      prev.map((item) =>
        item.id === connId
          ? {
              ...item,
              status: res.status,
              lastTestedAt: res.testedAt,
              lastError: res.ok ? null : res.message,
            }
          : item,
      ),
    );
    broadcastConnectionsChanged();
  };

  const handleTestCard = async (conn: ChannelConnectionDto) => {
    if (readOnly || testingCardsRef.current.has(conn.id)) return;
    testingCardsRef.current.add(conn.id);
    const seq = contextSeqRef.current;
    const ctrl = new AbortController();
    cardActionCtrlsRef.current.add(ctrl);
    setTestingCardId(conn.id);
    try {
      const cfg = conn.configJson ?? {};
      const input =
        conn.provider === 'WEBFLOW'
          ? {
              ...(typeof cfg.siteId === 'string' && cfg.siteId ? { siteId: cfg.siteId } : {}),
              ...(typeof cfg.collectionId === 'string' && cfg.collectionId
                ? { collectionId: cfg.collectionId }
                : {}),
            }
          : {};
      const res = await testChannelConnection(brandId, conn.id, input, {
        storage: window.sessionStorage,
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      setConnections((prev) =>
        prev.map((item) =>
          item.id === conn.id
            ? {
                ...item,
                status: res.status,
                lastTestedAt: res.testedAt,
                lastError: res.ok ? null : res.message,
              }
            : item,
        ),
      );
      broadcastConnectionsChanged();
      if (res.ok) {
        feedback.notifySuccess(res.message || `「${conn.displayName}」连接测试通过`);
      } else {
        feedback.notifyError(res.message || `「${conn.displayName}」连接测试失败`);
      }
    } catch (err) {
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      feedback.notifyError(formatConnError(err, '测试渠道连接失败'));
    } finally {
      cardActionCtrlsRef.current.delete(ctrl);
      if (seq === contextSeqRef.current) {
        testingCardsRef.current.delete(conn.id);
        if (!ctrl.signal.aborted) {
          setTestingCardId((prev) => (prev === conn.id ? null : prev));
        }
      }
    }
  };

  const executeToggleStatus = async (
    conn: ChannelConnectionDto,
    nextStatus: 'ACTIVE' | 'DISABLED',
    expectedSeq: number,
  ) => {
    if (
      readOnly ||
      expectedSeq !== contextSeqRef.current ||
      togglingCardsRef.current.has(conn.id)
    ) {
      return;
    }
    togglingCardsRef.current.add(conn.id);
    const ctrl = new AbortController();
    cardActionCtrlsRef.current.add(ctrl);
    setTogglingCardId(conn.id);
    try {
      const updated = await updateChannelConnection(
        brandId,
        conn.id,
        { status: nextStatus },
        { storage: window.sessionStorage, signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || expectedSeq !== contextSeqRef.current) return;
      setConnections((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      broadcastConnectionsChanged();
      feedback.notifySuccess(
        nextStatus === 'DISABLED'
          ? `已停用渠道连接「${conn.displayName}」`
          : `已重新启用渠道连接「${conn.displayName}」`,
      );
    } catch (err) {
      if (ctrl.signal.aborted || expectedSeq !== contextSeqRef.current) return;
      feedback.notifyError(
        formatConnError(
          err,
          nextStatus === 'DISABLED' ? '停用渠道连接失败' : '重新启用渠道连接失败',
        ),
      );
    } finally {
      cardActionCtrlsRef.current.delete(ctrl);
      if (expectedSeq === contextSeqRef.current) {
        togglingCardsRef.current.delete(conn.id);
        if (!ctrl.signal.aborted) {
          setTogglingCardId((prev) => (prev === conn.id ? null : prev));
        }
      }
    }
  };

  const handleToggleStatus = (conn: ChannelConnectionDto) => {
    if (readOnly || conn.status === 'INVALID' || togglingCardsRef.current.has(conn.id)) return;
    const seq = contextSeqRef.current;

    if (conn.status === 'DISABLED') {
      const isShopifyOAuthRevoked =
        conn.provider === 'SHOPIFY' && conn.authType === 'OAUTH' && !conn.credentialHint.trim();
      if (isShopifyOAuthRevoked) {
        openEditModal(conn, 'oauth');
        return;
      }
      void executeToggleStatus(conn, 'ACTIVE', seq);
      return;
    }

    feedback.confirm({
      title: `确认停用渠道连接「${conn.displayName}」？`,
      content:
        '停用后该连接将自动从写作台分发目标列表中隐藏，不再参与一键推送；已保存的加密凭据与历史发布记录会完整保留，随时可重新启用。',
      okText: '确认停用',
      cancelText: '取消',
      onOk: () => executeToggleStatus(conn, 'DISABLED', seq),
    });
  };

  const handleDeleteCard = (conn: ChannelConnectionDto) => {
    if (readOnly) return;
    const seq = contextSeqRef.current;
    feedback.confirm({
      title: `确认删除渠道连接「${conn.displayName}」？`,
      content:
        '删除后该连接将无法用于后续一键推送；历史分发任务与已发布记录会安全保留并自动解除绑定，同时释放 1 个渠道连接配额。',
      okText: '确认删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (seq !== contextSeqRef.current) return;
        const ctrl = new AbortController();
        cardActionCtrlsRef.current.add(ctrl);
        try {
          await deleteChannelConnection(brandId, conn.id, {
            storage: window.sessionStorage,
            signal: ctrl.signal,
          });
          if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
          setConnections((prev) => prev.filter((item) => item.id !== conn.id));
          broadcastConnectionsChanged();
          feedback.notifySuccess(`已删除渠道连接「${conn.displayName}」`);
        } catch (err) {
          if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
          feedback.notifyError(formatConnError(err, '删除渠道连接失败'));
        } finally {
          cardActionCtrlsRef.current.delete(ctrl);
        }
      },
    });
  };

  return (
    <Section
      id="brand-section-connections"
      variant="plain"
      aria-label="发布渠道连接"
      data-testid="brand-channel-connections"
      title={
        <span className="gm-brand-section-title-row">
          <span>自有站点与发布渠道连接</span>
          <StatusBadge
            tone="neutral"
            label={`${activeMarket === 'CN' ? '🇨🇳' : '🌐'} ${GEO_MARKET_LABELS[activeMarket]}`}
          />
        </span>
      }
      description={
        activeMarket === 'CN'
          ? '当前市场专属连接，凭据采用 AES-256-GCM 加密存储且永不回传明文；支持微信公众号草稿箱（不自动群发）、WordPress、Webhook 等官方 L1 渠道连接。'
          : '当前市场专属连接，凭据采用 AES-256-GCM 加密存储且永不回传明文；支持 Shopify（OAuth / Custom Token）、WordPress、Webflow、Ghost、Dev.to、Hashnode、GitHub MDX 与通用签名 Webhook。'
      }
      actions={
        marketEnabled ? (
          <Button
            type="default"
            data-testid="add-channel-connection-btn"
            disabled={readOnly}
            className="gm-brand-btn-nowrap"
            onClick={openCreateModal}
          >
            + 添加渠道连接
          </Button>
        ) : undefined
      }
    >
      {!marketEnabled ? (
        <Alert
          type="info"
          showIcon
          message="当前市场尚未开启"
          description="请先开启当前市场配置，再添加该市场专属的自有站点渠道连接。"
          action={
            <Button
              size="small"
              type="default"
              disabled={readOnly}
              className="gm-brand-btn-nowrap"
              onClick={onEnableMarket}
            >
              立即开启
            </Button>
          }
        />
      ) : loading ? (
        <SignalSkeleton variant="block" height={140} />
      ) : error ? (
        <SignalError message={error} onRetry={() => void loadConnections()} />
      ) : connections.length === 0 ? (
        <EmptyState
          size="compact"
          title="当前市场尚未配置自有站点连接"
          description={
            activeMarket === 'CN'
              ? '绑定微信公众号草稿箱、WordPress 或自定义 Webhook 后，可在写作台一键推送草稿并跟踪 AI 收录效果。'
              : '绑定 Shopify、WordPress、Webflow、Ghost、Dev.to、Hashnode、GitHub MDX 或自定义 Webhook 后，可在写作台一键推送草稿、注入 JSON-LD 并触发 IndexNow 收录通知。'
          }
          action={
            readOnly ? undefined : (
              <Button size="small" onClick={openCreateModal}>
                添加渠道连接
              </Button>
            )
          }
        />
      ) : (
        <div className="gm-brand-conn-grid">
          {connections.map((conn) => {
            const statusMeta = connectionStatusMeta(conn.status);
            const cfg = conn.configJson ?? {};
            const isDraftDefault = cfg.defaultPublishAsDraft !== false;
            const hasInlineJsonLd = cfg.inlineJsonLd !== false;
            const hasIndexNow =
              typeof cfg.indexNowKey === 'string' && cfg.indexNowKey.trim().length > 0;
            const wpCatCount = Array.isArray(cfg.categoryIds) ? cfg.categoryIds.length : 0;
            const shopifyTarget =
              typeof cfg.blogHandle === 'string' && cfg.blogHandle
                ? cfg.blogHandle
                : typeof cfg.blogId === 'string' && cfg.blogId
                  ? cfg.blogId
                  : null;
            const webflowTarget =
              typeof cfg.collectionSlug === 'string' && cfg.collectionSlug
                ? cfg.collectionSlug
                : typeof cfg.collectionId === 'string' && cfg.collectionId
                  ? cfg.collectionId
                  : null;
            const githubRepoSlug =
              typeof cfg.repoOwner === 'string' &&
              cfg.repoOwner &&
              typeof cfg.repoName === 'string' &&
              cfg.repoName
                ? `${cfg.repoOwner}/${cfg.repoName}`
                : null;
            const githubBranch = typeof cfg.branch === 'string' && cfg.branch ? cfg.branch : null;
            const hashnodePubId =
              typeof cfg.publicationId === 'string' && cfg.publicationId ? cfg.publicationId : null;
            const isWechatConn = conn.provider === 'WECHAT_OFFICIAL';
            const isShopifyOAuthRevoked =
              conn.provider === 'SHOPIFY' &&
              conn.authType === 'OAUTH' &&
              conn.status === 'DISABLED' &&
              !conn.credentialHint.trim();
            const localeMeta = conn.targetLocale ? SUPPORTED_LOCALES[conn.targetLocale] : null;

            return (
              <div
                key={conn.id}
                className="gm-brand-conn-card"
                data-testid={`channel-connection-card-${conn.id}`}
              >
                <div className="gm-brand-conn-card-head">
                  <div className="gm-brand-conn-card-identity">
                    <div className="gm-brand-conn-title">{conn.displayName}</div>
                    <div className="gm-brand-conn-chips">
                      <span className="gm-brand-meta-chip">
                        {CHANNEL_PROVIDER_LABELS[conn.provider] ?? conn.provider}
                      </span>
                      {conn.provider === 'SHOPIFY' ? (
                        <span className="gm-brand-meta-chip">
                          {conn.authType === 'OAUTH' ? 'Shopify OAuth' : 'Custom App Token'}
                        </span>
                      ) : null}
                      {conn.targetLocale && localeMeta ? (
                        <span
                          className="gm-brand-meta-chip"
                          data-testid={`channel-connection-locale-${conn.id}`}
                        >
                          {conn.targetLocale} · {localeMeta.nativeLabel}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <StatusBadge
                    status={conn.status}
                    tone={statusMeta.tone}
                    label={statusMeta.label}
                  />
                </div>

                <div className="gm-brand-conn-details">
                  <div className="gm-mono gm-brand-conn-url">{conn.siteBaseUrl}</div>
                  {conn.externalShopDomain ? (
                    <div className="gm-brand-conn-subline">
                      绑定店铺：<span className="gm-mono">{conn.externalShopDomain}</span>
                    </div>
                  ) : null}
                  <div className="gm-brand-conn-cred-row">
                    <span className="gm-brand-conn-label">凭据指纹：</span>
                    <span className="gm-mono gm-brand-conn-cred-val">
                      {conn.credentialHint || '已加密存储'}
                    </span>
                  </div>
                  <div className="gm-brand-conn-label">
                    最近测试：{formatShanghaiDateTime(conn.lastTestedAt, { fallback: '尚未测试' })}
                  </div>
                </div>

                <div className="gm-brand-conn-chips">
                  <span className="gm-brand-meta-chip">
                    {isWechatConn
                      ? '仅推草稿箱（不自动群发）'
                      : isDraftDefault
                        ? conn.provider === 'GITHUB_MDX'
                          ? '默认 Draft PR'
                          : '默认草稿'
                        : conn.provider === 'GITHUB_MDX'
                          ? '直接提交分支'
                          : '直接上线'}
                  </span>
                  {!isWechatConn ? (
                    <span className="gm-brand-meta-chip">
                      {hasInlineJsonLd ? '内联 JSON-LD' : '关闭内联 JSON-LD'}
                    </span>
                  ) : null}
                  {hasIndexNow && !isWechatConn ? (
                    <span className="gm-brand-meta-chip">IndexNow 已启用</span>
                  ) : null}
                  {conn.provider === 'SHOPIFY' && shopifyTarget ? (
                    <span className="gm-brand-meta-chip gm-brand-meta-chip--wrap">
                      Blog: {shopifyTarget}
                    </span>
                  ) : null}
                  {conn.provider === 'WORDPRESS' && wpCatCount > 0 ? (
                    <span className="gm-brand-meta-chip">已选 {wpCatCount} 个分类</span>
                  ) : null}
                  {conn.provider === 'WEBFLOW' && webflowTarget ? (
                    <span className="gm-brand-meta-chip gm-brand-meta-chip--wrap">
                      集合: {webflowTarget}
                    </span>
                  ) : null}
                  {conn.provider === 'HASHNODE' && hashnodePubId ? (
                    <span className="gm-brand-meta-chip gm-brand-meta-chip--wrap">
                      Publication: {hashnodePubId}
                    </span>
                  ) : null}
                  {conn.provider === 'GITHUB_MDX' && githubRepoSlug ? (
                    <span className="gm-brand-meta-chip gm-brand-meta-chip--wrap">
                      Repo: {githubRepoSlug}
                      {githubBranch ? `@${githubBranch}` : ''}
                    </span>
                  ) : null}
                </div>

                {isWechatConn ? (
                  <Alert
                    type="info"
                    showIcon
                    data-testid={`wechat-card-draft-notice-${conn.id}`}
                    message="仅推送至公众号草稿箱，绝不自动群发"
                    description={WECHAT_IP_WHITELIST_NOTICE}
                    className="gm-brand-alert-wrap"
                  />
                ) : null}

                {isShopifyOAuthRevoked ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="Shopify OAuth 授权已停用或卸载"
                    description="请点击下方「重新授权」恢复 OAuth 连接，或在编辑中改用 Custom App Token。"
                    action={
                      <Button
                        size="small"
                        type="default"
                        disabled={readOnly}
                        className="gm-brand-btn-nowrap"
                        onClick={() => openEditModal(conn, 'oauth')}
                      >
                        重新授权
                      </Button>
                    }
                  />
                ) : null}

                {conn.lastError ? (
                  <Alert
                    type="error"
                    showIcon
                    message={conn.lastError}
                    description={
                      isWechatConn && hasWechatIpWhitelistError(conn.lastError)
                        ? '处理指引：请登录微信公众平台 →「设置与开发」→「基本配置」→「IP 白名单」，添加 GeoMix 服务器出口 IP 后重新测试连接。'
                        : undefined
                    }
                    className="gm-brand-alert-wrap"
                  />
                ) : null}

                <div className="gm-brand-conn-actions">
                  <Button
                    size="small"
                    data-testid={`channel-connection-test-btn-${conn.id}`}
                    loading={testingCardId === conn.id}
                    disabled={readOnly}
                    className="gm-brand-btn-nowrap"
                    onClick={() => void handleTestCard(conn)}
                  >
                    测试连接
                  </Button>
                  {!isShopifyOAuthRevoked && conn.status !== 'INVALID' ? (
                    <Button
                      size="small"
                      autoInsertSpace={false}
                      data-testid={`channel-connection-toggle-btn-${conn.id}`}
                      loading={togglingCardId === conn.id}
                      disabled={readOnly}
                      className="gm-brand-btn-nowrap"
                      onClick={() => handleToggleStatus(conn)}
                    >
                      {conn.status === 'DISABLED' ? '重新启用' : '停用'}
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    autoInsertSpace={false}
                    data-testid={`channel-connection-edit-btn-${conn.id}`}
                    disabled={readOnly}
                    className="gm-brand-btn-nowrap"
                    onClick={() => openEditModal(conn)}
                  >
                    编辑
                  </Button>
                  <Button
                    size="small"
                    type="text"
                    danger
                    autoInsertSpace={false}
                    data-testid={`channel-connection-delete-btn-${conn.id}`}
                    disabled={readOnly}
                    className="gm-brand-btn-nowrap"
                    onClick={() => handleDeleteCard(conn)}
                  >
                    删除
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ChannelConnectionCreateModal
        open={modalOpen}
        brandId={brandId}
        activeMarket={activeMarket}
        readOnly={readOnly}
        supportedLocales={supportedLocales}
        editingConn={editingConn}
        initialShopifyAuthMode={initialShopifyAuthMode}
        onOAuthRedirect={onOAuthRedirect}
        onClose={closeModal}
        onSaved={handleModalSaved}
        onTested={handleModalTested}
      />
    </Section>
  );
}
