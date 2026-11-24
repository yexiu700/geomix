'use client';

import {
  CHANNEL_PROVIDER_LABELS,
  GEO_MARKET_LABELS,
  L1_CHANNEL_PROVIDERS,
  formatShanghaiDateTime,
  isSafeDistributionHttpUrl,
  type ChannelConnectionConfig,
  type ChannelConnectionDto,
  type ChannelConnectionTestResultDto,
  type ChannelRemoteTargetDto,
  type GeoMarket,
  type L1ChannelProvider,
  type UpdateChannelConnectionInput,
} from '@geomix/shared';
import { Alert, Button, Input, Modal, Select, Space, Switch, Tag } from 'antd';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChannelConnection,
  deleteChannelConnection,
  listChannelConnections,
  testChannelConnection,
  updateChannelConnection,
} from '../../lib/distribution';
import { GatewayApiError } from '../../lib/envelope';
import { copyTextToClipboard } from '../../lib/studio';
import { invalidateFreshness, useTabFreshness } from '../../lib/tab-freshness';
import { useUxFeedback } from '../crud/ux-feedback';
import { SignalEmpty, SignalError, SignalPill, SignalSkeleton } from '../geo/primitives';

export type BrandChannelConnectionsProps = {
  brandId: string;
  activeMarket: GeoMarket;
  marketEnabled: boolean;
  readOnly: boolean;
  onEnableMarket: () => void;
};

type WebflowFieldOption = {
  id: string;
  slug: string;
  displayName: string;
  type?: string;
  isRequired?: boolean;
};

type WebflowFieldMapDraft = {
  title: string;
  slug: string;
  bodyHtml: string;
  metaDesc: string;
  jsonLd: string;
};

const EMPTY_WEBFLOW_FIELD_MAP: WebflowFieldMapDraft = {
  title: '',
  slug: '',
  bodyHtml: '',
  metaDesc: '',
  jsonLd: '',
};

function formatConnError(err: unknown, fallback: string): string {
  if (err instanceof GatewayApiError) {
    return err.message || fallback;
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return fallback;
}

function generateSecureWebhookSecret(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const partA = Math.random().toString(16).slice(2).padEnd(16, '0').slice(0, 16);
  const partB = Date.now().toString(16).padStart(16, '0').slice(-16);
  return `${partA}${partB}`;
}

function providerSitePlaceholder(provider: L1ChannelProvider): string {
  switch (provider) {
    case 'SHOPIFY':
      return 'https://your-store.myshopify.com';
    case 'WORDPRESS':
      return 'https://blog.example.com';
    case 'WEBFLOW':
      return 'https://www.example.com';
    case 'WEBHOOK':
      return 'https://hooks.example.com/geomix';
    case 'GHOST':
      return 'https://blog.example.com';
    case 'DEVTO':
      return 'https://dev.to';
    case 'HASHNODE':
      return 'https://hashnode.com';
    case 'GITHUB_MDX':
      return 'https://github.com/org/repo';
    case 'WECHAT_OFFICIAL':
      return 'https://mp.weixin.qq.com';
  }
}

function providerSiteHint(provider: L1ChannelProvider): string {
  switch (provider) {
    case 'SHOPIFY':
      return '填写 Shopify 店铺域名（含 https://），支持 Admin GraphQL 博客直推。';
    case 'WORDPRESS':
      return '填写 WordPress 站点根地址（自动调用 /wp-json/wp/v2 接口）。';
    case 'WEBFLOW':
      return '填写 Webflow 站点公网域名，保存并测试后可级联拉取站点、集合与字段映射。';
    case 'WEBHOOK':
      return '填写接收推送事件的 HTTPS Webhook 地址，请求头附带 X-GeoMix-Signature HMAC-SHA256 签名。';
    case 'GHOST':
      return '填写 Ghost 站点根地址，使用 Ghost Admin API v5 短期 HS256 JWT 直推文章与 JSON-LD。';
    case 'DEVTO':
      return '填写 Dev.to 社区地址（https://dev.to），支持 Forem REST v1 推送 Markdown 与 Canonical URL。';
    case 'HASHNODE':
      return '填写 Hashnode 站点或主页地址，支持 GraphQL 草稿/发布与 Canonical URL 回指。';
    case 'GITHUB_MDX':
      return '填写目标 GitHub 仓库地址，草稿模式自动新建分支提交 MDX 并发起 PR 审阅。';
    case 'WECHAT_OFFICIAL':
      return '仅调用微信官方草稿箱接口（不自动群发），需提前在公众号后台配置服务器出口 IP 白名单。';
  }
}

function readStringConfig(config: Record<string, unknown>, key: string): string {
  const val = config[key];
  return typeof val === 'string' ? val : '';
}

function readNumberArrayConfig(config: Record<string, unknown>, key: string): number[] {
  const val = config[key];
  if (!Array.isArray(val)) return [];
  return val
    .map((item) => Number(item))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 20);
}

function readFieldMapConfig(config: Record<string, unknown>): WebflowFieldMapDraft {
  const raw = config.fieldMap;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...EMPTY_WEBFLOW_FIELD_MAP };
  }
  const obj = raw as Record<string, unknown>;
  return {
    title: typeof obj.title === 'string' ? obj.title : '',
    slug: typeof obj.slug === 'string' ? obj.slug : '',
    bodyHtml: typeof obj.bodyHtml === 'string' ? obj.bodyHtml : '',
    metaDesc: typeof obj.metaDesc === 'string' ? obj.metaDesc : '',
    jsonLd: typeof obj.jsonLd === 'string' ? obj.jsonLd : '',
  };
}

function parseWebflowFieldsFromTargets(
  targets: readonly ChannelRemoteTargetDto[],
  selectedCollectionId?: string,
): WebflowFieldOption[] {
  const target =
    (selectedCollectionId ? targets.find((t) => t.id === selectedCollectionId) : null) ??
    targets.find((t) => Array.isArray(t.meta?.fields)) ??
    null;
  const rawFields = target?.meta?.fields;
  if (!Array.isArray(rawFields)) return [];
  const parsed: WebflowFieldOption[] = [];
  for (const item of rawFields) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const slug = typeof rec.slug === 'string' ? rec.slug.trim() : '';
    if (!slug) continue;
    parsed.push({
      id: typeof rec.id === 'string' ? rec.id : slug,
      slug,
      displayName: typeof rec.displayName === 'string' && rec.displayName ? rec.displayName : slug,
      type: typeof rec.type === 'string' ? rec.type : undefined,
      isRequired: typeof rec.isRequired === 'boolean' ? rec.isRequired : undefined,
    });
  }
  return parsed;
}

function connectionStatusMeta(status: ChannelConnectionDto['status']): {
  tone: 'cited' | 'danger' | 'neutral';
  label: string;
} {
  switch (status) {
    case 'ACTIVE':
      return { tone: 'cited', label: '已连接' };
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
}: BrandChannelConnectionsProps): JSX.Element {
  const feedback = useUxFeedback();

  const [connections, setConnections] = useState<ChannelConnectionDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingCardId, setTestingCardId] = useState<string | null>(null);

  // Add / Edit Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<ChannelConnectionDto | null>(null);
  const [provider, setProvider] = useState<L1ChannelProvider>('SHOPIFY');
  const [displayName, setDisplayName] = useState('');
  const [siteBaseUrl, setSiteBaseUrl] = useState('');

  // Provider credential inputs (always cleared on close / after create)
  const [shopifyAccessToken, setShopifyAccessToken] = useState('');
  const [wpUsername, setWpUsername] = useState('');
  const [wpAppPassword, setWpAppPassword] = useState('');
  const [webflowApiToken, setWebflowApiToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');

  // Provider configJson fields
  const [blogId, setBlogId] = useState('');
  const [blogHandle, setBlogHandle] = useState('');
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [siteId, setSiteId] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [collectionSlug, setCollectionSlug] = useState('');
  const [fieldMap, setFieldMap] = useState<WebflowFieldMapDraft>({ ...EMPTY_WEBFLOW_FIELD_MAP });
  const [defaultPublishAsDraft, setDefaultPublishAsDraft] = useState(true);
  const [inlineJsonLd, setInlineJsonLd] = useState(true);
  const [indexNowKey, setIndexNowKey] = useState('');

  // Modal async & target discovery state
  const [submitting, setSubmitting] = useState(false);
  const [modalTesting, setModalTesting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalTestResult, setModalTestResult] = useState<ChannelConnectionTestResultDto | null>(
    null,
  );
  const [remoteTargets, setRemoteTargets] = useState<ChannelRemoteTargetDto[]>([]);

  const contextSeqRef = useRef(0);
  const loadSeqRef = useRef(0);
  const loadCtrlRef = useRef<AbortController | null>(null);
  const modalActionCtrlRef = useRef<AbortController | null>(null);
  const cardActionCtrlsRef = useRef<Set<AbortController>>(new Set());
  const skipNextSelfRefreshRef = useRef(false);
  const submittingRef = useRef(false);
  const testingCardsRef = useRef<Set<string>>(new Set());

  const abortCardActions = useCallback(() => {
    for (const ctrl of cardActionCtrlsRef.current) {
      ctrl.abort();
    }
    cardActionCtrlsRef.current.clear();
    testingCardsRef.current.clear();
  }, []);

  const broadcastConnectionsChanged = useCallback(() => {
    skipNextSelfRefreshRef.current = true;
    try {
      invalidateFreshness('channel-connections');
    } finally {
      skipNextSelfRefreshRef.current = false;
    }
  }, []);

  const clearModalSecrets = useCallback(() => {
    setShopifyAccessToken('');
    setWpUsername('');
    setWpAppPassword('');
    setWebflowApiToken('');
    setWebhookSecret('');
  }, []);

  const resetModalState = useCallback(() => {
    modalActionCtrlRef.current?.abort();
    modalActionCtrlRef.current = null;
    submittingRef.current = false;
    setModalOpen(false);
    setEditingConn(null);
    setProvider('SHOPIFY');
    setDisplayName('');
    setSiteBaseUrl('');
    clearModalSecrets();
    setBlogId('');
    setBlogHandle('');
    setCategoryIds([]);
    setSiteId('');
    setCollectionId('');
    setCollectionSlug('');
    setFieldMap({ ...EMPTY_WEBFLOW_FIELD_MAP });
    setDefaultPublishAsDraft(true);
    setInlineJsonLd(true);
    setIndexNowKey('');
    setSubmitting(false);
    setModalTesting(false);
    setModalError(null);
    setModalTestResult(null);
    setRemoteTargets([]);
  }, [clearModalSecrets]);

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
    resetModalState();
    abortCardActions();
    setConnections([]);
    setError(null);
    setTestingCardId(null);
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
      submittingRef.current = false;
      loadCtrlRef.current?.abort();
      modalActionCtrlRef.current?.abort();
      abortCardActions();
    };
  }, [brandId, activeMarket, marketEnabled, loadConnections, resetModalState, abortCardActions]);

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
    resetModalState();
    setProvider('SHOPIFY');
    setDefaultPublishAsDraft(true);
    setInlineJsonLd(true);
    setModalOpen(true);
  };

  const openEditModal = (conn: ChannelConnectionDto) => {
    resetModalState();
    const cfg = conn.configJson ?? {};
    const l1Provider: L1ChannelProvider = L1_CHANNEL_PROVIDERS.includes(
      conn.provider as L1ChannelProvider,
    )
      ? (conn.provider as L1ChannelProvider)
      : 'SHOPIFY';
    setEditingConn(conn);
    setProvider(l1Provider);
    setDisplayName(conn.displayName);
    setSiteBaseUrl(conn.siteBaseUrl);
    setBlogId(readStringConfig(cfg, 'blogId'));
    setBlogHandle(readStringConfig(cfg, 'blogHandle'));
    setCategoryIds(readNumberArrayConfig(cfg, 'categoryIds'));
    setSiteId(readStringConfig(cfg, 'siteId'));
    setCollectionId(readStringConfig(cfg, 'collectionId'));
    setCollectionSlug(readStringConfig(cfg, 'collectionSlug'));
    setFieldMap(readFieldMapConfig(cfg));
    setDefaultPublishAsDraft(cfg.defaultPublishAsDraft !== false);
    setInlineJsonLd(cfg.inlineJsonLd !== false);
    setIndexNowKey(readStringConfig(cfg, 'indexNowKey'));
    setModalOpen(true);
  };

  const buildConfigPayload = ():
    { ok: true; config: ChannelConnectionConfig } | { ok: false; error: string } => {
    const trimmedIndexNow = indexNowKey.trim();
    if (trimmedIndexNow && trimmedIndexNow.length < 8) {
      return { ok: false, error: 'IndexNow Key 如需填写，长度至少为 8 位字符' };
    }
    if (trimmedIndexNow && trimmedIndexNow.length > 128) {
      return { ok: false, error: 'IndexNow Key 长度不能超过 128 位字符' };
    }
    const config: ChannelConnectionConfig = {
      defaultPublishAsDraft,
      inlineJsonLd,
    };
    if (trimmedIndexNow) {
      config.indexNowKey = trimmedIndexNow;
    }

    if (provider === 'SHOPIFY') {
      if (blogId.trim()) config.blogId = blogId.trim();
      if (blogHandle.trim()) config.blogHandle = blogHandle.trim();
    } else if (provider === 'WORDPRESS') {
      if (categoryIds.length > 0) {
        config.categoryIds = categoryIds
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n > 0);
      }
    } else if (provider === 'WEBFLOW') {
      if (siteId.trim()) config.siteId = siteId.trim();
      if (collectionId.trim()) config.collectionId = collectionId.trim();
      if (collectionSlug.trim()) {
        (config as Record<string, unknown>).collectionSlug = collectionSlug.trim();
      }
      const cleanFieldMap: NonNullable<ChannelConnectionConfig['fieldMap']> = {};
      if (fieldMap.title.trim()) cleanFieldMap.title = fieldMap.title.trim();
      if (fieldMap.slug.trim()) cleanFieldMap.slug = fieldMap.slug.trim();
      if (fieldMap.bodyHtml.trim()) cleanFieldMap.bodyHtml = fieldMap.bodyHtml.trim();
      if (fieldMap.metaDesc.trim()) cleanFieldMap.metaDesc = fieldMap.metaDesc.trim();
      if (fieldMap.jsonLd.trim()) cleanFieldMap.jsonLd = fieldMap.jsonLd.trim();
      if (Object.keys(cleanFieldMap).length > 0) {
        config.fieldMap = cleanFieldMap;
      }
    }

    return { ok: true, config };
  };

  const buildCreateCredentials = ():
    { ok: true; credentials: Record<string, string> } | { ok: false; error: string } => {
    switch (provider) {
      case 'SHOPIFY': {
        const token = shopifyAccessToken.trim();
        if (!token) return { ok: false, error: '请填写 Shopify Admin API Access Token' };
        return { ok: true, credentials: { accessToken: token } };
      }
      case 'WORDPRESS': {
        const user = wpUsername.trim();
        const pass = wpAppPassword.trim();
        if (!user) return { ok: false, error: '请填写 WordPress 用户名' };
        if (!pass) return { ok: false, error: '请填写 WordPress Application Password' };
        return { ok: true, credentials: { username: user, appPassword: pass } };
      }
      case 'WEBFLOW': {
        const token = webflowApiToken.trim();
        if (!token) return { ok: false, error: '请填写 Webflow API Token' };
        return { ok: true, credentials: { apiToken: token } };
      }
      case 'WEBHOOK': {
        const secret = webhookSecret.trim();
        if (secret.length < 8) return { ok: false, error: 'Webhook 签名密钥长度至少为 8 位' };
        return { ok: true, credentials: { signingSecret: secret } };
      }
      default:
        return { ok: false, error: '该渠道暂未在当前面板完成表单配置' };
    }
  };

  const buildPatchCredentials = ():
    { ok: true; credentials?: Record<string, string> } | { ok: false; error: string } => {
    const patch: Record<string, string> = {};
    switch (provider) {
      case 'SHOPIFY': {
        if (shopifyAccessToken.trim()) patch.accessToken = shopifyAccessToken.trim();
        break;
      }
      case 'WORDPRESS': {
        if (wpUsername.trim()) patch.username = wpUsername.trim();
        if (wpAppPassword.trim()) patch.appPassword = wpAppPassword.trim();
        break;
      }
      case 'WEBFLOW': {
        if (webflowApiToken.trim()) patch.apiToken = webflowApiToken.trim();
        break;
      }
      case 'WEBHOOK': {
        const secret = webhookSecret.trim();
        if (secret) {
          if (secret.length < 8) {
            return { ok: false, error: 'Webhook 签名密钥长度至少为 8 位' };
          }
          patch.signingSecret = secret;
        }
        break;
      }
    }
    return Object.keys(patch).length > 0 ? { ok: true, credentials: patch } : { ok: true };
  };

  const applyDiscoveredTargets = useCallback(
    (
      targetProvider: L1ChannelProvider,
      targets: readonly ChannelRemoteTargetDto[],
      overrides?: { siteId?: string; collectionId?: string },
    ) => {
      setRemoteTargets([...targets]);
      if (targetProvider === 'SHOPIFY' && targets.length > 0) {
        const currentMatch = blogId ? targets.find((t) => t.id === blogId) : null;
        const chosen = currentMatch ?? targets[0]!;
        if (!blogId) {
          setBlogId(chosen.id);
        }
        if (chosen.handle) {
          setBlogHandle(chosen.handle);
        }
      } else if (targetProvider === 'WEBFLOW' && targets.length > 0) {
        const effectiveSiteId = overrides?.siteId !== undefined ? overrides.siteId : siteId;
        const effectiveCollectionId =
          overrides?.collectionId !== undefined ? overrides.collectionId : collectionId;
        const isSiteList = targets.every((t) => t.meta?.kind === 'site');
        if (isSiteList) {
          if (!effectiveSiteId && targets[0]) {
            setSiteId(targets[0].id);
          }
        } else {
          const firstCollection =
            (effectiveCollectionId ? targets.find((t) => t.id === effectiveCollectionId) : null) ??
            targets[0]!;
          const discoveredSiteId =
            typeof firstCollection.meta?.siteId === 'string' ? firstCollection.meta.siteId : '';
          if (discoveredSiteId && !effectiveSiteId) {
            setSiteId(discoveredSiteId);
          }
          if (!effectiveCollectionId && firstCollection.id) {
            setCollectionId(firstCollection.id);
          }
          if (typeof firstCollection.meta?.collectionSlug === 'string') {
            setCollectionSlug(firstCollection.meta.collectionSlug);
          } else if (firstCollection.handle) {
            setCollectionSlug(firstCollection.handle);
          }
        }
      }
    },
    [blogId, collectionId, siteId],
  );

  const runModalTest = useCallback(
    async (
      connId: string,
      targetProvider: L1ChannelProvider,
      overrides?: { siteId?: string; collectionId?: string },
    ) => {
      if (readOnly) return;
      modalActionCtrlRef.current?.abort();
      const ctrl = new AbortController();
      modalActionCtrlRef.current = ctrl;
      const seq = contextSeqRef.current;
      setModalTesting(true);
      setModalError(null);
      try {
        const effectiveTestSiteId = (
          overrides?.siteId !== undefined ? overrides.siteId : siteId
        ).trim();
        const effectiveTestCollectionId = (
          overrides?.collectionId !== undefined ? overrides.collectionId : collectionId
        ).trim();
        const testPayload =
          targetProvider === 'WEBFLOW'
            ? {
                ...(effectiveTestSiteId ? { siteId: effectiveTestSiteId } : {}),
                ...(effectiveTestCollectionId ? { collectionId: effectiveTestCollectionId } : {}),
              }
            : {};
        const res = await testChannelConnection(brandId, connId, testPayload, {
          storage: window.sessionStorage,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        setModalTestResult(res);
        if (res.targets && res.targets.length > 0) {
          applyDiscoveredTargets(targetProvider, res.targets, overrides);
        }
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
        if (res.ok) {
          feedback.notifySuccess(res.message || '连接测试通过');
        } else {
          feedback.notifyWarning(res.message || '连接测试未通过，请检查凭据或站点地址');
        }
      } catch (err) {
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        const msg = formatConnError(err, '测试连接失败');
        setModalError(msg);
        feedback.notifyError(msg);
      } finally {
        if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
          setModalTesting(false);
        }
      }
    },
    [
      applyDiscoveredTargets,
      brandId,
      broadcastConnectionsChanged,
      collectionId,
      feedback,
      readOnly,
      siteId,
    ],
  );

  const handleModalSubmit = async (options?: { testAfterCreate?: boolean }) => {
    if (readOnly || submittingRef.current) return;
    setModalError(null);
    const trimmedName = displayName.trim();
    const trimmedUrl = siteBaseUrl.trim();
    if (!trimmedName) {
      setModalError('请填写连接名称');
      return;
    }
    if (!trimmedUrl || !isSafeDistributionHttpUrl(trimmedUrl)) {
      setModalError('请输入有效的 http:// 或 https:// 站点地址');
      return;
    }
    const cfgRes = buildConfigPayload();
    if (!cfgRes.ok) {
      setModalError(cfgRes.error);
      return;
    }

    if (editingConn) {
      const credPatch = buildPatchCredentials();
      if (!credPatch.ok) {
        setModalError(credPatch.error);
        return;
      }
      submittingRef.current = true;
      const ctrl = new AbortController();
      modalActionCtrlRef.current = ctrl;
      const seq = contextSeqRef.current;
      setSubmitting(true);

      try {
        const payload: UpdateChannelConnectionInput = {
          displayName: trimmedName,
          siteBaseUrl: trimmedUrl,
          configJson: cfgRes.config,
          ...(credPatch.credentials ? { credentials: credPatch.credentials } : {}),
        };
        const updated = await updateChannelConnection(brandId, editingConn.id, payload, {
          storage: window.sessionStorage,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        setConnections((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
        broadcastConnectionsChanged();
        feedback.notifySuccess(`已保存渠道连接「${updated.displayName}」`);
        resetModalState();
      } catch (err) {
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        const msg = formatConnError(err, '保存渠道连接失败');
        setModalError(msg);
        feedback.notifyError(msg);
      } finally {
        if (modalActionCtrlRef.current === ctrl) {
          modalActionCtrlRef.current = null;
        }
        if (seq === contextSeqRef.current) {
          submittingRef.current = false;
          if (!ctrl.signal.aborted) {
            setSubmitting(false);
          }
        }
      }
      return;
    }

    const credRes = buildCreateCredentials();
    if (!credRes.ok) {
      setModalError(credRes.error);
      return;
    }

    submittingRef.current = true;
    const ctrl = new AbortController();
    modalActionCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    setSubmitting(true);

    try {
      const created = await createChannelConnection(
        brandId,
        {
          market: activeMarket,
          provider,
          displayName: trimmedName,
          siteBaseUrl: trimmedUrl,
          credentials: credRes.credentials,
          configJson: cfgRes.config,
        },
        {
          storage: window.sessionStorage,
          signal: ctrl.signal,
        },
      );
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      setConnections((prev) => [created, ...prev.filter((c) => c.id !== created.id)]);
      broadcastConnectionsChanged();

      if (options?.testAfterCreate) {
        // Transition seamlessly into edit mode, wipe raw secrets immediately, and pull remote targets
        setEditingConn(created);
        clearModalSecrets();
        setSubmitting(false);
        feedback.notifySuccess(`已创建连接「${created.displayName}」，正在测试连通性…`);
        await runModalTest(created.id, provider);
        return;
      }

      feedback.notifySuccess(`已添加渠道连接「${created.displayName}」`);
      resetModalState();
    } catch (err) {
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      const msg = formatConnError(err, '添加渠道连接失败');
      setModalError(msg);
      feedback.notifyError(msg);
    } finally {
      if (modalActionCtrlRef.current === ctrl) {
        modalActionCtrlRef.current = null;
      }
      if (seq === contextSeqRef.current) {
        submittingRef.current = false;
        if (!ctrl.signal.aborted) {
          setSubmitting(false);
        }
      }
    }
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

  const webflowSiteTargets = useMemo(
    () => remoteTargets.filter((t) => t.meta?.kind === 'site'),
    [remoteTargets],
  );
  const webflowCollectionTargets = useMemo(
    () => remoteTargets.filter((t) => t.meta?.kind !== 'site'),
    [remoteTargets],
  );
  const webflowFields = useMemo(
    () => parseWebflowFieldsFromTargets(webflowCollectionTargets, collectionId),
    [collectionId, webflowCollectionTargets],
  );

  const renderWebflowFieldControl = (
    fieldKey: keyof WebflowFieldMapDraft,
    label: string,
    defaultHint: string,
  ) => {
    const value = fieldMap[fieldKey];
    if (webflowFields.length > 0) {
      const options = webflowFields.map((f) => ({
        value: f.slug,
        label: `${f.displayName} (${f.slug})`,
      }));
      if (value && !options.some((opt) => opt.value === value)) {
        options.unshift({ value, label: `${value}（当前配置）` });
      }
      return (
        <div key={fieldKey} style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>{label}</div>
          <Select
            allowClear
            showSearch
            style={{ width: '100%' }}
            aria-label={label}
            placeholder={`默认：${defaultHint}`}
            value={value || undefined}
            options={options}
            onChange={(next) =>
              setFieldMap((prev) => ({ ...prev, [fieldKey]: typeof next === 'string' ? next : '' }))
            }
          />
        </div>
      );
    }
    return (
      <div key={fieldKey} style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>{label}</div>
        <Input
          aria-label={label}
          placeholder={`默认：${defaultHint}`}
          value={value}
          onChange={(e) => setFieldMap((prev) => ({ ...prev, [fieldKey]: e.target.value }))}
        />
      </div>
    );
  };

  return (
    <section
      id="brand-section-connections"
      className="gm-brand-section"
      aria-label="发布渠道连接"
      data-testid="brand-channel-connections"
    >
      <div
        className="gm-brand-section-head"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <div className="gm-brand-section-title-row">
            <h4 className="gm-brand-section-title">4. 自有站点与发布渠道连接</h4>
            <Tag color="cyan" style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {activeMarket === 'CN' ? '🇨🇳' : '🌐'} {GEO_MARKET_LABELS[activeMarket]}
            </Tag>
          </div>
          <p className="gm-brand-section-desc">
            当前市场专属连接，凭据采用 AES-256-GCM 加密存储且永不回传明文；支持
            Shopify、WordPress、Webflow 与通用签名 Webhook 一键推送草稿或正式上线。
          </p>
        </div>

        {marketEnabled ? (
          <Button
            type="primary"
            data-testid="add-channel-connection-btn"
            disabled={readOnly}
            style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
            onClick={openCreateModal}
          >
            + 添加渠道连接
          </Button>
        ) : null}
      </div>

      {!marketEnabled ? (
        <Alert
          type="info"
          showIcon
          message="当前市场尚未开启"
          description="请先开启当前市场配置，再添加该市场专属的自有站点渠道连接。"
          action={
            <Button
              size="small"
              type="primary"
              disabled={readOnly}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
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
        <SignalEmpty
          title="当前市场尚未配置自有站点连接"
          description="绑定 Shopify、WordPress、Webflow 或自定义 Webhook 后，可在写作台一键推送草稿、注入 JSON-LD 并触发 IndexNow 收录通知。"
          actionText={readOnly ? undefined : '添加渠道连接'}
          onAction={readOnly ? undefined : openCreateModal}
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))',
            gap: 12,
          }}
        >
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

            return (
              <div
                key={conn.id}
                className="gm-brand-subcard"
                data-testid={`channel-connection-card-${conn.id}`}
                style={{
                  minWidth: 0,
                  maxWidth: '100%',
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 8,
                  }}
                >
                  <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 600,
                        color: 'var(--gm-fg-1)',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {conn.displayName}
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <Tag
                        color="geekblue"
                        style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}
                      >
                        {CHANNEL_PROVIDER_LABELS[conn.provider] ?? conn.provider}
                      </Tag>
                    </div>
                  </div>
                  <SignalPill tone={statusMeta.tone}>{statusMeta.label}</SignalPill>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    fontSize: 12,
                    color: 'var(--gm-fg-2)',
                    minWidth: 0,
                  }}
                >
                  <div
                    className="gm-mono"
                    style={{
                      color: 'var(--gm-fg-1)',
                      overflowWrap: 'anywhere',
                      wordBreak: 'break-word',
                    }}
                  >
                    {conn.siteBaseUrl}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: 'var(--gm-fg-3)' }}>凭据指纹：</span>
                    <span
                      className="gm-mono"
                      style={{
                        color: 'var(--gm-fg-2)',
                        overflowWrap: 'anywhere',
                        wordBreak: 'break-word',
                      }}
                    >
                      {conn.credentialHint || '已加密存储'}
                    </span>
                  </div>
                  <div style={{ color: 'var(--gm-fg-3)' }}>
                    最近测试：{formatShanghaiDateTime(conn.lastTestedAt, { fallback: '尚未测试' })}
                  </div>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <Tag style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {isDraftDefault ? '默认草稿' : '直接上线'}
                  </Tag>
                  <Tag style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {hasInlineJsonLd ? '内联 JSON-LD' : '关闭内联 JSON-LD'}
                  </Tag>
                  {hasIndexNow ? (
                    <Tag color="green" style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>
                      IndexNow 已启用
                    </Tag>
                  ) : null}
                  {conn.provider === 'SHOPIFY' && shopifyTarget ? (
                    <Tag
                      color="blue"
                      style={{
                        margin: 0,
                        maxWidth: '100%',
                        whiteSpace: 'normal',
                        overflowWrap: 'anywhere',
                        wordBreak: 'break-word',
                      }}
                    >
                      Blog: {shopifyTarget}
                    </Tag>
                  ) : null}
                  {conn.provider === 'WORDPRESS' && wpCatCount > 0 ? (
                    <Tag color="blue" style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>
                      已选 {wpCatCount} 个分类
                    </Tag>
                  ) : null}
                  {conn.provider === 'WEBFLOW' && webflowTarget ? (
                    <Tag
                      color="blue"
                      style={{
                        margin: 0,
                        maxWidth: '100%',
                        whiteSpace: 'normal',
                        overflowWrap: 'anywhere',
                        wordBreak: 'break-word',
                      }}
                    >
                      集合: {webflowTarget}
                    </Tag>
                  ) : null}
                </div>

                {conn.lastError ? (
                  <Alert
                    type="error"
                    showIcon
                    message={conn.lastError}
                    style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
                  />
                ) : null}

                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    marginTop: 'auto',
                    paddingTop: 4,
                  }}
                >
                  <Button
                    size="small"
                    data-testid={`channel-connection-test-btn-${conn.id}`}
                    loading={testingCardId === conn.id}
                    disabled={readOnly}
                    style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                    onClick={() => void handleTestCard(conn)}
                  >
                    测试连接
                  </Button>
                  <Button
                    size="small"
                    autoInsertSpace={false}
                    data-testid={`channel-connection-edit-btn-${conn.id}`}
                    disabled={readOnly}
                    style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                    onClick={() => openEditModal(conn)}
                  >
                    编辑
                  </Button>
                  <Button
                    size="small"
                    danger
                    autoInsertSpace={false}
                    data-testid={`channel-connection-delete-btn-${conn.id}`}
                    disabled={readOnly}
                    style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
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

      <Modal
        open={modalOpen}
        title={editingConn ? `编辑发布渠道连接 · ${editingConn.displayName}` : '添加发布渠道连接'}
        width="min(640px, calc(100vw - 32px))"
        destroyOnHidden
        keyboard={!submitting && !modalTesting}
        maskClosable={!submitting && !modalTesting}
        onCancel={resetModalState}
        footer={
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
              gap: 8,
            }}
          >
            <Button
              disabled={submitting || modalTesting}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              onClick={resetModalState}
            >
              取消
            </Button>
            {editingConn ? (
              <Button
                data-testid="channel-connection-modal-test-btn"
                loading={modalTesting}
                disabled={readOnly || submitting}
                style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                onClick={() => void runModalTest(editingConn.id, provider)}
              >
                测试连接并拉取目标
              </Button>
            ) : (
              <Button
                data-testid="channel-connection-save-and-test-btn"
                loading={submitting || modalTesting}
                disabled={readOnly}
                style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                onClick={() => void handleModalSubmit({ testAfterCreate: true })}
              >
                保存并测试连接
              </Button>
            )}
            <Button
              type="primary"
              data-testid="channel-connection-submit-btn"
              loading={submitting}
              disabled={readOnly || modalTesting}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              onClick={() => void handleModalSubmit()}
            >
              保存连接
            </Button>
          </div>
        }
      >
        <div
          data-testid="channel-connection-modal"
          style={{
            minWidth: 0,
            maxWidth: '100%',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {modalError ? (
            <Alert
              type="error"
              showIcon
              message={modalError}
              style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
            />
          ) : null}

          {modalTestResult ? (
            <Alert
              type={modalTestResult.ok ? 'success' : 'warning'}
              showIcon
              message={modalTestResult.message}
              style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
            />
          ) : null}

          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
              渠道类型（所属市场：{GEO_MARKET_LABELS[activeMarket]}）
            </div>
            <Select<L1ChannelProvider>
              data-testid="channel-provider-select"
              aria-label="渠道类型"
              style={{ width: '100%' }}
              disabled={Boolean(editingConn)}
              value={provider}
              options={L1_CHANNEL_PROVIDERS.map((p) => ({
                value: p,
                label: CHANNEL_PROVIDER_LABELS[p],
              }))}
              onChange={(next) => {
                setProvider(next);
                setModalError(null);
                setModalTestResult(null);
                setRemoteTargets([]);
              }}
            />
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>连接名称</div>
            <Input
              aria-label="连接名称"
              maxLength={80}
              placeholder="例如：海外官方 Shopify 博客"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>站点地址</div>
            <Input
              aria-label="站点地址"
              placeholder={providerSitePlaceholder(provider)}
              value={siteBaseUrl}
              onChange={(e) => setSiteBaseUrl(e.target.value)}
            />
            <div style={{ fontSize: 12, color: 'var(--gm-fg-3)', marginTop: 4 }}>
              {providerSiteHint(provider)}
            </div>
          </div>

          {/* Provider-Specific Credentials & Targets */}
          {provider === 'SHOPIFY' ? (
            <>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
                  Shopify Admin API Access Token
                </div>
                <Input.Password
                  aria-label="Shopify Access Token"
                  autoComplete="off"
                  placeholder={
                    editingConn ? '留空则保留现有加密凭据' : '例如：shpat_xxxxxxxxxxxxxxxx'
                  }
                  value={shopifyAccessToken}
                  onChange={(e) => setShopifyAccessToken(e.target.value)}
                />
              </div>

              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
                  目标 Blog（测试连接后自动拉取列表，也可手动填写 Blog ID）
                </div>
                {remoteTargets.length > 0 ? (
                  <Select
                    allowClear
                    aria-label="Shopify 目标 Blog 选择"
                    style={{ width: '100%', marginBottom: 8 }}
                    placeholder="选择要推送的 Shopify Blog"
                    value={blogId || undefined}
                    options={remoteTargets.map((t) => ({
                      value: t.id,
                      label: t.handle ? `${t.name} (${t.handle})` : t.name,
                    }))}
                    onChange={(next) => {
                      const nextId = typeof next === 'string' ? next : '';
                      setBlogId(nextId);
                      const matched = remoteTargets.find((t) => t.id === nextId);
                      setBlogHandle(matched?.handle ?? '');
                    }}
                  />
                ) : null}
                <Input
                  aria-label="Shopify Blog ID"
                  placeholder="可选，例如 gid://shopify/Blog/123456"
                  value={blogId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setBlogId(nextId);
                    const matched = remoteTargets.find((t) => t.id === nextId.trim());
                    setBlogHandle(matched?.handle ?? '');
                  }}
                />
              </div>
            </>
          ) : null}

          {provider === 'WORDPRESS' ? (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
                  gap: 10,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
                    WordPress 用户名
                  </div>
                  <Input
                    aria-label="WordPress 用户名"
                    autoComplete="off"
                    placeholder={editingConn ? '留空则保留现有加密凭据' : '例如：editor'}
                    value={wpUsername}
                    onChange={(e) => setWpUsername(e.target.value)}
                  />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
                    Application Password
                  </div>
                  <Input.Password
                    aria-label="WordPress Application Password"
                    autoComplete="off"
                    placeholder={editingConn ? '留空则保留现有加密凭据' : '输入应用专用密码'}
                    value={wpAppPassword}
                    onChange={(e) => setWpAppPassword(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
                  默认文章分类（测试连接后自动拉取 WordPress 分类）
                </div>
                <Select
                  mode="multiple"
                  allowClear
                  aria-label="WordPress 默认分类"
                  style={{ width: '100%' }}
                  placeholder="测试连接后选择分类"
                  value={categoryIds.map(String)}
                  options={[
                    ...remoteTargets.map((t) => ({
                      value: String(t.id),
                      label: t.handle ? `${t.name} (${t.handle})` : t.name,
                    })),
                    ...categoryIds
                      .filter((id) => !remoteTargets.some((t) => Number(t.id) === id))
                      .map((id) => ({ value: String(id), label: `分类 #${id}` })),
                  ]}
                  onChange={(vals: string[]) => {
                    const numeric = vals
                      .map((v) => Number(v))
                      .filter((n) => Number.isInteger(n) && n > 0);
                    setCategoryIds([...new Set(numeric)]);
                  }}
                />
              </div>
            </>
          ) : null}

          {provider === 'WEBFLOW' ? (
            <>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
                  Webflow Data API v2 Token
                </div>
                <Input.Password
                  aria-label="Webflow API Token"
                  autoComplete="off"
                  placeholder={editingConn ? '留空则保留现有加密凭据' : '输入 Webflow API Token'}
                  value={webflowApiToken}
                  onChange={(e) => setWebflowApiToken(e.target.value)}
                />
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
                  gap: 10,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
                    Webflow Site ID
                  </div>
                  {webflowSiteTargets.length > 0 ? (
                    <Select
                      allowClear
                      aria-label="Webflow Site 选择"
                      style={{ width: '100%', marginBottom: 6 }}
                      placeholder="选择 Webflow 站点"
                      value={siteId || undefined}
                      options={webflowSiteTargets.map((s) => ({
                        value: s.id,
                        label: s.handle ? `${s.name} (${s.handle})` : s.name,
                      }))}
                      onChange={(next) => {
                        const nextSiteId = typeof next === 'string' ? next : '';
                        setSiteId(nextSiteId);
                        setCollectionId('');
                        setCollectionSlug('');
                        if (editingConn && nextSiteId) {
                          void runModalTest(editingConn.id, 'WEBFLOW', {
                            siteId: nextSiteId,
                            collectionId: '',
                          });
                        }
                      }}
                    />
                  ) : null}
                  <Input
                    aria-label="Webflow Site ID"
                    placeholder="测试连接后自动获取，或手动填写"
                    value={siteId}
                    onChange={(e) => setSiteId(e.target.value)}
                  />
                </div>

                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
                    Webflow Collection ID
                  </div>
                  {webflowCollectionTargets.length > 0 ? (
                    <Select
                      allowClear
                      aria-label="Webflow Collection 选择"
                      style={{ width: '100%', marginBottom: 6 }}
                      placeholder="选择目标 CMS Collection"
                      value={collectionId || undefined}
                      options={webflowCollectionTargets.map((c) => ({
                        value: c.id,
                        label: c.handle ? `${c.name} (${c.handle})` : c.name,
                      }))}
                      onChange={(next) => {
                        const nextColId = typeof next === 'string' ? next : '';
                        setCollectionId(nextColId);
                        const matched = webflowCollectionTargets.find((c) => c.id === nextColId);
                        setCollectionSlug(
                          typeof matched?.meta?.collectionSlug === 'string'
                            ? matched.meta.collectionSlug
                            : (matched?.handle ?? ''),
                        );
                        if (editingConn && nextColId) {
                          void runModalTest(editingConn.id, 'WEBFLOW', {
                            siteId: siteId || undefined,
                            collectionId: nextColId,
                          });
                        }
                      }}
                    />
                  ) : null}
                  <Input
                    aria-label="Webflow Collection ID"
                    placeholder="发布时必填，测试连接后可下拉选择"
                    value={collectionId}
                    onChange={(e) => setCollectionId(e.target.value)}
                  />
                </div>
              </div>

              <div
                style={{
                  padding: 10,
                  borderRadius: 'var(--gm-radius-md)',
                  border: '1px solid var(--gm-line-1)',
                  background: 'var(--gm-bg-base)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gm-fg-1)' }}>
                  CMS 字段映射（fieldMap）
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))',
                    gap: 8,
                  }}
                >
                  {renderWebflowFieldControl('title', '标题字段（title）', 'name')}
                  {renderWebflowFieldControl('slug', '短链字段（slug）', 'slug')}
                  {renderWebflowFieldControl('bodyHtml', '正文字段（bodyHtml）', 'post-body')}
                  {renderWebflowFieldControl(
                    'metaDesc',
                    '摘要字段（metaDesc）',
                    'meta-description',
                  )}
                  {renderWebflowFieldControl('jsonLd', 'JSON-LD 字段（可选）', '留空则内联正文')}
                </div>
              </div>
            </>
          ) : null}

          {provider === 'WEBHOOK' ? (
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
                Webhook 签名密钥（HMAC-SHA256，至少 8 位）
              </div>
              <Input.Password
                aria-label="Webhook 签名密钥"
                autoComplete="off"
                placeholder={editingConn ? '留空则保留现有加密凭据' : '点击下方随机生成或手动输入'}
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
              />
              <Space wrap size={8} style={{ marginTop: 8 }}>
                <Button
                  size="small"
                  data-testid="webhook-generate-secret-btn"
                  style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                  onClick={() => {
                    const nextSecret = generateSecureWebhookSecret();
                    setWebhookSecret(nextSecret);
                    feedback.notifySuccess('已生成 32 位随机签名密钥，请在保存前复制妥善保管');
                  }}
                >
                  随机生成密钥
                </Button>
                <Button
                  size="small"
                  data-testid="webhook-copy-secret-btn"
                  disabled={!webhookSecret.trim()}
                  style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                  onClick={() => {
                    void copyTextToClipboard(webhookSecret.trim()).then((ok) => {
                      if (ok) feedback.notifySuccess('已复制签名密钥到剪贴板');
                      else feedback.notifyError('复制失败，请手动复制');
                    });
                  }}
                >
                  复制密钥
                </Button>
              </Space>
            </div>
          ) : null}

          {/* Common Delivery Toggles & Optional IndexNow */}
          <div
            style={{
              padding: 10,
              borderRadius: 'var(--gm-radius-md)',
              border: '1px solid var(--gm-line-1)',
              background: 'var(--gm-bg-base)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <div>
                <div style={{ fontSize: 13, color: 'var(--gm-fg-1)' }}>默认推送为草稿（推荐）</div>
                <div style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
                  开启后在写作台默认以草稿态推送至后台，审核无误后再正式上线。
                </div>
              </div>
              <Switch
                aria-label="默认推送为草稿"
                checked={defaultPublishAsDraft}
                onChange={setDefaultPublishAsDraft}
              />
            </div>

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <div>
                <div style={{ fontSize: 13, color: 'var(--gm-fg-1)' }}>
                  {provider === 'WORDPRESS'
                    ? '内联注入 Gutenberg JSON-LD 区块'
                    : '内联注入 JSON-LD 结构化数据'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
                  自动附带 Article / FAQPage / Product Schema，提升 AI 搜索引擎解析率。
                </div>
              </div>
              <Switch
                aria-label="内联注入 JSON-LD"
                checked={inlineJsonLd}
                onChange={setInlineJsonLd}
              />
            </div>

            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginBottom: 4 }}>
                IndexNow Key（可选，8–128 位；正式上线后自动通知 Bing / Yandex 收录）
              </div>
              <Input
                aria-label="IndexNow Key"
                maxLength={128}
                placeholder="留空则跳过 IndexNow 提交"
                value={indexNowKey}
                onChange={(e) => setIndexNowKey(e.target.value)}
              />
            </div>
          </div>
        </div>
      </Modal>
    </section>
  );
}
